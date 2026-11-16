-- Search discovery is an owner-requested, credit-reserved batch. The Edge
-- worker has a separate OFF-by-default flag and never promotes a candidate URL
-- to an official website without a later human website review.
alter table public.discovery_runs
 add column target_industry text,
 add column target_city text,
 add column target_country text,
 add column lease_token uuid,
 add column lease_until timestamptz,
 add column next_run_at timestamptz not null default now(),
 add column reserved_credits smallint not null default 0 check(reserved_credits in (0,31)),
 add column last_error_code text,
 add column observations_count smallint not null default 0 check(observations_count between 0 and 3);
create unique index discovery_one_active_provider on public.discovery_runs(org_id,provider)
 where state in ('queued','leased');

create function public.request_serper_discovery(p_org uuid,p_industry text,p_city text,p_country text,p_limit integer default 3)
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.discovery_targeting; org public.organizations; run_id uuid; used integer;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_limit not between 1 and 3 or length(trim(coalesce(p_industry,''))) not between 3 and 80
  or length(trim(coalesce(p_city,''))) not between 2 and 80 or length(trim(coalesce(p_country,''))) not between 2 and 80
  then raise exception 'INVALID_DISCOVERY_TARGET'; end if;
 select * into target from public.discovery_targeting where org_id=p_org;
 select * into org from public.organizations where id=p_org;
 if not found or org.research_provider<>'serper' or org.research_monthly_credit_cap=0
  or target.org_id is null or not target.serper_discovery_enabled or target.max_new_prospects<p_limit
  then raise exception 'DISCOVERY_DISABLED'; end if;
 if lower(trim(p_industry))<>all(select lower(trim(unnest(target.target_industries))) )
  or lower(trim(p_city))<>all(select lower(trim(unnest(target.target_cities))) )
  or (cardinality(target.target_countries)>0 and lower(trim(p_country))<>all(select lower(trim(unnest(target.target_countries))) ))
  or lower(trim(p_industry))=any(select lower(trim(unnest(target.excluded_industries))) )
  then raise exception 'DISCOVERY_TARGET_NOT_APPROVED'; end if;
 if exists(select 1 from public.discovery_runs where org_id=p_org and provider='serper' and state in ('queued','leased'))
  then raise exception 'DISCOVERY_ALREADY_PENDING'; end if;
 select coalesce(reserved_credits,0) into used from public.research_credit_usage where org_id=p_org and provider='serper'
  and month_start=date_trunc('month',now() at time zone 'UTC')::date;
 if coalesce(used,0)+31>org.research_monthly_credit_cap then raise exception 'DISCOVERY_CREDIT_CAP'; end if;
 insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country)
 values(p_org,'serper','queued',p_limit,trim(p_industry),trim(p_city),trim(p_country)) returning id into run_id;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'serper_discovery_requested','discovery_runs',run_id);
 return run_id;
end $$;

create function public.lease_serper_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 2 then raise exception 'INVALID_BATCH_SIZE'; end if;
 -- A crash after an external call has an unknown provider outcome. Never
 -- silently repeat that run or spend another credit reservation.
 update public.discovery_runs set state='failed',lease_token=null,lease_until=null,
  last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED',completed_at=now()
  where provider='serper' and state='leased' and lease_until<now();
 return query with candidates as (
  select r.id from public.discovery_runs r
  join public.discovery_targeting t on t.org_id=r.org_id
  join public.organizations o on o.id=r.org_id
  where r.provider='serper' and r.state='queued' and r.next_run_at<=now()
   and t.serper_discovery_enabled and t.max_new_prospects>=r.requested_limit
   and o.research_provider='serper' and o.research_monthly_credit_cap>0
  order by r.created_at,r.id for update of r skip locked limit p_limit
 ) update public.discovery_runs r set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 from candidates c where r.id=c.id returning r.*;
end $$;

create function public.reserve_serper_discovery_credits(p_run uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs; org public.organizations; current_used integer; month date;
begin
 select * into run from public.discovery_runs where id=p_run and provider='serper' and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 if run.reserved_credits=31 then return true; end if;
 select * into org from public.organizations where id=run.org_id for update;
 if org.research_provider<>'serper' then return false; end if;
 month:=date_trunc('month',now() at time zone 'UTC')::date;
 insert into public.research_credit_usage(org_id,provider,month_start) values(run.org_id,'serper',month) on conflict do nothing;
 select reserved_credits into current_used from public.research_credit_usage
  where org_id=run.org_id and provider='serper' and month_start=month for update;
 if org.research_monthly_credit_cap=0 or current_used+31>org.research_monthly_credit_cap then return false; end if;
 update public.research_credit_usage set reserved_credits=reserved_credits+31
  where org_id=run.org_id and provider='serper' and month_start=month;
 update public.discovery_runs set reserved_credits=31 where id=p_run;
 return true;
end $$;

create function public.finish_serper_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
 select * into run from public.discovery_runs where id=p_run and provider='serper' and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 if p_observations not between 0 and least(3,run.requested_limit) or length(coalesce(p_error,''))>80
  then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
 if p_error is null and run.reserved_credits<>31 then raise exception 'DISCOVERY_CREDITS_NOT_RESERVED'; end if;
 update public.discovery_runs set state=case when p_error is null then 'completed' else 'failed' end,
  observations_count=p_observations,last_error_code=p_error,lease_token=null,lease_until=null,completed_at=now()
  where id=p_run;
end $$;

revoke execute on function public.request_serper_discovery(uuid,text,text,text,integer),
 public.lease_serper_discovery_runs(integer),public.reserve_serper_discovery_credits(uuid,uuid),
 public.finish_serper_discovery_run(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.request_serper_discovery(uuid,text,text,text,integer) to authenticated;
grant execute on function public.lease_serper_discovery_runs(integer),
 public.reserve_serper_discovery_credits(uuid,uuid),public.finish_serper_discovery_run(uuid,uuid,integer,text) to service_role;
