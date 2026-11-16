-- Phase 44: one owner START authorizes sequential automatic campaign execution.
--
-- Phase 43 created a batch (first campaign queued, the rest paused) and left
-- every page to a manual "Run next page" click. The SQL already self-queues the
-- next page after a successful page (0079), but only lease_serper_campaign_page
-- can pick a campaign page up, and that RPC requires an explicit org + campaign.
-- Nothing could therefore advance a batch without a human.
--
-- This migration adds the missing durable continuation:
--   1. arming:      an explicit owner action marks a whole batch as automatic
--   2. claiming:    a worker claims one armed campaign page (row-locked)
--   3. advancing:   when a campaign finishes, the next combination of the same
--                    batch is activated automatically, in order
--   4. stopping:    owner pause/cancel, exhausted results, exhausted budget or
--                    a page error stop the batch; nothing self-resumes
--
-- Invariants preserved:
--   * one active campaign per organization (discovery_campaign_one_active)
--   * one leased page per (campaign_id, search_page) (discovery_run_campaign_page)
--   * per-campaign and monthly credit caps (reserve_serper_discovery_credits)
--   * provider is fixed per campaign (discovery_campaigns.provider check)
--   * background leasing never steals campaign pages (0075)
--
-- Local only in this phase: not applied to remote Supabase without separate
-- authorization. No provider is enabled and no credit is spent by this file.

alter table public.discovery_campaigns
  add column if not exists auto_continue boolean not null default false,
  add column if not exists batch_key uuid,
  add column if not exists batch_position smallint,
  add column if not exists auto_authorized_at timestamptz,
  add column if not exists auto_authorized_by uuid,
  add column if not exists auto_stop_reason text;

create index if not exists discovery_campaign_auto_claim
  on public.discovery_campaigns(provider, created_at)
  where auto_continue and state in ('queued','running');

-- Arm a batch for automatic continuation. Explicit owner action only.
create or replace function public.arm_campaign_batch_continuation(p_org uuid, p_campaigns uuid[])
returns uuid[] language plpgsql security definer set search_path='' as $$
declare ids uuid[]; key uuid; campaign public.discovery_campaigns; armed integer := 0;
  campaign_id uuid; position integer := 0;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_campaigns is null or array_length(p_campaigns,1) is null then
    raise exception 'INVALID_DISCOVERY_CAMPAIGN';
  end if;
  -- One key for the whole batch: every combination of this START belongs to
  -- the same batch and is stepped in the confirmed order.
  select coalesce(campaign.batch_key, gen_random_uuid()) into key
    from public.discovery_campaigns where id=p_campaigns[1];
  foreach campaign_id in array p_campaigns loop
    position := position + 1;
    select * into campaign from public.discovery_campaigns where id=campaign_id and org_id=p_org for update;
    if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
    if campaign.state in ('completed','cancelled') then raise exception 'CAMPAIGN_NOT_CONTINUABLE'; end if;
    key := coalesce(campaign.batch_key, key);
    -- The batch position is the order the owner confirmed: the batch runs in
    -- combination order, never in uuid order.
    update public.discovery_campaigns set batch_key=key, batch_position=position, auto_continue=true,
      auto_authorized_at=now(), auto_authorized_by=auth.uid(), auto_stop_reason=null
    where id=campaign.id;
    armed := armed + 1;
  end loop;
  insert into public.audit_events(org_id,actor_id,action,entity_table)
  values(p_org,auth.uid(),'discovery_campaign_batch_armed','discovery_campaigns');
  return p_campaigns;
end $$;

-- Claim one armed campaign for a worker. Row-locked; never steals a page that
-- another org or worker already owns. Returns the campaign and the page that
-- should run next (the row is created here when the page does not exist yet).
create or replace function public.claim_campaign_continuation(p_limit integer default 1, p_org uuid default null)
returns table(org_id uuid, campaign_id uuid, search_page smallint)
language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns; target public.discovery_targeting; org public.organizations;
  used integer; candidate record;
begin
  if p_limit not between 1 and 5 then raise exception 'INVALID_BATCH_SIZE'; end if;
  for candidate in
    select camp.id as cid, camp.org_id as orgid
    from public.discovery_campaigns camp
    join public.discovery_targeting t on t.org_id = camp.org_id
    join public.organizations o on o.id = camp.org_id
    where camp.provider='serper' and camp.auto_continue and camp.state in ('queued','running')
      and camp.new_businesses_count < camp.target_count and camp.credits_reserved < camp.max_credits
      and t.serper_discovery_enabled and t.max_new_prospects >= camp.target_count
      and o.research_provider='serper' and o.research_monthly_credit_cap > 0
      and (p_org is null or camp.org_id = p_org)
      and not exists (select 1 from public.discovery_campaigns x
                      where x.org_id=camp.org_id and x.id<>camp.id and x.state in ('queued','running'))
      and not exists (select 1 from public.discovery_runs r
                      where r.org_id=camp.org_id and r.provider='serper' and r.state in ('queued','leased')
                        and r.campaign_id is distinct from camp.id)
    order by camp.batch_key nulls last, camp.batch_position nulls last, camp.created_at, camp.id
    for update of camp skip locked
    limit p_limit
  loop
    select * into c from public.discovery_campaigns where id=candidate.cid for update;
    select * into target from public.discovery_targeting t where t.org_id=c.org_id;
    select * into org from public.organizations o where o.id=c.org_id;
    -- Monthly budget headroom for the next page of this campaign.
    select coalesce(u.reserved_credits,0) into used from public.research_credit_usage u
     where u.org_id=c.org_id and u.provider='serper'
       and u.month_start=date_trunc('month',now() at time zone 'UTC')::date;
    if coalesce(used,0) + 1 > org.research_monthly_credit_cap then
      update public.discovery_campaigns set state='paused',last_error_code='CAMPAIGN_CREDIT_LIMIT'
       where id=c.id;
      continue;
    end if;
    -- Ensure the next page row exists. A page that is already queued or leased
    -- is the outstanding work (never a second row for the same page); a page
    -- that was cancelled or failed is revived.
    if not exists (select 1 from public.discovery_runs r3
                    where r3.campaign_id=c.id and r3.search_page=c.next_page) then
      insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,
        target_city,target_country,campaign_id,search_mode,search_page,next_run_at)
      values(c.org_id,'serper','queued',least(10,c.target_count-c.new_businesses_count),
        c.target_industry,c.target_city,c.target_country,c.id,'paged_search',c.next_page,now());
    elsif exists (select 1 from public.discovery_runs r3
                    where r3.campaign_id=c.id and r3.search_page=c.next_page
                      and r3.state in ('cancelled','failed')) then
      update public.discovery_runs set state='queued',lease_token=null,lease_until=null,
        next_run_at=now(),reserved_credits=0,last_error_code=null,completed_at=null,
        observations_count=0,attempts=0,
        requested_limit=least(10,c.target_count-c.new_businesses_count)
      where id in (select r2.id from public.discovery_runs r2
                   where r2.campaign_id=c.id and r2.search_page=c.next_page
                     and r2.state in ('cancelled','failed')
                   for update skip locked limit 1);
    end if;
    org_id := c.org_id; campaign_id := c.id; search_page := c.next_page;
    return next;
  end loop;
  return;
end $$;

-- Advance a batch after a campaign page finished:
--   completed -> activate the next paused combination of the same batch
--   paused    -> the batch stops (owner pause, exhausted results or budget, error)
--   cancelled -> the batch stops (owner cancel)
create or replace function public.advance_campaign_batch(p_org uuid, p_campaign uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns; next_campaign uuid; org public.organizations;
  used integer; stopped_reason text;
begin
  select * into c from public.discovery_campaigns where id=p_campaign and org_id=p_org for update;
  if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
  if c.state = 'completed' then
    if c.batch_key is null then return null; end if;
    -- A completed campaign leaves no page behind: any queued page of it is
    -- obsolete (the next page is only queued while the campaign continues).
    update public.discovery_runs set state='cancelled',completed_at=now()
     where campaign_id=c.id and state='queued';
    select id into next_campaign from public.discovery_campaigns
     where org_id=p_org and batch_key=c.batch_key and state='paused' and auto_continue
     order by batch_position nulls last, created_at, id for update skip locked limit 1;
    if next_campaign is null then
      update public.discovery_campaigns set auto_continue=false,auto_stop_reason='BATCH_COMPLETE'
       where org_id=p_org and batch_key=c.batch_key and auto_continue;
      return null;
    end if;
    -- One queued or leased page per organization: never queue the next
    -- combination while another page is still outstanding.
    if exists (select 1 from public.discovery_runs r where r.org_id=p_org and r.provider='serper'
                and r.state in ('queued','leased') and r.campaign_id is distinct from next_campaign) then
      return null;
    end if;
    select * into org from public.organizations where id=p_org for update;
    select coalesce(reserved_credits,0) into used from public.research_credit_usage
     where org_id=p_org and provider='serper'
       and month_start=date_trunc('month',now() at time zone 'UTC')::date;
    if coalesce(used,0) + (select max_credits from public.discovery_campaigns where id=next_campaign)
       > org.research_monthly_credit_cap then
      update public.discovery_campaigns set auto_continue=false,auto_stop_reason='CAMPAIGN_CREDIT_LIMIT'
       where org_id=p_org and batch_key=c.batch_key and auto_continue;
      return null;
    end if;
    update public.discovery_campaigns set state='queued' where id=next_campaign;
    if not exists (select 1 from public.discovery_runs r3
                    where r3.campaign_id=next_campaign and r3.search_page=
                      (select next_page from public.discovery_campaigns where id=next_campaign)) then
      insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,
        target_city,target_country,campaign_id,search_mode,search_page,next_run_at)
      select p_org,'serper','queued',least(10,cc.target_count-cc.new_businesses_count),
        cc.target_industry,cc.target_city,cc.target_country,cc.id,'paged_search',cc.next_page,now()
      from public.discovery_campaigns cc where cc.id=next_campaign;
    elsif exists (select 1 from public.discovery_runs r3
                    where r3.campaign_id=next_campaign and r3.search_page=
                      (select next_page from public.discovery_campaigns where id=next_campaign)
                      and r3.state in ('cancelled','failed')) then
      update public.discovery_runs set state='queued',lease_token=null,lease_until=null,
        next_run_at=now(),reserved_credits=0,last_error_code=null,completed_at=null,
        observations_count=0,attempts=0,
        requested_limit=least(10,(select target_count-new_businesses_count
                                   from public.discovery_campaigns where id=next_campaign))
      where id in (select r4.id from public.discovery_runs r4
                   where r4.campaign_id=next_campaign
                     and r4.search_page=(select next_page from public.discovery_campaigns where id=next_campaign)
                     and r4.state in ('cancelled','failed')
                   for update skip locked limit 1);
    end if;
    insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
      values(p_org,null,'discovery_campaign_batch_advanced','discovery_campaigns',next_campaign);
    return next_campaign;
  end if;
  if c.state in ('paused','cancelled') then
    -- Owner pause keeps the reason empty (the owner may resume); an automatic
    -- pause always carries a reason code. Either way the batch stops now.
    stopped_reason := case when c.state='cancelled' then 'OWNER_CANCELLED'
      when c.last_error_code is null then 'OWNER_PAUSED' else c.last_error_code end;
    -- A stopped batch has no outstanding page: queued pages of its campaigns
    -- are obsolete. A leased page still finishes normally.
    update public.discovery_runs set state='cancelled',completed_at=now()
     where state='queued' and campaign_id in
       (select id from public.discovery_campaigns where org_id=p_org and batch_key=c.batch_key);
    update public.discovery_campaigns set auto_continue=false,auto_stop_reason=stopped_reason
     where org_id=p_org and batch_key=c.batch_key and auto_continue;
    return null;
  end if;
  return null;
end $$;

-- Resume: re-arm the whole batch and activate the requested campaign.
create or replace function public.resume_discovery_campaign(p_org uuid, p_campaign uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.discovery_campaigns where id=p_campaign and org_id=p_org for update;
  if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
  if c.state <> 'paused' then raise exception 'CAMPAIGN_NOT_PAUSIBLE'; end if;
  if c.batch_key is not null then
    update public.discovery_campaigns set auto_continue=true,auto_stop_reason=null,
      auto_authorized_at=now(),auto_authorized_by=auth.uid()
     where org_id=p_org and batch_key=c.batch_key and state in ('queued','paused');
  end if;
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
    values(p_org,auth.uid(),'discovery_campaign_batch_resumed','discovery_campaigns',c.id);
  if public.activate_discovery_campaign(p_org,p_campaign) then return true; end if;
  -- The campaign cannot run any more (budget or target reached): the batch
  -- must not stay armed with nothing to do.
  return public.advance_campaign_batch(p_org,p_campaign) is not null;
end $$;

-- Cancel must also stop the batch: a cancelled campaign ends the run.
create or replace function public.cancel_discovery_campaign(p_org uuid, p_campaign uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.discovery_campaigns where id=p_campaign and org_id=p_org for update;
  if not found then raise exception 'CAMPAIGN_NOT_CANCELLABLE'; end if;
  if c.state not in ('queued','running','paused') then raise exception 'CAMPAIGN_NOT_CANCELLABLE'; end if;
  update public.discovery_campaigns set state='cancelled',completed_at=now(),last_error_code='OWNER_CANCELLED',
    auto_continue=false,auto_stop_reason='OWNER_CANCELLED' where id=c.id;
  update public.discovery_runs set state='cancelled',completed_at=now()
   where org_id=p_org and campaign_id=c.id and state='queued';
  if c.batch_key is not null then
    update public.discovery_campaigns set auto_continue=false,auto_stop_reason='OWNER_CANCELLED'
     where org_id=p_org and batch_key=c.batch_key and auto_continue;
  end if;
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
    values(p_org,auth.uid(),'discovery_campaign_cancelled','discovery_campaigns',c.id);
end $$;

-- Owner pause stops the batch: a paused campaign ends automatic continuation
-- until the owner resumes it.
create or replace function public.pause_discovery_campaign(p_org uuid, p_campaign uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.discovery_campaigns;
begin
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Pause campaign and cancel its queued page run; in-flight (leased) pages finish normally.
  update public.discovery_campaigns set state='paused' where id=p_campaign and org_id=p_org and state in ('queued','running');
  update public.discovery_runs set state='cancelled',completed_at=now(),lease_token=null,lease_until=null where org_id=p_org and campaign_id=p_campaign and state='queued';
  select * into c from public.discovery_campaigns where id=p_campaign and org_id=p_org for update;
  if c.id is null or c.state <> 'paused' then
    raise exception 'CAMPAIGN_NOT_FOUND_OR_NOT_PAUSABLE';
  end if;
  if c.batch_key is not null then
    update public.discovery_campaigns set auto_continue=false,auto_stop_reason='OWNER_PAUSED'
     where org_id=p_org and batch_key=c.batch_key and auto_continue and id<>c.id;
    update public.discovery_campaigns set auto_stop_reason='OWNER_PAUSED' where id=c.id;
  end if;
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
    values(p_org,auth.uid(),'discovery_campaign_paused','discovery_campaigns',p_campaign);
end $$;

revoke all on function public.arm_campaign_batch_continuation(uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.claim_campaign_continuation(integer,uuid) from public,anon,authenticated;
revoke all on function public.advance_campaign_batch(uuid,uuid) from public,anon,authenticated;
revoke all on function public.resume_discovery_campaign(uuid,uuid) from public,anon,authenticated;
revoke all on function public.cancel_discovery_campaign(uuid,uuid) from public,anon,authenticated;
grant execute on function public.arm_campaign_batch_continuation(uuid,uuid[]) to authenticated;
grant execute on function public.pause_discovery_campaign(uuid,uuid) to authenticated;
grant execute on function public.resume_discovery_campaign(uuid,uuid) to authenticated;
grant execute on function public.cancel_discovery_campaign(uuid,uuid) to authenticated;
grant execute on function public.claim_campaign_continuation(integer,uuid) to service_role;
grant execute on function public.advance_campaign_batch(uuid,uuid) to service_role;
