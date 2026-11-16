-- Independently search the confirmed official site for public contact pages.
-- Defaults and worker flags keep all provider requests off until approved.
alter table public.discovery_targeting add column vibe_contact_discovery_enabled boolean not null default false;

create table public.vibe_contact_discovery_jobs (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 target_url text not null,
 source_kind text not null check(source_kind in ('official','listing')),
 state text not null default 'queued' check(state in ('queued','leased','completed','failed')),
 reserved_credits smallint not null default 0 check(reserved_credits in (0,21)),
 observations_count smallint not null default 0 check(observations_count between 0 and 20),
 requested_by uuid not null references auth.users(id),
 requested_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 completed_at timestamptz,
 error_code text,
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 check(target_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$')
);
create unique index vibe_contact_discovery_one_active on public.vibe_contact_discovery_jobs(org_id,lead_id)
 where state in ('queued','leased');
create index vibe_contact_discovery_queue on public.vibe_contact_discovery_jobs(requested_at)
 where state='queued';
alter table public.vibe_contact_discovery_jobs enable row level security;
create policy vibe_contact_discovery_admin_read on public.vibe_contact_discovery_jobs for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.vibe_contact_discovery_jobs from public,anon,authenticated;
grant select on public.vibe_contact_discovery_jobs to authenticated;
grant all on public.vibe_contact_discovery_jobs to service_role;

create function public.request_vibe_contact_discovery(p_org uuid,p_lead uuid,p_force boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.leads; org public.organizations; setting public.discovery_targeting;
 assessment public.lead_website_assessments; previous uuid; result uuid; used integer;
 chosen_url text; chosen_kind text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into target from public.leads where org_id=p_org and id=p_lead and not is_demo;
 if not found then raise exception 'CONTACT_LEAD_NOT_FOUND'; end if;
 select * into org from public.organizations where id=p_org;
 select * into setting from public.discovery_targeting where org_id=p_org;
 if org.research_provider<>'serper' or org.research_monthly_credit_cap=0
  or setting.org_id is null or not setting.vibe_contact_discovery_enabled
  then raise exception 'VIBE_CONTACT_DISCOVERY_DISABLED'; end if;
 if target.website_url is not null then
  if target.website_url !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   then raise exception 'CONFIRMED_OFFICIAL_WEBSITE_REQUIRED'; end if;
  select * into assessment from public.lead_website_assessments where org_id=p_org and lead_id=p_lead
   order by observed_at desc,id desc limit 1;
  if assessment.id is null or assessment.official_url is distinct from target.website_url
   or assessment.status not in ('WORKING','VERIFIED_TECHNICAL_PROBLEM')
   then raise exception 'REVIEWED_OFFICIAL_WEBSITE_REQUIRED'; end if;
  chosen_url:=target.website_url; chosen_kind:='official';
 else
  select e.source_url into chosen_url from public.lead_evidence e where e.org_id=p_org and e.lead_id=p_lead
   and e.reviewed_by is not null and e.rejected_by is null and e.source_type='serper'
   and e.observed_at>now()-interval '30 days'
   and position(lower(target.business_name) in lower(e.claim))>0
   and position(lower(coalesce(target.city,'')) in lower(e.claim))>0
   and e.source_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   order by e.observed_at desc,e.id desc limit 1;
  if chosen_url is null or target.city is null or length(trim(target.city))<2
   then raise exception 'REVIEWED_LISTING_REQUIRED'; end if;
  chosen_kind:='listing';
 end if;
 select id into previous from public.vibe_contact_discovery_jobs where org_id=p_org and lead_id=p_lead
  and state in ('queued','leased') order by requested_at desc limit 1;
 if previous is not null then return previous; end if;
 if not coalesce(p_force,false) then
  select id into previous from public.vibe_contact_discovery_jobs where org_id=p_org and lead_id=p_lead
   and target_url=chosen_url and source_kind=chosen_kind and state='completed' and completed_at>now()-interval '14 days'
   order by completed_at desc limit 1;
  if previous is not null then return previous; end if;
 end if;
 select coalesce(reserved_credits,0) into used from public.research_credit_usage
  where org_id=p_org and provider='serper' and month_start=date_trunc('month',now() at time zone 'UTC')::date;
 if coalesce(used,0)+21>org.research_monthly_credit_cap then raise exception 'VIBE_CONTACT_CREDIT_CAP'; end if;
 insert into public.vibe_contact_discovery_jobs(org_id,lead_id,target_url,source_kind,requested_by)
 values(p_org,p_lead,chosen_url,chosen_kind,auth.uid()) returning id into result;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'vibe_contact_discovery_requested','vibe_contact_discovery_jobs',result);
 return result;
end $$;

create function public.lease_vibe_contact_discovery_job() returns public.vibe_contact_discovery_jobs
language plpgsql security definer set search_path='' as $$
declare selected public.vibe_contact_discovery_jobs;
begin
 update public.vibe_contact_discovery_jobs set state='failed',error_code='LEASE_EXPIRED_REVIEW_REQUIRED',
  lease_token=null,lease_until=null,completed_at=now()
  where state='leased' and lease_until<now();
 select j.* into selected from public.vibe_contact_discovery_jobs j
 join public.discovery_targeting t on t.org_id=j.org_id
 join public.organizations o on o.id=j.org_id
 join public.leads l on l.org_id=j.org_id and l.id=j.lead_id
 left join lateral (select a.status,a.official_url from public.lead_website_assessments a
  where a.org_id=j.org_id and a.lead_id=j.lead_id
  order by a.observed_at desc,a.id desc limit 1) a on true
 where j.state='queued' and t.vibe_contact_discovery_enabled
  and o.research_provider='serper' and o.research_monthly_credit_cap>0
  and not l.is_demo and (
   (j.source_kind='official' and l.website_url=j.target_url
    and a.official_url=j.target_url and a.status in ('WORKING','VERIFIED_TECHNICAL_PROBLEM'))
   or (j.source_kind='listing' and l.website_url is null and l.city is not null
    and exists(select 1 from public.lead_evidence e where e.org_id=j.org_id and e.lead_id=j.lead_id
     and e.source_url=j.target_url and e.source_type='serper' and e.reviewed_by is not null
     and e.rejected_by is null and e.observed_at>now()-interval '30 days'
     and position(lower(l.business_name) in lower(e.claim))>0
     and position(lower(l.city) in lower(e.claim))>0)) )
 order by j.requested_at,j.id for update of j skip locked limit 1;
 if selected.id is null then return null; end if;
 update public.vibe_contact_discovery_jobs set state='leased',lease_token=gen_random_uuid(),
  lease_until=now()+interval '3 minutes' where id=selected.id returning * into selected;
 return selected;
end $$;

create function public.reserve_vibe_contact_discovery_credits(p_job uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.vibe_contact_discovery_jobs; org public.organizations; current_used integer; month date;
begin
 select * into job from public.vibe_contact_discovery_jobs where id=p_job and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'VIBE_CONTACT_LEASE_INVALID'; end if;
 if job.reserved_credits=21 then return true; end if;
 select * into org from public.organizations where id=job.org_id for update;
 if org.research_provider<>'serper' or not exists(select 1 from public.discovery_targeting
  where org_id=job.org_id and vibe_contact_discovery_enabled) then return false; end if;
 month:=date_trunc('month',now() at time zone 'UTC')::date;
 insert into public.research_credit_usage(org_id,provider,month_start) values(job.org_id,'serper',month) on conflict do nothing;
 select reserved_credits into current_used from public.research_credit_usage
  where org_id=job.org_id and provider='serper' and month_start=month for update;
 if org.research_monthly_credit_cap=0 or current_used+21>org.research_monthly_credit_cap then return false; end if;
 update public.research_credit_usage set reserved_credits=reserved_credits+21
  where org_id=job.org_id and provider='serper' and month_start=month;
 update public.vibe_contact_discovery_jobs set reserved_credits=21 where id=p_job;
 return true;
end $$;

create function public.finish_vibe_contact_discovery_job(p_job uuid,p_token uuid,p_observations jsonb,p_error text default null)
returns integer language plpgsql security definer set search_path='' as $$
declare job public.vibe_contact_discovery_jobs; target public.leads; assessment public.lead_website_assessments;
 count_saved integer:=0; item jsonb;
begin
 select * into job from public.vibe_contact_discovery_jobs where id=p_job and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'VIBE_CONTACT_LEASE_INVALID'; end if;
 if p_error is not null then
  if length(p_error)>80 then raise exception 'INVALID_VIBE_CONTACT_ERROR'; end if;
  update public.vibe_contact_discovery_jobs set state='failed',error_code=p_error,
   lease_token=null,lease_until=null,completed_at=now() where id=p_job;
  return 0;
 end if;
 if job.reserved_credits<>21 or jsonb_typeof(p_observations)<>'array'
  or jsonb_array_length(p_observations)>20 then raise exception 'INVALID_VIBE_CONTACT_RESULT'; end if;
 select * into target from public.leads where org_id=job.org_id and id=job.lead_id for update;
 select * into assessment from public.lead_website_assessments where org_id=job.org_id and lead_id=job.lead_id
  order by observed_at desc,id desc limit 1;
 if target.is_demo or (job.source_kind='official' and
  (target.website_url is distinct from job.target_url or assessment.official_url is distinct from job.target_url
   or assessment.status not in ('WORKING','VERIFIED_TECHNICAL_PROBLEM')))
  or (job.source_kind='listing' and (target.website_url is not null or target.city is null
   or not exists(select 1 from public.lead_evidence e where e.org_id=job.org_id and e.lead_id=job.lead_id
    and e.source_url=job.target_url and e.source_type='serper' and e.reviewed_by is not null
    and e.rejected_by is null and e.observed_at>now()-interval '30 days'
    and position(lower(target.business_name) in lower(e.claim))>0
    and position(lower(target.city) in lower(e.claim))>0)))
  then raise exception 'CONTACT_SOURCE_CHANGED'; end if;
 if job.source_kind='listing' and exists(select 1 from jsonb_array_elements(p_observations) obs(value)
  where obs.value->>'source_url' is distinct from job.target_url)
  then raise exception 'LISTING_SOURCE_MISMATCH'; end if;
 if jsonb_array_length(p_observations)>0 then
  count_saved:=public.record_vibe_contact_observations(job.org_id,job.lead_id,'vibe',p_observations);
  -- Enrich an already-seen address only while it is still pending review.
  -- The evidence validator above requires the exact name, role and address
  -- together in the same excerpt before this update can run.
  for item in select value from jsonb_array_elements(p_observations) loop
   if item->>'kind'='email' and item->>'contact_name' is not null and item->>'role' is not null then
    update public.vibe_contact_points set
     contact_name=coalesce(contact_name,item->>'contact_name'),
     role=coalesce(role,item->>'role')
     where org_id=job.org_id and lead_id=job.lead_id and kind='email'
      and normalized_value=lower(item->>'value') and review_status='pending';
   end if;
  end loop;
 end if;
 update public.vibe_contact_discovery_jobs set state='completed',observations_count=count_saved,
  lease_token=null,lease_until=null,completed_at=now() where id=p_job;
 return count_saved;
end $$;

revoke execute on function public.request_vibe_contact_discovery(uuid,uuid,boolean),
 public.lease_vibe_contact_discovery_job(),public.reserve_vibe_contact_discovery_credits(uuid,uuid),
 public.finish_vibe_contact_discovery_job(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.request_vibe_contact_discovery(uuid,uuid,boolean) to authenticated;
grant execute on function public.lease_vibe_contact_discovery_job(),
 public.reserve_vibe_contact_discovery_credits(uuid,uuid),
 public.finish_vibe_contact_discovery_job(uuid,uuid,jsonb,text) to service_role;
