-- Owner-requested discovery advances one bounded, paged search at a time.
-- Search snippets remain unreviewed candidate evidence. No provider flag or
-- budget is enabled by this migration.
create table public.discovery_campaigns (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 provider text not null default 'serper' check(provider='serper'),
 state text not null default 'queued' check(state in ('queued','running','paused','completed','cancelled')),
 target_count smallint not null check(target_count between 1 and 100),
 website_percent smallint not null default 70 check(website_percent between 0 and 100),
 target_industry text not null,
 target_city text not null,
 target_country text not null,
 max_credits smallint not null check(max_credits between 1 and 15),
 credits_reserved smallint not null default 0 check(credits_reserved between 0 and 15),
 next_page smallint not null default 1 check(next_page between 1 and 16),
 pages_completed smallint not null default 0 check(pages_completed between 0 and 15),
 observations_count smallint not null default 0 check(observations_count between 0 and 150),
 new_businesses_count smallint not null default 0 check(new_businesses_count between 0 and 150),
 last_error_code text,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 unique(org_id,id)
);
create unique index discovery_campaign_one_active on public.discovery_campaigns(org_id,provider)
 where state in ('queued','running');
alter table public.discovery_campaigns enable row level security;
create policy discovery_campaign_admin_read on public.discovery_campaigns for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.discovery_campaigns from public,anon,authenticated;
grant select on public.discovery_campaigns to authenticated;
grant all on public.discovery_campaigns to service_role;

alter table public.discovery_runs add column campaign_id uuid,
 add column search_mode text not null default 'deep' check(search_mode in ('deep','paged_search')),
 add column search_page smallint not null default 1 check(search_page between 1 and 15);
alter table public.discovery_runs add constraint discovery_run_campaign_tenant_fk
 foreign key(org_id,campaign_id) references public.discovery_campaigns(org_id,id);
alter table public.discovery_runs drop constraint discovery_runs_reserved_credits_check;
alter table public.discovery_runs add constraint discovery_runs_reserved_credits_check
 check(reserved_credits in (0,1,31));
alter table public.discovery_runs drop constraint discovery_runs_observations_count_check;
alter table public.discovery_runs add constraint discovery_runs_observations_count_check
 check(observations_count between 0 and 10);
create unique index discovery_run_campaign_page on public.discovery_runs(campaign_id,search_page)
 where campaign_id is not null;

create function public.request_discovery_campaign(p_org uuid,p_industry text,p_city text,p_country text,
 p_count integer,p_website_percent integer,p_max_credits integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.discovery_targeting; org public.organizations; campaign uuid; used integer;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_count not between 1 and 100 or p_website_percent not between 0 and 100 or p_max_credits not between 1 and 15
  or length(trim(coalesce(p_industry,''))) not between 3 and 80
  or length(trim(coalesce(p_city,''))) not between 2 and 80
  or length(trim(coalesce(p_country,''))) not between 2 and 80
  then raise exception 'INVALID_DISCOVERY_CAMPAIGN'; end if;
 select * into target from public.discovery_targeting where org_id=p_org for update;
 select * into org from public.organizations where id=p_org for update;
 if target.org_id is null or not target.serper_discovery_enabled or target.max_new_prospects<p_count
  or org.research_provider<>'serper' or org.research_monthly_credit_cap=0
  then raise exception 'DISCOVERY_DISABLED'; end if;
 if lower(trim(p_industry))<>all(select lower(trim(unnest(target.target_industries))) )
  or lower(trim(p_city))<>all(select lower(trim(unnest(target.target_cities))) )
  or (cardinality(target.target_countries)>0 and lower(trim(p_country))<>all(select lower(trim(unnest(target.target_countries))) ))
  or lower(trim(p_industry))=any(select lower(trim(unnest(target.excluded_industries))) )
  then raise exception 'DISCOVERY_TARGET_NOT_APPROVED'; end if;
 if exists(select 1 from public.discovery_campaigns where org_id=p_org and provider='serper' and state in ('queued','running'))
  or exists(select 1 from public.discovery_runs where org_id=p_org and provider='serper' and state in ('queued','leased'))
  then raise exception 'DISCOVERY_ALREADY_PENDING'; end if;
 select coalesce(reserved_credits,0) into used from public.research_credit_usage where org_id=p_org and provider='serper'
  and month_start=date_trunc('month',now() at time zone 'UTC')::date;
 if coalesce(used,0)+p_max_credits>org.research_monthly_credit_cap then raise exception 'DISCOVERY_CREDIT_CAP'; end if;
 insert into public.discovery_campaigns(org_id,target_count,website_percent,target_industry,target_city,target_country,
  max_credits,created_by) values(p_org,p_count,p_website_percent,trim(p_industry),trim(p_city),trim(p_country),
  p_max_credits,auth.uid()) returning id into campaign;
 insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country,
  campaign_id,search_mode,search_page)
 values(p_org,'serper','queued',least(10,p_count),trim(p_industry),trim(p_city),trim(p_country),
  campaign,'paged_search',1);
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'discovery_campaign_requested','discovery_campaigns',campaign);
 return campaign;
end $$;

create or replace function public.reserve_serper_discovery_credits(p_run uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs; org public.organizations; current_used integer; month date; cost integer;
 campaign public.discovery_campaigns;
begin
 select * into run from public.discovery_runs where id=p_run and provider='serper' and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 cost:=case when run.search_mode='paged_search' and run.campaign_id is not null then 1 else 31 end;
 if run.reserved_credits=cost then return true; end if;
 if run.campaign_id is not null then
  select * into campaign from public.discovery_campaigns where org_id=run.org_id and id=run.campaign_id for update;
  if campaign.state not in ('queued','running') or campaign.credits_reserved+cost>campaign.max_credits then return false; end if;
 end if;
 select * into org from public.organizations where id=run.org_id for update;
 if org.research_provider<>'serper' then return false; end if;
 month:=date_trunc('month',now() at time zone 'UTC')::date;
 insert into public.research_credit_usage(org_id,provider,month_start) values(run.org_id,'serper',month) on conflict do nothing;
 select reserved_credits into current_used from public.research_credit_usage
  where org_id=run.org_id and provider='serper' and month_start=month for update;
 if org.research_monthly_credit_cap=0 or current_used+cost>org.research_monthly_credit_cap then return false; end if;
 update public.research_credit_usage set reserved_credits=reserved_credits+cost
  where org_id=run.org_id and provider='serper' and month_start=month;
 update public.discovery_runs set reserved_credits=cost where id=p_run;
 if run.campaign_id is not null then update public.discovery_campaigns
  set credits_reserved=credits_reserved+cost,state='running' where id=run.campaign_id; end if;
 return true;
end $$;

create or replace function public.finish_serper_discovery_run(p_run uuid,p_token uuid,p_observations integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
 select * into run from public.discovery_runs where id=p_run and provider='serper' and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 if p_observations not between 0 and run.requested_limit
  or (run.search_mode='deep' and p_observations>3)
  or length(coalesce(p_error,''))>80 then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
 if p_error is null and ((run.search_mode='paged_search' and run.reserved_credits<>1)
  or (run.search_mode='deep' and run.reserved_credits<>31))
  then raise exception 'DISCOVERY_CREDITS_NOT_RESERVED'; end if;
 update public.discovery_runs set state=case when p_error is null then 'completed' else 'failed' end,
  observations_count=p_observations,last_error_code=p_error,lease_token=null,lease_until=null,completed_at=now()
  where id=p_run;
end $$;

create or replace function public.lease_serper_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 2 then raise exception 'INVALID_BATCH_SIZE'; end if;
 -- An expired lease may already have spent its provider credit. Pause the
 -- parent for owner review; never retry an uncertain external request.
 update public.discovery_campaigns c set state='paused',last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED'
  where c.state in ('queued','running') and exists(select 1 from public.discovery_runs r
   where r.campaign_id=c.id and r.state='leased' and r.lease_until<now());
 update public.discovery_runs set state='failed',lease_token=null,lease_until=null,
  last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED',completed_at=now()
  where provider='serper' and state='leased' and lease_until<now();
 return query with candidates as (
  select r.id from public.discovery_runs r
  join public.discovery_targeting t on t.org_id=r.org_id
  join public.organizations o on o.id=r.org_id
  left join public.discovery_campaigns c on c.id=r.campaign_id and c.org_id=r.org_id
  where r.provider='serper' and r.state='queued' and r.next_run_at<=now()
   and t.serper_discovery_enabled and t.max_new_prospects>=r.requested_limit
   and o.research_provider='serper' and o.research_monthly_credit_cap>0
   and (r.campaign_id is null or c.state in ('queued','running'))
  order by r.created_at,r.id for update of r skip locked limit p_limit
 ) update public.discovery_runs r set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 from candidates c where r.id=c.id returning r.*;
end $$;

create function public.lease_serper_campaign_page(p_org uuid,p_campaign uuid)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
 update public.discovery_campaigns set state='paused',last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED'
  where org_id=p_org and id=p_campaign and state in ('queued','running') and exists(
   select 1 from public.discovery_runs where campaign_id=p_campaign and org_id=p_org
    and state='leased' and lease_until<now());
 update public.discovery_runs set state='failed',lease_token=null,lease_until=null,
  last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED',completed_at=now()
  where org_id=p_org and campaign_id=p_campaign and state='leased' and lease_until<now();
 return query with candidate as (
  select r.id from public.discovery_runs r
  join public.discovery_campaigns c on c.id=r.campaign_id and c.org_id=r.org_id
  join public.discovery_targeting t on t.org_id=r.org_id
  join public.organizations o on o.id=r.org_id
  where r.org_id=p_org and r.campaign_id=p_campaign and r.state='queued' and r.next_run_at<=now()
   and c.state in ('queued','running') and t.serper_discovery_enabled
   and t.max_new_prospects>=c.target_count and o.research_provider='serper'
   and o.research_monthly_credit_cap>0
  for update of r skip locked limit 1
 ) update public.discovery_runs r set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 from candidate c where r.id=c.id returning r.*;
end $$;

create function public.finish_discovery_campaign_page(p_run uuid,p_token uuid,p_observations integer,
 p_new_businesses integer,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs; campaign public.discovery_campaigns; new_total integer;
begin
 select * into run from public.discovery_runs where id=p_run and provider='serper' and state='leased'
  and lease_token=p_token and lease_until>now() and campaign_id is not null for update;
 if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
 if p_observations not between 0 and run.requested_limit or p_new_businesses not between 0 and p_observations
  or length(coalesce(p_error,''))>80 then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
 select * into campaign from public.discovery_campaigns where id=run.campaign_id and org_id=run.org_id for update;
 perform public.finish_serper_discovery_run(p_run,p_token,p_observations,p_error);
 new_total:=campaign.new_businesses_count+p_new_businesses;
 update public.discovery_campaigns set pages_completed=pages_completed+1,
  observations_count=observations_count+p_observations,new_businesses_count=new_total,
  next_page=least(16,run.search_page+1),
  state=case when campaign.state='cancelled' then 'cancelled'
    when p_error is not null or p_observations=0 or p_new_businesses=0 then 'paused'
    when new_total>=campaign.target_count or run.search_page>=15 then 'completed'
    when campaign.credits_reserved>=campaign.max_credits then 'paused' else 'running' end,
  last_error_code=case when p_error is not null then p_error when p_observations=0 then 'NO_MORE_OBSERVATIONS'
    when p_new_businesses=0 then 'NO_NEW_BUSINESSES'
    when run.search_page>=15 and new_total<campaign.target_count then 'SEARCH_PAGE_LIMIT_SHORTFALL'
    when campaign.credits_reserved>=campaign.max_credits and new_total<campaign.target_count then 'CAMPAIGN_CREDIT_LIMIT' else null end,
  completed_at=case when campaign.state='cancelled' or new_total>=campaign.target_count or run.search_page>=15
    then now() else null end where id=campaign.id;
 if campaign.state<>'cancelled' and p_error is null and p_observations>0 and p_new_businesses>0 and new_total<campaign.target_count
  and run.search_page<15 and campaign.credits_reserved<campaign.max_credits then
  insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,target_city,target_country,
   campaign_id,search_mode,search_page,next_run_at)
  values(run.org_id,'serper','queued',least(10,campaign.target_count-new_total),campaign.target_industry,
   campaign.target_city,campaign.target_country,campaign.id,'paged_search',run.search_page+1,now()+interval '2 seconds');
 end if;
end $$;

create function public.cancel_discovery_campaign(p_org uuid,p_campaign uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 update public.discovery_campaigns set state='cancelled',completed_at=now(),last_error_code='OWNER_CANCELLED'
  where org_id=p_org and id=p_campaign and state in ('queued','running','paused');
 if not found then raise exception 'CAMPAIGN_NOT_CANCELLABLE'; end if;
 update public.discovery_runs set state='cancelled',completed_at=now()
  where org_id=p_org and campaign_id=p_campaign and state='queued';
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'discovery_campaign_cancelled','discovery_campaigns',p_campaign);
end $$;

revoke execute on function public.request_discovery_campaign(uuid,text,text,text,integer,integer,integer),
 public.finish_discovery_campaign_page(uuid,uuid,integer,integer,text),
 public.lease_serper_campaign_page(uuid,uuid),
 public.cancel_discovery_campaign(uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_discovery_campaign(uuid,text,text,text,integer,integer,integer),
 public.cancel_discovery_campaign(uuid,uuid) to authenticated;
grant execute on function public.finish_discovery_campaign_page(uuid,uuid,integer,integer,text) to service_role;
grant execute on function public.lease_serper_campaign_page(uuid,uuid) to service_role;
