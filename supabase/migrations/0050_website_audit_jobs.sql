-- Direct-site checks run only in a separately enabled Node worker with a pinned
-- socket transport. A search miss or one failed request never proves a gap.
create table public.website_audit_jobs (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 official_url text not null,
 host_key text not null,
 approved_hosts text[] not null,
 permission_reference text not null,
 state text not null default 'queued' check(state in ('queued','leased','completed','review_required','failed')),
 requested_by uuid not null references auth.users(id),
 requested_at timestamptz not null default now(),
 lease_until timestamptz,
 completed_at timestamptz,
 error_code text,
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 check(length(permission_reference) between 15 and 500),
 check(cardinality(approved_hosts) between 1 and 4)
);
create unique index website_audit_one_pending on public.website_audit_jobs(org_id,lead_id)
 where state in ('queued','leased');
create index website_audit_queue on public.website_audit_jobs(requested_at) where state='queued';

-- A database row lock serializes host leases even when multiple Node workers
-- run concurrently. The cooldown is reserved before any network request.
create table private.website_audit_host_slots (
 host_key text primary key,
 next_allowed_at timestamptz not null default now()
);
revoke all on private.website_audit_host_slots from public,anon,authenticated;

create table public.website_audit_observations (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 job_id uuid not null unique references public.website_audit_jobs(id) on delete cascade,
 checked_url text not null,
 outcome text not null check(outcome in ('ok','http_5xx','not_found','review_required')),
 http_status integer,
 objective jsonb not null default '{}'::jsonb check(jsonb_typeof(objective)='object'),
 checked_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 check(http_status is null or http_status between 100 and 599)
);
create index website_audit_observations_lead on public.website_audit_observations(org_id,lead_id,checked_at desc);
alter table public.website_audit_jobs enable row level security;
alter table public.website_audit_observations enable row level security;
create policy website_audit_jobs_read on public.website_audit_jobs for select to authenticated using(private.is_org_admin(org_id));
create policy website_audit_observations_read on public.website_audit_observations for select to authenticated using(private.is_org_member(org_id));
revoke all on public.website_audit_jobs,public.website_audit_observations from public,anon,authenticated;
grant select on public.website_audit_jobs,public.website_audit_observations to authenticated;
grant all on public.website_audit_jobs,public.website_audit_observations to service_role;

create function public.request_website_audit(p_org uuid,p_lead uuid,p_permission_reference text,p_approved_hosts text[])
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.leads; result uuid; official_host text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into target from public.leads where org_id=p_org and id=p_lead and not is_demo;
 if not found or target.website_url is null then raise exception 'OFFICIAL_WEBSITE_REQUIRED'; end if;
 if target.website_url !~ '^https?://[^ /]+' or target.website_url ~ '[#@?]'
  or length(trim(coalesce(p_permission_reference,''))) not between 15 and 500
  or coalesce(cardinality(p_approved_hosts),0) not between 1 and 4
  then raise exception 'INVALID_AUDIT_REQUEST'; end if;
 official_host:=lower(substring(target.website_url from '^https?://([^/:?]+)'));
 if official_host is null or official_host<>all(p_approved_hosts)
  or exists(select 1 from unnest(p_approved_hosts) h where h is null or h<>lower(h)
    or h !~ '^[a-z0-9.-]+$' or length(h)>253 or h like '%.local' or h like '%.internal')
  then raise exception 'INVALID_APPROVED_HOSTS'; end if;
 insert into public.website_audit_jobs(org_id,lead_id,official_url,host_key,approved_hosts,permission_reference,requested_by)
 values(p_org,p_lead,target.website_url,official_host,p_approved_hosts,trim(p_permission_reference),auth.uid())
 returning id into result;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'website_audit_requested','website_audit_jobs',result,jsonb_build_object('lead_id',p_lead));
 return result;
end $$;
revoke execute on function public.request_website_audit(uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.request_website_audit(uuid,uuid,text,text[]) to authenticated;

create function public.lease_website_audit_job() returns public.website_audit_jobs
language plpgsql security definer set search_path='' as $$
declare selected public.website_audit_jobs; slot timestamptz;
begin
 for selected in select * from public.website_audit_jobs where state='queued'
  order by requested_at,id for update skip locked loop
  insert into private.website_audit_host_slots(host_key) values(selected.host_key)
   on conflict do nothing;
  select next_allowed_at into slot from private.website_audit_host_slots
   where host_key=selected.host_key for update skip locked;
  if not found or slot>now() then continue; end if;
  update private.website_audit_host_slots set next_allowed_at=now()+interval '10 seconds'
   where host_key=selected.host_key;
  update public.website_audit_jobs set state='leased',lease_until=now()+interval '2 minutes'
   where id=selected.id returning * into selected;
  return selected;
 end loop;
 return null;
end $$;
revoke execute on function public.lease_website_audit_job() from public,anon,authenticated;
grant execute on function public.lease_website_audit_job() to service_role;

create function public.finish_website_audit_job(p_job uuid,p_outcome text,p_checked_url text,p_http_status integer,p_objective jsonb,p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
declare job public.website_audit_jobs;
begin
 select * into job from public.website_audit_jobs where id=p_job for update;
 if not found or job.state<>'leased' or job.lease_until<now() then raise exception 'AUDIT_LEASE_REQUIRED'; end if;
 if p_outcome not in ('ok','http_5xx','not_found','review_required')
  or p_checked_url is distinct from job.official_url
  or (p_outcome in ('ok','http_5xx','not_found') and p_http_status is null)
  or (p_outcome='ok' and p_http_status not between 200 and 299)
  or (p_outcome='http_5xx' and p_http_status not between 500 and 599)
  or (p_outcome='not_found' and p_http_status not in (404,410))
  or p_objective is null or jsonb_typeof(p_objective)<>'object'
  or length(coalesce(p_error_code,''))>80 then raise exception 'INVALID_AUDIT_RESULT'; end if;
 insert into public.website_audit_observations(org_id,lead_id,job_id,checked_url,outcome,http_status,objective)
 values(job.org_id,job.lead_id,p_job,p_checked_url,p_outcome,p_http_status,p_objective);
 update public.website_audit_jobs set state=case when p_outcome='review_required' then 'review_required' else 'completed' end,
  error_code=p_error_code,completed_at=now(),lease_until=null where id=p_job;
end $$;
revoke execute on function public.finish_website_audit_job(uuid,text,text,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_website_audit_job(uuid,text,text,integer,jsonb,text) to service_role;

-- A human can turn a bounded transport observation into factual evidence.
-- The reviewer cannot edit the factual claim or promote a policy/network error.
create function public.review_website_audit_observation(p_org uuid,p_observation uuid,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare observation public.website_audit_observations; existing uuid; result uuid; claim text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into observation from public.website_audit_observations
  where org_id=p_org and id=p_observation for update;
 if not found or observation.checked_at<now()-interval '30 days'
  or observation.outcome not in ('ok','http_5xx','not_found')
  or length(trim(coalesce(p_note,''))) not between 20 and 500
  then raise exception 'AUDIT_OBSERVATION_REVIEW_REQUIRED'; end if;
 select id into existing from public.lead_evidence where org_id=p_org and lead_id=observation.lead_id
  and source_type='website_audit' and source_url=observation.checked_url
  and observed_at=observation.checked_at;
 if existing is not null then return existing; end if;
 claim:='Pinned public website check on '||to_char(observation.checked_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||
  ' UTC returned HTTP '||observation.http_status::text||' for '||observation.checked_url||'.';
 insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence,reviewed_by,review_note,kind)
 values(p_org,observation.lead_id,'website_audit',observation.checked_url,observation.checked_at,claim,
  case when observation.outcome='ok' then 0.85 else 0.8 end,auth.uid(),trim(p_note),'observation') returning id into result;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'website_audit_observation_reviewed','lead_evidence',result,
  jsonb_build_object('observation_id',p_observation,'lead_id',observation.lead_id));
 return result;
end $$;
revoke execute on function public.review_website_audit_observation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.review_website_audit_observation(uuid,uuid,text) to authenticated;

-- Never replay an expired external check automatically. The owner must inspect
-- the uncertain lease and explicitly close it before requesting a fresh check.
create function public.close_expired_website_audit_job(p_org uuid,p_job uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare job public.website_audit_jobs;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into job from public.website_audit_jobs where org_id=p_org and id=p_job for update;
 if not found or job.state<>'leased' or job.lease_until>=now()
  or length(trim(coalesce(p_reason,''))) not between 20 and 500
  then raise exception 'EXPIRED_AUDIT_REVIEW_REQUIRED'; end if;
 update public.website_audit_jobs set state='failed',lease_until=null,completed_at=now(),
  error_code='LEASE_EXPIRED_MANUAL_REVIEW' where id=p_job;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'website_audit_expired_closed','website_audit_jobs',p_job,
  jsonb_build_object('lead_id',job.lead_id,'reason',trim(p_reason)));
end $$;
revoke execute on function public.close_expired_website_audit_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.close_expired_website_audit_job(uuid,uuid,text) to authenticated;
