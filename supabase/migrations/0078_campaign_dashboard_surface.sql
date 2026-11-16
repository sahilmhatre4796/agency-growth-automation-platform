-- Campaign Command Center surface (additive; no table rewrites).
-- Adds: admin targeting/campaign RPCs, batch campaign creation with per-combo
-- campaigns (one active queued campaign per org at a time), sequential activation.

-- Owner/admin targeting management for Serper discovery (panel, full replace).
create or replace function public.save_serper_targeting(p_org uuid, p_serper_enabled boolean, p_industries text[], p_cities text[], p_countries text[], p_max_new_prospects integer)
returns void language plpgsql security definer set search_path='' as $$
declare industries text[]; cities text[]; countries text[];
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select coalesce(array_agg(x order by x), '{}') into industries from (select distinct lower(trim(i)) x from unnest(coalesce(p_industries,'{}')) i) s where length(x) between 3 and 80;
  select coalesce(array_agg(x order by x), '{}') into cities from (select distinct lower(trim(c)) x from unnest(coalesce(p_cities,'{}')) c) s where length(x) between 2 and 120;
  select coalesce(array_agg(x order by x), '{}') into countries from (select distinct lower(trim(c)) x from unnest(coalesce(p_countries,'{}')) c) s where length(x) between 2 and 80;
  if coalesce(p_max_new_prospects,0) not between 0 and 100 then raise exception 'INVALID_DISCOVERY_TARGET'; end if;
  insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,max_new_prospects,serper_discovery_enabled)
  values(p_org,industries,cities,countries,p_max_new_prospects,coalesce(p_serper_enabled,false))
  on conflict (org_id) do update set
    target_industries=excluded.target_industries,
    target_cities=excluded.target_cities,
    target_countries=excluded.target_countries,
    max_new_prospects=excluded.max_new_prospects,
    serper_discovery_enabled=coalesce(p_serper_enabled, public.discovery_targeting.serper_discovery_enabled),
    updated_at=now(), updated_by=auth.uid();
  insert into public.audit_events(org_id,actor_id,action,entity_table) values(p_org,auth.uid(),'serper_targeting_saved','discovery_targeting');
end $$;

-- Batch campaign creation: one active queued campaign per org at a time; the
-- remaining combinations are created as 'paused' and activated in order later.
create or replace function public.create_discovery_campaign_batch(p_org uuid, p_name text, p_industries text[], p_cities text[], p_country text, p_count integer, p_website_percent integer, p_max_credits integer)
returns uuid[] language plpgsql security definer set search_path='' as $$
declare target public.discovery_targeting; org public.organizations;
  inds text[]; cities text[]; combos integer; used integer; i integer := 0;
  ind_row text; cit_row text; ids uuid[] := '{}'; campaign uuid; state_row text;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_count not between 1 and 100 or p_website_percent not between 0 and 100
   or p_max_credits not between 1 and 15
   or length(trim(coalesce(p_country,''))) not between 2 and 80
   or length(trim(coalesce(p_name,''))) > 80
   then raise exception 'INVALID_DISCOVERY_CAMPAIGN'; end if;
  select coalesce(array_agg(x order by x), '{}') into inds from (select distinct lower(trim(u)) x from unnest(coalesce(p_industries,'{}')) u) s where length(x) between 3 and 80;
  select coalesce(array_agg(x order by x), '{}') into cities from (select distinct lower(trim(u)) x from unnest(coalesce(p_cities,'{}')) u) s where length(x) between 2 and 120;
  if array_length(inds,1) is null then raise exception 'INVALID_DISCOVERY_CAMPAIGN'; end if;
  if array_length(cities,1) is null or array_length(cities,1) = 0 then cities := array['*']; end if; -- nationwide
  combos := array_length(inds,1) * array_length(cities,1);
  if combos > 6 then raise exception 'TOO_MANY_COMBINATIONS'; end if;
  select * into target from public.discovery_targeting where org_id=p_org for update;
  if target.org_id is null or not target.serper_discovery_enabled or target.max_new_prospects < p_count then raise exception 'DISCOVERY_DISABLED' using errcode='P0001'; end if;
  if exists(select 1 from unnest(inds) u(ind) where lower(u.ind) <> all (select lower(t.ind) from unnest(target.target_industries) t(ind))) then raise exception 'DISCOVERY_TARGET_NOT_APPROVED'; end if;
  select * into org from public.organizations where id=p_org for update;
  if org.research_provider <> 'serper' or org.research_monthly_credit_cap = 0 then raise exception 'DISCOVERY_DISABLED'; end if;
  if exists(select 1 from public.discovery_campaigns where org_id=p_org and provider='serper' and state in ('queued','running'))
   or exists(select 1 from public.discovery_runs where org_id=p_org and provider='serper' and state in ('queued','leased'))
   then raise exception 'DISCOVERY_ALREADY_PENDING'; end if;
  select coalesce(reserved_credits,0) into used from public.research_credit_usage where org_id=p_org and provider='serper'
   and month_start=date_trunc('month',now() at time zone 'UTC')::date;
  if coalesce(used,0) + (p_max_credits * combos) > org.research_monthly_credit_cap then raise exception 'DISCOVERY_CREDIT_CAP'; end if;
  foreach ind_row in array inds loop
    foreach cit_row in array cities loop
      i := i + 1;
      campaign := gen_random_uuid();
      state_row := case when i = 1 then 'queued' else 'paused' end;
      insert into public.discovery_campaigns(id,org_id,provider,state,target_count,website_percent,target_industry,target_city,target_country,max_credits,created_by)
      values(campaign,p_org,'serper',state_row,least(100,p_count),p_website_percent,trim(ind_row),trim(cit_row),trim(p_country),p_max_credits,auth.uid());
      ids := array_append(ids, campaign);
      insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
      values(p_org,auth.uid(),'discovery_campaign_created','discovery_campaigns',campaign);
      if i = 1 then
        insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country,campaign_id,search_mode,search_page)
        values(p_org,'serper','queued',least(10,p_count),trim(ind_row),trim(cit_row),trim(p_country),campaign,'paged_search',1);
      end if;
    end loop;
  end loop;
  return ids;
end $$;

-- Activate a paused campaign when nothing active remains (promotes next phase 1 run).
create or replace function public.activate_discovery_campaign(p_org uuid, p_campaign uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.discovery_campaigns where id=p_campaign and org_id=p_org for update;
  if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
  if c.state <> 'paused' then raise exception 'CAMPAIGN_NOT_PAUSIBLE'; end if;
  if c.credits_reserved >= c.max_credits or c.new_businesses_count >= c.target_count then
    update public.discovery_campaigns set state='completed',last_error_code='AUTO_COMPLETED' where id=c.id;
    insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
    values(p_org,auth.uid(),'discovery_campaign_auto_completed','discovery_campaigns',c.id);
    return false;
  end if;
  if exists(select 1 from public.discovery_campaigns where org_id=p_org and provider='serper' and state in ('queued','running'))
   or exists(select 1 from public.discovery_runs where org_id=p_org and provider='serper' and state in ('queued','leased'))
   then raise exception 'DISCOVERY_ALREADY_PENDING'; end if;
  update public.discovery_campaigns set state='queued' where id=c.id;
  -- Reuse the cancelled/failed row for this page if one exists; inserting would
  -- collide with the unique (campaign_id, search_page) index.
  update public.discovery_runs
  set state='queued', lease_token=null, lease_until=null, next_run_at=now(),
      reserved_credits=0, last_error_code=null, completed_at=null, observations_count=0,
      attempts=0, requested_limit=least(10, c.target_count - c.new_businesses_count)
  where id in (select id from public.discovery_runs
               where org_id=p_org and campaign_id=c.id and search_page=c.next_page and state in ('queued','cancelled','failed')
               for update skip locked limit 1);
  if not found then
    insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country,campaign_id,search_mode,search_page)
    values(p_org,'serper','queued',least(10,c.target_count-c.new_businesses_count),
      c.target_industry,c.target_city,c.target_country,c.id,'paged_search',c.next_page);
  end if;
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
  values(p_org,auth.uid(),'discovery_campaign_activated','discovery_campaigns',c.id);
  return true;
end $$;

-- Pause a queued or running campaign (owner control; queued runs stay queued but never lease since gate requires queued/running).
create or replace function public.pause_discovery_campaign(p_org uuid, p_campaign uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Pause campaign and cancel its queued page run; in-flight (leased) pages finish normally.
  update public.discovery_campaigns set state='paused' where id=p_campaign and org_id=p_org and state in ('queued','running');
  update public.discovery_runs set state='cancelled',completed_at=now(),lease_token=null,lease_until=null where org_id=p_org and campaign_id=p_campaign and state='queued';
  if not exists(select 1 from public.discovery_campaigns where id=p_campaign and org_id=p_org and state='paused') then
    raise exception 'CAMPAIGN_NOT_FOUND_OR_NOT_PAUSABLE';
  end if;
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
  values(p_org,auth.uid(),'discovery_campaign_paused','discovery_campaigns',p_campaign);
end $$;

revoke all on function public.save_serper_targeting(uuid,boolean,text[],text[],text[],integer) from public,anon,authenticated;
revoke all on function public.create_discovery_campaign_batch(uuid,text,text[],text[],text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.activate_discovery_campaign(uuid,uuid) from public,anon,authenticated;
revoke all on function public.pause_discovery_campaign(uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_serper_targeting(uuid,boolean,text[],text[],text[],integer) to authenticated;
grant execute on function public.create_discovery_campaign_batch(uuid,text,text[],text[],text,integer,integer,integer) to authenticated;
grant execute on function public.activate_discovery_campaign(uuid,uuid) to authenticated;
grant execute on function public.pause_discovery_campaign(uuid,uuid) to authenticated;
