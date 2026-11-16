-- Let an authenticated owner advance only the exact OSM run they queued.
-- The Edge function validates the owner JWT; only service_role may lease.
-- Existing global leasing and research/outreach defaults are unchanged.
create function public.lease_harvey_osm_owner_run(p_org uuid, p_run uuid)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
declare last_started timestamptz; leased_count integer;
begin
 select last_started_at into last_started from private.harvey_osm_rate_state
  where singleton=true for update;
 if last_started is not null and last_started>now()-interval '2 seconds' then return; end if;
 if exists(select 1 from public.discovery_runs where provider='harvey' and state='leased'
  and lease_until>now()) then return; end if;
 return query with candidate as (
  select r.id from public.discovery_runs r
  join public.discovery_targeting t on t.org_id=r.org_id
  where r.id=p_run and r.org_id=p_org and r.provider='harvey'
   and r.state='queued' and r.next_run_at<=now()
   and t.harvey_discovery_enabled and t.max_new_prospects>=r.requested_limit
  for update of r skip locked
 ) update public.discovery_runs r
  set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
  from candidate c where r.id=c.id returning r.*;
 get diagnostics leased_count=row_count;
 if leased_count>0 then update private.harvey_osm_rate_state
  set last_started_at=now() where singleton=true; end if;
end $$;
revoke execute on function public.lease_harvey_osm_owner_run(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.lease_harvey_osm_owner_run(uuid,uuid) to service_role;
