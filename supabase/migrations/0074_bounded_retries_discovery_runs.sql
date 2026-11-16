-- Bounded retries for discovery runs: attempts counted atomically on lease,
-- expired-lease recovery requeues when attempts remain, terminal failure after
-- max_attempts. Exponential backoff capped at 1 hour. Runs locally only in
-- this phase; not applied to remote Supabase without separate authorization.
alter table public.discovery_runs
 add column attempts smallint not null default 0 check(attempts >= 0),
 add column max_attempts smallint not null default 3 check(max_attempts between 1 and 10);

-- Replace lease_serper_discovery_runs: attempt counting on lease, atomic
-- expired-lease recovery with FOR UPDATE SKIP LOCKED so concurrent workers
-- never recover or process the same expired run.
create or replace function public.lease_serper_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
  if p_limit not between 1 and 2 then raise exception 'INVALID_BATCH_SIZE'; end if;
  -- Recover expired leases atomically: row-locked, skip-locked, each run
  -- recovered by at most one worker. Requeue if attempts remain, fail if
  -- max_attempts reached. A crashed worker's attempt was already counted at
  -- lease time, so recovery never double-counts.
  with expired as (
    select id from public.discovery_runs
    where provider = 'serper' and state = 'leased' and lease_until < now()
    for update skip locked
  )
  update public.discovery_runs
  set state = case when attempts >= max_attempts then 'failed' else 'queued' end,
      last_error_code = case when attempts >= max_attempts then 'LEASE_EXPIRED_MAX_ATTEMPTS'
                             else 'LEASE_EXPIRED_RETRY' end,
      next_run_at = case when attempts >= max_attempts then now()
        else now() + make_interval(secs => least(3600, power(2, attempts)::integer * 30)) end,
      lease_token = null, lease_until = null,
      completed_at = case when attempts >= max_attempts then now() else completed_at end
  where id in (select id from expired);
  -- Lease next available queued run: attempt counted atomically on lease.
  return query with candidates as (
    select r.id from public.discovery_runs r
    join public.discovery_targeting t on t.org_id = r.org_id
    join public.organizations o on o.id = r.org_id
    where r.provider = 'serper' and r.state = 'queued' and r.next_run_at <= now()
      and t.serper_discovery_enabled and t.max_new_prospects >= r.requested_limit
      and o.research_provider = 'serper' and o.research_monthly_credit_cap > 0
    order by r.created_at, r.id for update of r skip locked limit p_limit
  ) update public.discovery_runs r set state = 'leased',
    attempts = r.attempts + 1,
    lease_token = gen_random_uuid(),
    lease_until = now() + interval '3 minutes'
  from candidates c where r.id = c.id returning r.*;
end $$;

-- Replace finish_serper_discovery_run: uses existing attempt count (set at
-- lease time), never increments. Requeues with backoff if attempts remain;
-- terminal failure after max_attempts.
create or replace function public.finish_serper_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
  select * into run from public.discovery_runs where id = p_run and provider = 'serper' and state = 'leased'
   and lease_token = p_token and lease_until > now() for update;
  if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
  if p_observations not between 0 and least(3,run.requested_limit) or length(coalesce(p_error,''))>80
   then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
  if p_error is null and run.reserved_credits<>31 then raise exception 'DISCOVERY_CREDITS_NOT_RESERVED'; end if;
  if p_error is not null then
    if run.attempts >= run.max_attempts then
      update public.discovery_runs set state='failed',last_error_code=p_error,
       lease_token=null,lease_until=null,completed_at=now() where id=p_run;
    else
      update public.discovery_runs set state='queued',last_error_code=p_error,
       next_run_at=now()+make_interval(secs=>least(3600,power(2,run.attempts)::integer*30)),
       lease_token=null,lease_until=null where id=p_run;
    end if;
  else
    update public.discovery_runs set state='completed',observations_count=p_observations,
     last_error_code=null,lease_token=null,lease_until=null,completed_at=now() where id=p_run;
  end if;
end $$;

-- Replace lease_harvey_osm_discovery_runs: same retry/recovery pattern,
-- preserving the existing 2-second rate limiter.
create or replace function public.lease_harvey_osm_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
declare last_started timestamptz; leased_count integer;
begin
  if p_limit<>1 then raise exception 'INVALID_BATCH_SIZE'; end if;
  select last_started_at into last_started from private.harvey_osm_rate_state where singleton=true for update;
  -- Expired lease recovery (atomic, row-locked)
  with expired as (
    select id from public.discovery_runs
    where provider = 'harvey' and state = 'leased' and lease_until < now()
    for update skip locked
  )
  update public.discovery_runs
  set state = case when attempts >= max_attempts then 'failed' else 'queued' end,
      last_error_code = case when attempts >= max_attempts then 'LEASE_EXPIRED_MAX_ATTEMPTS'
                             else 'LEASE_EXPIRED_RETRY' end,
      next_run_at = case when attempts >= max_attempts then now()
        else now() + make_interval(secs => least(3600, power(2, attempts)::integer * 30)) end,
      lease_token = null, lease_until = null,
      completed_at = case when attempts >= max_attempts then now() else completed_at end
  where id in (select id from expired);
  if (last_started is not null and last_started>now()-interval '2 seconds')
   or exists(select 1 from public.discovery_runs where provider='harvey' and state='leased' and lease_until>now())
   then return; end if;
  return query with candidates as (
   select r.id from public.discovery_runs r join public.discovery_targeting t on t.org_id=r.org_id
   where r.provider='harvey' and r.state='queued' and r.next_run_at<=now()
    and t.harvey_discovery_enabled and t.max_new_prospects>=r.requested_limit
   order by r.created_at,r.id for update of r skip locked limit 1
  ) update public.discovery_runs r set state='leased',attempts=r.attempts+1,
   lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
  from candidates c where r.id=c.id returning r.*;
  get diagnostics leased_count=row_count;
  if leased_count>0 then update private.harvey_osm_rate_state set last_started_at=now() where singleton=true; end if;
end $$;

-- Replace finish_harvey_osm_discovery_run: attempt-aware requeue/terminal.
create or replace function public.finish_harvey_osm_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
  select * into run from public.discovery_runs where id = p_run and provider = 'harvey' and state = 'leased'
   and lease_token = p_token and lease_until > now() for update;
  if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
  if p_observations not between 0 and least(3,run.requested_limit) or length(coalesce(p_error,''))>80
   then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
  if p_error is not null then
    if run.attempts >= run.max_attempts then
      update public.discovery_runs set state='failed',last_error_code=p_error,
       lease_token=null,lease_until=null,completed_at=now() where id=p_run;
    else
      update public.discovery_runs set state='queued',last_error_code=p_error,
       next_run_at=now()+make_interval(secs=>least(3600,power(2,run.attempts)::integer*30)),
       lease_token=null,lease_until=null where id=p_run;
    end if;
  else
    update public.discovery_runs set state='completed',observations_count=p_observations,
     last_error_code=null,lease_token=null,lease_until=null,completed_at=now() where id=p_run;
  end if;
end $$;

revoke execute on function public.lease_serper_discovery_runs(integer),
 public.finish_serper_discovery_run(uuid,uuid,integer,text),
 public.lease_harvey_osm_discovery_runs(integer),
 public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.lease_serper_discovery_runs(integer),
 public.finish_serper_discovery_run(uuid,uuid,integer,text),
 public.lease_harvey_osm_discovery_runs(integer),
 public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text) to service_role;
