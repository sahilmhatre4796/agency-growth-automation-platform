-- Restore Serper campaign invariants that migration 0074 replaced along with
-- its bounded-retry bodies, without giving up bounded retries:
--   1. Background leasing must never acquire or recover owner-stepped
--      campaign pages (0057 invariant); only lease_serper_campaign_page may,
--      and expired campaign leases stay owner-reviewed.
--   2. finish_serper_discovery_run must stay search_mode-aware: paged_search
--      pages reserve 1 credit and persist up to requested_limit (max 10)
--      observations; deep runs reserve 31 credits and persist at most 3
--      (0056 semantics).
--   3. An errored campaign page fails terminally so finish_discovery_campaign_page
--      can pause the campaign for owner review; background (non-campaign) runs
--      keep 0074's bounded retry with backoff until max_attempts.
-- Local only in this phase; not applied to remote Supabase without separate
-- authorization. Grants from 0074 are preserved by create or replace.

create or replace function public.lease_serper_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
  if p_limit not between 1 and 2 then raise exception 'INVALID_BATCH_SIZE'; end if;
  -- Recover expired leases of background runs only: atomic, row-locked,
  -- skip-locked. Expired campaign leases remain owned by
  -- lease_serper_campaign_page, which pauses the campaign for owner review.
  with expired as (
    select id from public.discovery_runs
    where provider = 'serper' and campaign_id is null and state = 'leased' and lease_until < now()
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
  -- Lease next available background queued run; attempts counted on lease.
  return query with candidates as (
    select r.id from public.discovery_runs r
    join public.discovery_targeting t on t.org_id = r.org_id
    join public.organizations o on o.id = r.org_id
    where r.provider = 'serper' and r.campaign_id is null and r.state = 'queued' and r.next_run_at <= now()
      and t.serper_discovery_enabled and t.max_new_prospects >= r.requested_limit
      and o.research_provider = 'serper' and o.research_monthly_credit_cap > 0
    order by r.created_at, r.id for update of r skip locked limit p_limit
  ) update public.discovery_runs r set state = 'leased',
    attempts = r.attempts + 1,
    lease_token = gen_random_uuid(),
    lease_until = now() + interval '3 minutes'
  from candidates c where r.id = c.id returning r.*;
end $$;

create or replace function public.finish_serper_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
  select * into run from public.discovery_runs where id = p_run and provider = 'serper' and state = 'leased'
   and lease_token = p_token and lease_until > now() for update;
  if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
  if p_observations not between 0 and run.requested_limit
   or (run.search_mode = 'deep' and p_observations > 3)
   or length(coalesce(p_error,''))>80
   then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
  if p_error is null and ((run.search_mode = 'paged_search' and run.reserved_credits <> 1)
   or (run.search_mode = 'deep' and run.reserved_credits <> 31))
   then raise exception 'DISCOVERY_CREDITS_NOT_RESERVED'; end if;
  if p_error is not null then
    if run.campaign_id is null and run.attempts < run.max_attempts then
      update public.discovery_runs set state='queued',last_error_code=p_error,
       next_run_at=now()+make_interval(secs=>least(3600,power(2,run.attempts)::integer*30)),
       lease_token=null,lease_until=null where id=p_run;
    else
      update public.discovery_runs set state='failed',last_error_code=p_error,
       lease_token=null,lease_until=null,completed_at=now() where id=p_run;
    end if;
  else
    update public.discovery_runs set state='completed',observations_count=p_observations,
     last_error_code=null,lease_token=null,lease_until=null,completed_at=now() where id=p_run;
  end if;
end $$;
