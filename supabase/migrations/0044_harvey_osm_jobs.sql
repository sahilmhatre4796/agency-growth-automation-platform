-- Optional, owner-requested OSM discovery adapted from Harvey's free collector.
-- No sending, email finding, website assertion or autonomous loop is included.
alter table public.discovery_runs add column target_latitude numeric(9,6),
 add column target_longitude numeric(9,6), add column target_radius_km numeric(4,1);
create table private.harvey_osm_rate_state(singleton boolean primary key default true check(singleton),
 last_started_at timestamptz);
insert into private.harvey_osm_rate_state(singleton) values(true);

create function public.request_harvey_osm_discovery(p_org uuid,p_category text,p_city text,p_country text,
 p_latitude numeric,p_longitude numeric,p_radius_km numeric,p_limit integer default 3)
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.discovery_targeting; rid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_category not in ('dentist','plumber','electrician','roofer','gardener')
  or length(trim(coalesce(p_city,''))) not between 2 and 80
  or length(trim(coalesce(p_country,''))) not between 2 and 80
  or p_latitude not between -90 and 90 or p_longitude not between -180 and 180
  or p_radius_km not between 1 and 10 or p_limit not between 1 and 3
  then raise exception 'INVALID_OSM_TARGET'; end if;
 select * into target from public.discovery_targeting where org_id=p_org for update;
 if not found or not target.harvey_discovery_enabled or target.max_new_prospects<p_limit
  then raise exception 'DISCOVERY_DISABLED'; end if;
 if lower(trim(p_category))<>all(select lower(trim(unnest(target.target_industries))) )
  or lower(trim(p_city))<>all(select lower(trim(unnest(target.target_cities))) )
  or (cardinality(target.target_countries)>0 and lower(trim(p_country))<>all(select lower(trim(unnest(target.target_countries))) ))
  or lower(trim(p_category))=any(select lower(trim(unnest(target.excluded_industries))) )
  then raise exception 'DISCOVERY_TARGET_NOT_APPROVED'; end if;
 if exists(select 1 from public.discovery_runs where org_id=p_org and provider='harvey' and state in ('queued','leased'))
  then raise exception 'DISCOVERY_ALREADY_PENDING'; end if;
 select id into rid from public.discovery_runs where org_id=p_org and provider='harvey' and state='completed'
  and target_industry=trim(p_category) and target_city=trim(p_city) and target_country=trim(p_country)
  and target_latitude=p_latitude and target_longitude=p_longitude and target_radius_km=p_radius_km
  and requested_limit=p_limit and completed_at>now()-interval '14 days'
  order by completed_at desc,id desc limit 1;
 if found then return rid; end if;
 if exists(select 1 from public.discovery_runs where org_id=p_org and provider='harvey'
  and created_at>now()-interval '2 minutes') then raise exception 'OSM_RATE_LIMITED'; end if;
 insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country,
  target_latitude,target_longitude,target_radius_km)
 values(p_org,'harvey','queued',p_limit,trim(p_category),trim(p_city),trim(p_country),p_latitude,p_longitude,p_radius_km)
 returning id into rid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'harvey_osm_discovery_requested','discovery_runs',rid);
 return rid;
end $$;

create function public.lease_harvey_osm_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
declare last_started timestamptz; leased_count integer;
begin
 if p_limit<>1 then raise exception 'INVALID_BATCH_SIZE'; end if;
 select last_started_at into last_started from private.harvey_osm_rate_state where singleton=true for update;
 update public.discovery_runs set state='failed',lease_token=null,lease_until=null,
  last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED',completed_at=now()
  where provider='harvey' and state='leased' and lease_until<now();
 if (last_started is not null and last_started>now()-interval '2 seconds')
  or exists(select 1 from public.discovery_runs where provider='harvey' and state='leased' and lease_until>now())
  then return; end if;
 return query with candidates as (
  select r.id from public.discovery_runs r join public.discovery_targeting t on t.org_id=r.org_id
  where r.provider='harvey' and r.state='queued' and r.next_run_at<=now()
   and t.harvey_discovery_enabled and t.max_new_prospects>=r.requested_limit
  order by r.created_at,r.id for update of r skip locked limit 1
 ) update public.discovery_runs r set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 from candidates c where r.id=c.id returning r.*;
 get diagnostics leased_count=row_count;
 if leased_count>0 then update private.harvey_osm_rate_state set last_started_at=now() where singleton=true; end if;
end $$;

create function public.finish_harvey_osm_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
 select * into run from public.discovery_runs where id=p_run and provider='harvey' and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 if p_observations not between 0 and least(3,run.requested_limit) or length(coalesce(p_error,''))>80
  then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
 update public.discovery_runs set state=case when p_error is null then 'completed' else 'failed' end,
  observations_count=p_observations,last_error_code=p_error,lease_token=null,lease_until=null,completed_at=now()
  where id=p_run;
end $$;
revoke execute on function public.request_harvey_osm_discovery(uuid,text,text,text,numeric,numeric,numeric,integer),
 public.lease_harvey_osm_discovery_runs(integer),public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text)
 from public,anon,authenticated;
grant execute on function public.request_harvey_osm_discovery(uuid,text,text,text,numeric,numeric,numeric,integer) to authenticated;
grant execute on function public.lease_harvey_osm_discovery_runs(integer),
 public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text) to service_role;
