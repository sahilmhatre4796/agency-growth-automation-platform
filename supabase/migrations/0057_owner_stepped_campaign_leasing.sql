-- Legacy background leasing must never advance an owner-stepped, metered
-- campaign. Only lease_serper_campaign_page may acquire campaign pages.
create or replace function public.lease_serper_discovery_runs(p_limit integer default 1)
returns setof public.discovery_runs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 2 then raise exception 'INVALID_BATCH_SIZE'; end if;
 update public.discovery_runs set state='failed',lease_token=null,lease_until=null,
  last_error_code='LEASE_EXPIRED_REVIEW_REQUIRED',completed_at=now()
  where provider='serper' and campaign_id is null and state='leased' and lease_until<now();
 return query with candidates as (
  select r.id from public.discovery_runs r
  join public.discovery_targeting t on t.org_id=r.org_id
  join public.organizations o on o.id=r.org_id
  where r.provider='serper' and r.campaign_id is null and r.state='queued' and r.next_run_at<=now()
   and t.serper_discovery_enabled and t.max_new_prospects>=r.requested_limit
   and o.research_provider='serper' and o.research_monthly_credit_cap>0
  order by r.created_at,r.id for update of r skip locked limit p_limit
 ) update public.discovery_runs r set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 from candidates c where r.id=c.id returning r.*;
end $$;
