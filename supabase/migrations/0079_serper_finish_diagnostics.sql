-- Finish diagnostics: preserve 0075/0056 semantics; persist diagnostics.
-- Applied after 0074/0075 by the migration runner order.

alter table public.discovery_runs add column if not exists last_diagnostics jsonb;

-- Replace the 0075/0056 functions in-place; a same-arity overload would leave
-- function resolution ambiguous and break every campaign/queue call site.
drop function if exists public.finish_serper_discovery_run(uuid,uuid,integer);
drop function if exists public.finish_serper_discovery_run(uuid,uuid,integer,text);
drop function if exists public.finish_discovery_campaign_page(uuid,uuid,integer,integer);
drop function if exists public.finish_discovery_campaign_page(uuid,uuid,integer,integer,text);

-- finish_serper_discovery_run: preserve 0075 semantics, add optional diagnostics.
create or replace function public.finish_serper_discovery_run(p_run uuid, p_token uuid, p_observations integer, p_error text default null, p_diagnostics jsonb default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs;
begin
  select * into run from public.discovery_runs where id = p_run and provider = 'serper' and state = 'leased'
   and lease_token = p_token and lease_until > now() for update;
  if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
  if p_observations not between 0 and run.requested_limit
   or (run.search_mode = 'deep' and p_observations > 3)
   or length(coalesce(p_error,'')) > 80
   then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
  if p_error is null and ((run.search_mode = 'paged_search' and run.reserved_credits <> 1)
   or (run.search_mode = 'deep' and run.reserved_credits <> 31))
   then raise exception 'DISCOVERY_CREDITS_NOT_RESERVED'; end if;
  if p_error is not null then
    if run.campaign_id is null and run.attempts < run.max_attempts then
      update public.discovery_runs set state='queued',last_error_code=p_error,
       next_run_at=now()+make_interval(secs=>least(3600,power(2,run.attempts)::integer*30)),
       lease_token=null,lease_until=null,last_diagnostics=coalesce(p_diagnostics,last_diagnostics) where id=p_run;
    else
      update public.discovery_runs set state='failed',last_error_code=p_error,
       lease_token=null,lease_until=null,completed_at=now(),last_diagnostics=coalesce(p_diagnostics,last_diagnostics) where id=p_run;
    end if;
  else
    update public.discovery_runs set state='completed',observations_count=p_observations,
     last_error_code=null,lease_token=null,lease_until=null,completed_at=now(),last_diagnostics=coalesce(p_diagnostics,last_diagnostics) where id=p_run;
  end if;
end $$;
create or replace function public.finish_discovery_campaign_page(p_run uuid, p_token uuid, p_observations integer,
 p_new_businesses integer, p_error text default null, p_diagnostics jsonb default null)
returns void language plpgsql security definer set search_path='' as $$
declare run public.discovery_runs; campaign public.discovery_campaigns; new_total integer;
begin
  select * into run from public.discovery_runs where id = p_run and provider = 'serper' and state = 'leased'
   and lease_token = p_token and lease_until > now() and campaign_id is not null for update;
  if not found then raise exception 'DISCOVERY_LEASE_INVALID'; end if;
  if p_observations not between 0 and run.requested_limit or p_new_businesses not between 0 and p_observations
   or length(coalesce(p_error,'')) > 80
   then raise exception 'INVALID_DISCOVERY_RESULT'; end if;
  select * into campaign from public.discovery_campaigns where id=run.campaign_id and org_id=run.org_id for update;
  perform public.finish_serper_discovery_run(p_run,p_token,p_observations,p_error,p_diagnostics);
  new_total := campaign.new_businesses_count + p_new_businesses;
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
   values(run.org_id,'serper','queued',least(10,campaign.target_count-new_total),
     campaign.target_industry,campaign.target_city,campaign.target_country,campaign.id,'paged_search',run.search_page+1,now()+interval '2 seconds');
  end if;
end $$;


revoke execute on function public.finish_serper_discovery_run(uuid,uuid,integer,text,jsonb) from public,anon;
revoke execute on function public.finish_discovery_campaign_page(uuid,uuid,integer,integer,text,jsonb) from public,anon;
grant execute on function public.finish_serper_discovery_run(uuid,uuid,integer,text,jsonb) to authenticated,service_role;
grant execute on function public.finish_discovery_campaign_page(uuid,uuid,integer,integer,text,jsonb) to authenticated,service_role;
