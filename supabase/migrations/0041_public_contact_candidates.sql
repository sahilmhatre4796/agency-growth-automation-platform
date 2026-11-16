-- Public addresses found on a reviewed business site are suggestions, not
-- verified contacts or permission to email.
alter table public.business_research_reports add column contact_candidates jsonb not null default '[]'::jsonb
 check(jsonb_typeof(contact_candidates)='array' and jsonb_array_length(contact_candidates)<=3);

alter function public.finish_business_research_job(uuid,uuid,jsonb) set schema private;
revoke all on function private.finish_business_research_job(uuid,uuid,jsonb) from public,anon,authenticated;

create function public.finish_business_research_job(p_job uuid,p_token uuid,p_report jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare item jsonb; rid uuid; source_host text; email_domain text; website_url text;
begin
 if p_report ? 'contact_candidates' and
  (jsonb_typeof(p_report->'contact_candidates')<>'array' or jsonb_array_length(p_report->'contact_candidates')>3)
  then raise exception 'INVALID_CONTACT_CANDIDATES'; end if;
 website_url:=p_report->'website'->>'url';
 for item in select value from jsonb_array_elements(coalesce(p_report->'contact_candidates','[]'::jsonb)) loop
  source_host:=lower(split_part(split_part(item->>'source_url','/',3),':',1));
  email_domain:=lower(split_part(item->>'email','@',2));
  if website_url is null or item->>'source_url'<>website_url
   or item->>'source_url' !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or lower(item->>'email') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
   or email_domain<>regexp_replace(source_host,'^www\.','')
   or (item->>'confidence')::numeric not between 0 and 1
   or (item->>'observed_at')::timestamptz not between now()-interval '30 days' and now()+interval '1 hour'
   then raise exception 'INVALID_CONTACT_CANDIDATES'; end if;
 end loop;
 rid:=private.finish_business_research_job(p_job,p_token,p_report);
 if rid is not null then
  update public.business_research_reports
   set contact_candidates=coalesce(p_report->'contact_candidates','[]'::jsonb) where id=rid;
 end if;
 return rid;
end $$;
revoke execute on function public.finish_business_research_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_business_research_job(uuid,uuid,jsonb) to service_role;

create function public.approve_public_contact_candidate(p_org uuid,p_report uuid,p_email text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; item jsonb; cid uuid; normalized text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into report from public.business_research_reports
  where org_id=p_org and id=p_report and expires_at>now() for update;
 if not found then raise exception 'RESEARCH_REPORT_NOT_FOUND'; end if;
 if length(trim(coalesce(p_note,''))) not between 20 and 500 then raise exception 'CONTACT_REVIEW_NOTE_REQUIRED'; end if;
 if not exists(select 1 from public.leads l where l.org_id=p_org and l.id=report.lead_id
  and not l.is_demo and private.research_snapshot(l)=report.source_snapshot)
  then raise exception 'LEAD_CHANGED'; end if;
 normalized:=lower(trim(p_email));
 select value into item from jsonb_array_elements(report.contact_candidates)
  where lower(value->>'email')=normalized limit 1;
 if item is null then raise exception 'CONTACT_CANDIDATE_NOT_FOUND'; end if;
 if not exists(select 1 from public.lead_evidence e where e.org_id=p_org and e.lead_id=report.lead_id
  and e.source_url=item->>'source_url' and e.reviewed_by is not null and e.rejected_by is null
  and e.source_type=report.provider||'_website' and e.observed_at>now()-interval '30 days')
  then raise exception 'REVIEWED_WEBSITE_EVIDENCE_REQUIRED'; end if;
 if exists(select 1 from public.contacts c where c.org_id=p_org and c.email_normalized=normalized and c.lead_id<>report.lead_id)
  then raise exception 'CONTACT_OWNERSHIP_CONFLICT'; end if;
 select id into cid from public.contacts where org_id=p_org and lead_id=report.lead_id and email_normalized=normalized limit 1;
 if cid is null then
  insert into public.contacts(org_id,lead_id,email,email_normalized,source_url)
   values(p_org,report.lead_id,normalized,normalized,item->>'source_url') returning id into cid;
 end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
  values(p_org,auth.uid(),'public_contact_candidate_approved','contacts',cid,
   jsonb_build_object('report_id',p_report,'review_note',trim(p_note)));
 return cid;
end $$;
revoke execute on function public.approve_public_contact_candidate(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.approve_public_contact_candidate(uuid,uuid,text,text) to authenticated;

-- The same owner review action must cover a readable website observation before
-- an address from that page can be promoted to CRM.
create or replace function public.review_discovery_evidence(
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
   'serper_competitor','tavily_competitor','serper_website','tavily_website') for update;
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
