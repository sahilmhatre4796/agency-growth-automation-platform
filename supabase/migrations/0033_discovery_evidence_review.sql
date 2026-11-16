-- Keep a Serper observation and its supporting excerpt in one transaction.
-- Neither the observed page nor the target category certifies an official site or service gap.
alter table public.discovery_candidates
 add column proposed_category text,
 add column evidence_quote text,
 add column evidence_url text;
alter table public.lead_discovery_sources add column proposed_category text;
alter table public.lead_evidence
 add column rejected_by uuid references auth.users(id),
 add column rejected_at timestamptz,
 add column review_note text;
alter table public.lead_evidence add constraint evidence_review_exclusive
 check(rejected_by is null or reviewed_by is null);

create function public.ingest_serper_observation(
 p_org uuid,p_run uuid,p_name text,p_city text,p_country text,p_source_url text,
 p_observed_at timestamptz,p_category text,p_evidence_quote text,p_evidence_url text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; candidate_id uuid; saved_lead_id uuid;
begin
 if length(trim(coalesce(p_category,''))) not between 3 and 80
  or length(trim(coalesce(p_evidence_quote,''))) not between 15 and 500
  or length(coalesce(p_evidence_url,'')) not between 12 and 2000
  or p_evidence_url !~ '^https://[^ /]+'
  then raise exception 'INVALID_DISCOVERY_EVIDENCE'; end if;
 result:=public.ingest_discovered_business(p_org,p_run,'serper','serper',p_name,null,
  p_city,null,p_country,p_source_url,null,p_observed_at);
 if result->>'state'='review_needed' then
  candidate_id:=(result->>'candidate_id')::uuid;
  update public.discovery_candidates set proposed_category=trim(p_category),
   evidence_quote=trim(p_evidence_quote),evidence_url=p_evidence_url
   where id=candidate_id and org_id=p_org;
 elsif result->>'state'<>'already_recorded' then
  saved_lead_id:=(result->>'lead_id')::uuid;
  update public.lead_discovery_sources set proposed_category=trim(p_category)
   where org_id=p_org and lead_id=saved_lead_id and discovery_run_id=p_run and source='serper'
    and source_url=p_source_url;
  insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence)
  values(p_org,saved_lead_id,'serper',p_evidence_url,p_observed_at,trim(p_evidence_quote),0.5);
 end if;
 return result;
end $$;
revoke execute on function public.ingest_serper_observation(uuid,uuid,text,text,text,text,timestamptz,text,text,text)
 from public,anon,authenticated;
grant execute on function public.ingest_serper_observation(uuid,uuid,text,text,text,text,timestamptz,text,text,text)
 to service_role;

-- The reviewer must inspect the source and explain the decision. A search excerpt
-- can support a positive business fact but never alone proves a missing service.
create function public.review_discovery_evidence(
 p_org uuid,p_evidence uuid,p_decision text,p_confidence numeric,p_note text
) returns void language plpgsql security definer set search_path='' as $$
declare fact public.lead_evidence;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_decision not in ('approve','reject') or p_confidence not between 0 and 1
  or length(trim(coalesce(p_note,''))) not between 20 and 500 then
  raise exception 'INVALID_EVIDENCE_REVIEW'; end if;
 select * into fact from public.lead_evidence where org_id=p_org and id=p_evidence
  and source_type in ('serper','harvey','serper_business_fact','tavily_business_fact',
   'serper_competitor','tavily_competitor') for update;
 if not found or fact.reviewed_by is not null or fact.rejected_by is not null then
  raise exception 'EVIDENCE_NOT_PENDING'; end if;
 if fact.source_url !~ '^https://[^ /]+' or fact.observed_at<now()-interval '90 days' then
  raise exception 'EVIDENCE_SOURCE_NOT_CURRENT'; end if;
 update public.lead_evidence set confidence=p_confidence,
  reviewed_by=case when p_decision='approve' then auth.uid() else null end,
  rejected_by=case when p_decision='reject' then auth.uid() else null end,
  rejected_at=case when p_decision='reject' then now() else null end,
  review_note=trim(p_note) where id=p_evidence;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'discovery_evidence_'||p_decision,'lead_evidence',p_evidence,
  jsonb_build_object('lead_id',fact.lead_id));
end $$;
revoke execute on function public.review_discovery_evidence(uuid,uuid,text,numeric,text)
 from public,anon,authenticated;
grant execute on function public.review_discovery_evidence(uuid,uuid,text,numeric,text)
 to authenticated;

-- Preserve the excerpt when an ambiguous identity is linked after owner review.
create or replace function public.resolve_discovery_candidate(p_org uuid,p_candidate uuid,p_action text,p_lead uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare candidate public.discovery_candidates;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_action not in ('merge','discard') then raise exception 'INVALID_DISCOVERY_REVIEW'; end if;
 select * into candidate from public.discovery_candidates where org_id=p_org and id=p_candidate and state='review_needed' for update;
 if not found then raise exception 'DISCOVERY_CANDIDATE_NOT_PENDING'; end if;
 if p_action='merge' then
  if p_lead is null or not p_lead=any(candidate.possible_lead_ids) or
   not exists(select 1 from public.leads where org_id=p_org and id=p_lead and not is_demo) then
   raise exception 'DISCOVERY_LEAD_REVIEW_REQUIRED'; end if;
  if candidate.provider_record_id is not null and exists(select 1 from public.lead_discovery_sources
    where org_id=p_org and source=candidate.source and provider_record_id=candidate.provider_record_id and lead_id<>p_lead) then
   raise exception 'DISCOVERY_PROVIDER_ID_CONFLICT'; end if;
  insert into public.lead_discovery_sources(org_id,lead_id,discovery_run_id,source,actual_provider,provider_record_id,source_url,observed_at,proposed_category)
  values(p_org,p_lead,candidate.discovery_run_id,candidate.source,candidate.actual_provider,candidate.provider_record_id,candidate.source_url,candidate.observed_at,candidate.proposed_category)
  on conflict do nothing;
  if candidate.evidence_quote is not null and candidate.evidence_url is not null then
   insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence)
   values(p_org,p_lead,candidate.source,candidate.evidence_url,candidate.observed_at,candidate.evidence_quote,0.5);
  end if;
 end if;
 update public.discovery_candidates set state=case when p_action='merge' then 'resolved' else 'discarded' end,
  resolved_lead_id=case when p_action='merge' then p_lead else null end,reviewed_by=auth.uid(),reviewed_at=now()
 where id=p_candidate;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'discovery_candidate_'||p_action,'discovery_candidates',p_candidate,jsonb_build_object('lead_id',p_lead));
end $$;
