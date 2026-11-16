-- Keep approved copy and fixed sender when a queued send misses its scheduled day.
-- This does not enable a worker or make a provider request. Only service_role may call it.
create function public.rollover_email_backlog(p_org uuid, p_limit integer default 10)
returns integer language plpgsql security definer set search_path='' as $$
declare org public.organizations; outgoing public.email_outbox; lead public.leads;
  account public.gmail_account_settings; campaign public.campaigns;
  target_date date; candidate_at timestamptz; local_sender timestamp;
  reserved bigint; day_offset integer; half_hour integer; moved integer:=0;
  rescheduled boolean;
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 select * into org from public.organizations where id=p_org for update;
 if not found then raise exception 'ORGANIZATION_NOT_FOUND'; end if;
 if org.outbound_paused or not org.email_live_approved or org.email_daily_cap=0 then return 0; end if;
 for outgoing in select o.* from public.email_outbox o
   where o.org_id=p_org and o.state='queued'
     and (o.scheduled_at at time zone org.email_timezone)::date
       < (now() at time zone org.email_timezone)::date
   order by o.scheduled_at,o.id for update of o skip locked limit p_limit loop
  select * into lead from public.leads where org_id=p_org and id=outgoing.lead_id;
  select * into account from public.gmail_account_settings
    where org_id=p_org and connection_id=outgoing.sender_connection_id;
  select * into campaign from public.campaigns where org_id=p_org and id=outgoing.campaign_id;
  if lead.id is null or lead.is_demo or lead.outreach_timezone is null
    or lead.outreach_timezone_reviewed_at is null
    or lower(trim(coalesce(lead.country,''))) in ('india','in','bharat')
    or account.connection_id is null or account.paused or not account.send_enabled
    or campaign.id is null or campaign.state<>'active' then continue; end if;
  target_date:=(now() at time zone lead.outreach_timezone)::date;
  rescheduled:=false;
  for day_offset in 0..29 loop
   if extract(isodow from target_date)<=5 then
    for half_hour in 0..15 loop
     candidate_at:=(target_date + time '09:00' + make_interval(mins=>half_hour*30))
       at time zone lead.outreach_timezone;
     local_sender:=candidate_at at time zone account.timezone;
     if candidate_at<=now()+interval '5 minutes' or
       local_sender::time<account.window_start or local_sender::time>=account.window_end or
       (account.send_after is not null and account.send_after>candidate_at) then continue; end if;
     select count(*) into reserved from public.email_outbox o
      where o.org_id=p_org and o.state in ('queued','leased','uncertain','sent')
        and (o.scheduled_at at time zone org.email_timezone)::date
          =(candidate_at at time zone org.email_timezone)::date;
     if reserved>=least(org.email_daily_cap,500) then exit; end if;
     select count(*) into reserved from public.email_outbox o
      where o.org_id=p_org and o.campaign_id=campaign.id
        and o.state in ('queued','leased','uncertain','sent')
        and (o.scheduled_at at time zone org.email_timezone)::date
          =(candidate_at at time zone org.email_timezone)::date;
     if reserved>=campaign.daily_send_cap then exit; end if;
     select count(*) into reserved from public.email_outbox o
      where o.org_id=p_org and o.sender_connection_id=account.connection_id
        and o.state in ('queued','leased','uncertain','sent')
        and (o.scheduled_at at time zone account.timezone)::date
          =(candidate_at at time zone account.timezone)::date;
     if reserved>=account.daily_cap then exit; end if;
     update public.email_outbox set scheduled_at=candidate_at,
       last_error_code='BACKLOG_ROLLED_OVER',updated_at=now()
       where id=outgoing.id and org_id=p_org and state='queued';
     moved:=moved+1;
     rescheduled:=true;
     exit;
    end loop;
    if rescheduled then exit; end if;
   end if;
   target_date:=target_date+1;
  end loop;
 end loop;
 return moved;
end $$;
revoke execute on function public.rollover_email_backlog(uuid,integer) from public,anon,authenticated;
grant execute on function public.rollover_email_backlog(uuid,integer) to service_role;

create function public.email_backlog_candidates(p_org uuid, p_limit integer default 10)
returns table(draft_id uuid, lead_id uuid, contact_id uuid, approval_by uuid)
language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 return query select d.id,d.lead_id,d.contact_id,d.approval_by
   from public.outbound_drafts d
   where d.org_id=p_org and d.channel='email' and d.state='approved'
     and d.approval_by is not null and d.lead_id is not null and d.contact_id is not null
     and not exists(select 1 from public.email_outbox o where o.org_id=p_org and o.draft_id=d.id)
   order by d.approved_at,d.id limit p_limit;
end $$;
revoke execute on function public.email_backlog_candidates(uuid,integer) from public,anon,authenticated;
grant execute on function public.email_backlog_candidates(uuid,integer) to service_role;

create function public.gmail_backlog_summary(p_org uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare reporting_zone text; approved_count bigint; next_day_count bigint; future_count bigint;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select email_timezone into reporting_zone from public.organizations where id=p_org;
 if not found then raise exception 'ORGANIZATION_NOT_FOUND'; end if;
 select count(*) into approved_count from public.outbound_drafts d
   where d.org_id=p_org and d.channel='email' and d.state='approved'
     and not exists(select 1 from public.email_outbox o where o.org_id=p_org and o.draft_id=d.id);
 select count(*) into next_day_count from public.email_outbox
   where org_id=p_org and state='queued' and
     (scheduled_at at time zone reporting_zone)::date
       =(now() at time zone reporting_zone)::date+1;
 select count(*) into future_count from public.email_outbox
   where org_id=p_org and state='queued' and
     (scheduled_at at time zone reporting_zone)::date
       >(now() at time zone reporting_zone)::date;
 return jsonb_build_object('approved_backlog',approved_count,
   'next_day_queued',next_day_count,'future_queued',future_count);
end $$;
revoke execute on function public.gmail_backlog_summary(uuid) from public,anon,authenticated;
grant execute on function public.gmail_backlog_summary(uuid) to authenticated;
