-- A provider observation enters the existing CRM only through this service-only intake.
-- Ambiguous identity is held for review; contacts and consent are never merged here.
create table public.discovery_candidates (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 discovery_run_id uuid not null,
 source text not null check(source in ('serper','harvey')),
 actual_provider text not null,
 provider_record_id text,
 business_name text not null,
 website_url text,
 city text,
 state_region text,
 country text,
 source_url text not null,
 observed_at timestamptz not null,
 possible_lead_ids uuid[] not null default '{}',
 reason text not null,
 state text not null default 'review_needed' check(state in ('review_needed','resolved','discarded')),
 resolved_lead_id uuid,
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(org_id,discovery_run_id) references public.discovery_runs(org_id,id),
 foreign key(org_id,resolved_lead_id) references public.leads(org_id,id)
);
create index discovery_candidates_review on public.discovery_candidates(org_id,state,created_at desc);
alter table public.discovery_candidates enable row level security;
create policy discovery_candidates_read on public.discovery_candidates for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.discovery_candidates from public,anon,authenticated;
grant select on public.discovery_candidates to authenticated;
grant all on public.discovery_candidates to service_role;

create function public.ingest_discovered_business(p_org uuid,p_run uuid,p_source text,p_provider text,p_name text,p_website text,p_city text,p_state text,p_country text,p_source_url text,p_provider_record_id text,p_observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs; target public.discovery_targeting; clean_name text; clean_domain text;
 candidates uuid[]; candidate_id uuid; lead_id uuid; exact_count integer; new_count integer;
begin
 if p_source not in ('serper','harvey') or p_provider<>(case when p_source='serper' then 'serper' else 'harvey_osm' end)
  or length(trim(coalesce(p_name,''))) not between 2 and 160 or length(coalesce(p_source_url,'')) not between 12 and 2000
  or p_source_url !~ '^https://[^ /]+' or p_observed_at is null or p_observed_at>now()+interval '5 minutes'
  or p_observed_at<now()-interval '30 days' or length(coalesce(p_provider_record_id,''))>300
  or length(coalesce(p_website,''))>2000 or (p_website is not null and p_website !~ '^https://[^ /]+')
  or length(coalesce(p_city,''))>120 or length(coalesce(p_state,''))>120 or length(coalesce(p_country,''))>120 then
  raise exception 'INVALID_DISCOVERY_OBSERVATION'; end if;
 select * into run from public.discovery_runs where org_id=p_org and id=p_run and provider=p_source and state='leased' for update;
 if not found then raise exception 'DISCOVERY_RUN_NOT_ACTIVE'; end if;
 select * into target from public.discovery_targeting where org_id=p_org;
 if not found or target.max_new_prospects=0 or (p_source='serper' and not target.serper_discovery_enabled)
  or (p_source='harvey' and not target.harvey_discovery_enabled) then raise exception 'DISCOVERY_DISABLED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,32));
 clean_name:=lower(trim(regexp_replace(p_name,'\s+',' ','g')));
 clean_domain:=nullif(lower(regexp_replace(split_part(regexp_replace(coalesce(p_website,''),'^https://',''),'/',1),'^www\.','')),'');
 if clean_domain is not null and (clean_domain !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' or clean_domain ~ '(^|\.)(localhost|local|internal)$') then
  raise exception 'INVALID_DISCOVERY_DOMAIN'; end if;
 if p_provider_record_id is not null then
  select s.lead_id into lead_id from public.lead_discovery_sources s where s.org_id=p_org and s.source=p_source and s.provider_record_id=p_provider_record_id;
  if found then return jsonb_build_object('state','already_recorded','lead_id',lead_id); end if;
 end if;
 select array_agg(id order by id) into candidates from public.leads where org_id=p_org and not is_demo and
  ((clean_domain is not null and normalized_domain=clean_domain) or
   lower(trim(regexp_replace(business_name,'\s+',' ','g')))=clean_name);
 candidates:=coalesce(candidates,'{}');
 select count(*) into exact_count from public.leads where org_id=p_org and id=any(candidates) and not is_demo
  and lower(trim(regexp_replace(business_name,'\s+',' ','g')))=clean_name
  and lower(coalesce(city,''))=lower(coalesce(p_city,''))
  and (clean_domain is null or normalized_domain is null or normalized_domain=clean_domain)
  and (p_state is null or state_region is null or lower(state_region)=lower(p_state))
  and (p_country is null or country is null or lower(country)=lower(p_country));
 if cardinality(candidates)>1 or (cardinality(candidates)=1 and exact_count<>1) then
  insert into public.discovery_candidates(org_id,discovery_run_id,source,actual_provider,provider_record_id,business_name,website_url,city,state_region,country,source_url,observed_at,possible_lead_ids,reason)
  values(p_org,p_run,p_source,p_provider,p_provider_record_id,trim(p_name),p_website,p_city,p_state,p_country,p_source_url,p_observed_at,candidates,'Identity conflicts with an existing business or has multiple possible matches')
  returning id into candidate_id;
  return jsonb_build_object('state','review_needed','candidate_id',candidate_id);
 end if;
 if cardinality(candidates)=1 then lead_id:=candidates[1];
 else
  select count(*) into new_count from public.lead_discovery_sources s where s.org_id=p_org and s.discovery_run_id=p_run and s.lead_id in
   (select id from public.leads where org_id=p_org and source_type=p_source and created_at>=run.created_at);
  if new_count>=least(run.requested_limit,target.max_new_prospects) then raise exception 'DISCOVERY_RUN_LEAD_CAP'; end if;
  insert into public.leads(org_id,business_name,website_url,normalized_domain,source_type,source_url,source_observed_at,city,state_region,country,is_demo)
  values(p_org,trim(p_name),p_website,clean_domain,p_source,p_source_url,p_observed_at,p_city,p_state,p_country,false) returning id into lead_id;
 end if;
 insert into public.lead_discovery_sources(org_id,lead_id,discovery_run_id,source,actual_provider,provider_record_id,source_url,observed_at)
 values(p_org,lead_id,p_run,p_source,p_provider,p_provider_record_id,p_source_url,p_observed_at);
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context)
 values(p_org,'discovery_observation_ingested','leads',lead_id,jsonb_build_object('source',p_source,'run_id',p_run));
 return jsonb_build_object('state',case when cardinality(candidates)=1 then 'matched' else 'created' end,'lead_id',lead_id);
end $$;
revoke execute on function public.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz) to service_role;

create function public.resolve_discovery_candidate(p_org uuid,p_candidate uuid,p_action text,p_lead uuid default null)
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
  insert into public.lead_discovery_sources(org_id,lead_id,discovery_run_id,source,actual_provider,provider_record_id,source_url,observed_at)
  values(p_org,p_lead,candidate.discovery_run_id,candidate.source,candidate.actual_provider,candidate.provider_record_id,candidate.source_url,candidate.observed_at)
  on conflict do nothing;
 end if;
 update public.discovery_candidates set state=case when p_action='merge' then 'resolved' else 'discarded' end,
  resolved_lead_id=case when p_action='merge' then p_lead else null end,reviewed_by=auth.uid(),reviewed_at=now()
 where id=p_candidate;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'discovery_candidate_'||p_action,'discovery_candidates',p_candidate,jsonb_build_object('lead_id',p_lead));
end $$;
revoke execute on function public.resolve_discovery_candidate(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.resolve_discovery_candidate(uuid,uuid,text,uuid) to authenticated;
