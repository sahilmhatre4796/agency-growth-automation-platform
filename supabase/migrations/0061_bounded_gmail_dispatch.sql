-- A dispatch reservation is counted even if the worker crashes before saving a receipt.
-- This migration does not enable Gmail or change any existing account/campaign flags.
alter table public.leads add column outreach_timezone text;
alter table public.leads add column outreach_timezone_reviewed_at timestamptz;
alter table public.leads add column outreach_timezone_reviewed_by uuid;
alter table public.leads add column outreach_timezone_reason text;
alter table public.leads add constraint leads_outreach_timezone_reviewer_fk
  foreign key(outreach_timezone_reviewed_by) references auth.users(id);
alter table public.gmail_account_settings add column cooldown_minutes integer not null default 10
  check(cooldown_minutes between 10 and 1440);

create function public.configure_gmail_cooldown(p_org uuid,p_connection uuid,p_minutes integer)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if p_minutes not between 10 and 1440 then raise exception 'INVALID_COOLDOWN'; end if;
 update public.gmail_account_settings set cooldown_minutes=p_minutes,updated_at=now()
  where org_id=p_org and connection_id=p_connection;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'gmail_cooldown_updated','external_connections',p_connection);
end $$;
revoke execute on function public.configure_gmail_cooldown(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.configure_gmail_cooldown(uuid,uuid,integer) to authenticated;

create function public.review_lead_outreach_timezone(p_org uuid,p_lead uuid,p_timezone text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone)
   or length(trim(coalesce(p_reason,'')))<10 then raise exception 'TIMEZONE_REVIEW_REQUIRED'; end if;
 update public.leads set outreach_timezone=p_timezone,outreach_timezone_reviewed_at=now(),
   outreach_timezone_reviewed_by=auth.uid(),outreach_timezone_reason=trim(p_reason)
 where org_id=p_org and id=p_lead and not is_demo
   and lower(trim(coalesce(country,''))) not in ('india','in','bharat');
 if not found then raise exception 'LEAD_NOT_ELIGIBLE'; end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'lead_outreach_timezone_reviewed','leads',p_lead);
end $$;
revoke execute on function public.review_lead_outreach_timezone(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_lead_outreach_timezone(uuid,uuid,text,text) to authenticated;

create table public.email_send_attempts(
 id uuid primary key default gen_random_uuid(), org_id uuid not null,
 outbox_id uuid not null, sender_connection_id uuid not null,
 attempted_at timestamptz not null default now(),
 foreign key(org_id,outbox_id) references public.email_outbox(org_id,id),
 foreign key(org_id,sender_connection_id) references public.external_connections(org_id,id)
);
create index email_send_attempts_org_day on public.email_send_attempts(org_id,attempted_at desc);
create index email_send_attempts_account on public.email_send_attempts(sender_connection_id,attempted_at desc);
alter table public.email_send_attempts enable row level security;
create policy email_send_attempts_admin_read on public.email_send_attempts for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.email_send_attempts from public,anon,authenticated;
grant select on public.email_send_attempts to authenticated;
grant all on public.email_send_attempts to service_role;

create function private.guard_email_reporting_timezone()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.email_timezone is distinct from new.email_timezone and (
   exists(select 1 from public.email_send_attempts a where a.org_id=old.id
     and a.attempted_at>now()-interval '48 hours')
   or exists(select 1 from public.email_outbox o where o.org_id=old.id and o.state='sent'
     and o.updated_at>now()-interval '48 hours'))
 then raise exception 'REPORTING_TIMEZONE_CHANGE_REQUIRES_REVIEW'; end if;
 return new;
end $$;
revoke execute on function private.guard_email_reporting_timezone() from public,anon,authenticated,service_role;
create trigger guard_email_reporting_timezone before update of email_timezone on public.organizations
for each row execute function private.guard_email_reporting_timezone();

-- One org lock serializes the global reservation; one account lock serializes its cooldown.
-- At most one reservation per organization per minute also prevents ten-account bursts.
create or replace function public.lease_email_outbox(p_limit integer default 10)
returns setof public.email_outbox language plpgsql security definer set search_path='' as $$
declare org public.organizations; candidate public.email_outbox; setting public.gmail_account_settings;
  local_time timestamp; reserved bigint; leased integer:=0;
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 update public.email_outbox set state='uncertain',last_error_code='LEASE_EXPIRED_UNCERTAIN',
  lease_token=null,lease_until=null,updated_at=now()
 where state='leased' and lease_until<now();
 update public.email_outbox set state='failed',last_error_code='MAX_ATTEMPTS',
  lease_token=null,lease_until=null,updated_at=now()
 where state='queued' and attempts>=3;
 for org in select g.* from public.organizations g
   where not g.outbound_paused and g.email_live_approved and g.email_daily_cap>0
     and exists(select 1 from public.email_outbox o where o.org_id=g.id and o.state='queued' and o.scheduled_at<=now())
   order by g.id for update of g skip locked loop
  if leased>=p_limit then exit; end if;
  select (select count(*) from public.email_send_attempts a where a.org_id=org.id
    and (a.attempted_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date)
   + (select count(*) from public.email_outbox o where o.org_id=org.id and o.state='sent'
    and (o.updated_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date
   and not exists(select 1 from public.email_send_attempts a where a.outbox_id=o.id
     and (a.attempted_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date)) into reserved;
  if reserved>=least(org.email_daily_cap,500) then continue; end if;
  if ((now()+interval '2 minutes') at time zone org.email_timezone)::date
    <> (now() at time zone org.email_timezone)::date then continue; end if;
  if exists(select 1 from public.email_send_attempts a where a.org_id=org.id
    and a.attempted_at>now()-interval '1 minute') then continue; end if;
  if exists(select 1 from public.email_outbox o where o.org_id=org.id and o.state='sent'
    and o.updated_at>now()-interval '1 minute'
    and not exists(select 1 from public.email_send_attempts a where a.outbox_id=o.id)) then continue; end if;
  for candidate in select o.* from public.email_outbox o
    join public.leads l on l.org_id=o.org_id and l.id=o.lead_id
    join public.gmail_account_settings s on s.org_id=o.org_id and s.connection_id=o.sender_connection_id
    where o.org_id=org.id and o.state='queued' and o.scheduled_at<=now() and o.attempts<3
      and l.outreach_timezone is not null and l.outreach_timezone_reviewed_at is not null
      and exists(select 1 from pg_timezone_names z where z.name=l.outreach_timezone)
      and not l.is_demo and lower(trim(coalesce(l.country,''))) not in ('india','in','bharat')
      and s.send_enabled and not s.paused and s.daily_cap>0 and s.monthly_cap>0
      and (s.send_after is null or s.send_after<=now())
      and not exists(select 1 from public.email_send_attempts a
        where a.sender_connection_id=s.connection_id and a.attempted_at>now()-make_interval(mins=>s.cooldown_minutes))
      and not exists(select 1 from public.email_outbox prior where prior.sender_connection_id=s.connection_id
        and prior.state='sent' and prior.updated_at>now()-make_interval(mins=>s.cooldown_minutes)
        and not exists(select 1 from public.email_send_attempts a where a.outbox_id=prior.id))
    order by o.scheduled_at,o.id for update of o skip locked loop
   select * into setting from public.gmail_account_settings
    where connection_id=candidate.sender_connection_id and org_id=org.id for update;
   if not found or not setting.send_enabled or setting.paused or setting.daily_cap=0
     or setting.monthly_cap=0 or (setting.send_after is not null and setting.send_after>now())
     or exists(select 1 from public.email_send_attempts a
       where a.sender_connection_id=setting.connection_id and a.attempted_at>now()-make_interval(mins=>setting.cooldown_minutes))
     or exists(select 1 from public.email_outbox prior where prior.sender_connection_id=setting.connection_id
       and prior.state='sent' and prior.updated_at>now()-make_interval(mins=>setting.cooldown_minutes)
       and not exists(select 1 from public.email_send_attempts a where a.outbox_id=prior.id)) then continue; end if;
   if (now() at time zone setting.timezone)::time<setting.window_start
     or (now() at time zone setting.timezone)::time>=setting.window_end then continue; end if;
   select (select count(*) from public.email_send_attempts a
     where a.sender_connection_id=setting.connection_id
     and (a.attempted_at at time zone setting.timezone)::date=(now() at time zone setting.timezone)::date)
     + (select count(*) from public.email_outbox prior where prior.sender_connection_id=setting.connection_id
       and prior.state='sent' and (prior.updated_at at time zone setting.timezone)::date
         =(now() at time zone setting.timezone)::date
       and not exists(select 1 from public.email_send_attempts a where a.outbox_id=prior.id
         and (a.attempted_at at time zone setting.timezone)::date=(now() at time zone setting.timezone)::date)) into reserved;
   if reserved>=setting.daily_cap then continue; end if;
   select count(*) into reserved from public.email_send_attempts a
     where a.sender_connection_id=setting.connection_id
     and date_trunc('month',a.attempted_at at time zone setting.timezone)
       =date_trunc('month',now() at time zone setting.timezone);
   if reserved>=setting.monthly_cap then continue; end if;
   select now() at time zone l.outreach_timezone into local_time
    from public.leads l where l.org_id=org.id and l.id=candidate.lead_id;
   if extract(isodow from local_time)>5 or local_time::time<time '09:00'
     or local_time::time>=time '17:00' then continue; end if;
   update public.email_outbox set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+interval '90 seconds',scheduled_at=now(),updated_at=now()
    where id=candidate.id returning * into candidate;
   insert into public.email_send_attempts(org_id,outbox_id,sender_connection_id)
    values(org.id,candidate.id,candidate.sender_connection_id);
   leased:=leased+1;
   return next candidate;
   exit;
  end loop;
 end loop;
end $$;
revoke execute on function public.lease_email_outbox(integer) from public,anon,authenticated;
grant execute on function public.lease_email_outbox(integer) to service_role;

-- Recheck the recipient's local window just before the provider request.
alter function public.check_email_send_policy(uuid,uuid,text) set schema private;
alter function private.check_email_send_policy(uuid,uuid,text) rename to check_email_send_policy_before_dispatch_window;
revoke execute on function private.check_email_send_policy_before_dispatch_window(uuid,uuid,text)
 from public,anon,authenticated,service_role;
create function public.check_email_send_policy(p_id uuid,p_token uuid,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare outgoing public.email_outbox; lead public.leads; org public.organizations;
  local_time timestamp; last_attempt timestamptz;
begin
 select * into outgoing from public.email_outbox where id=p_id and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'LEASE_INVALID'; end if;
 select * into org from public.organizations where id=outgoing.org_id;
 select max(a.attempted_at) into last_attempt from public.email_send_attempts a
  where a.outbox_id=p_id and a.sender_connection_id=outgoing.sender_connection_id;
 if last_attempt is null or (last_attempt at time zone org.email_timezone)::date
    <> (now() at time zone org.email_timezone)::date
    or ((now()+interval '2 minutes') at time zone org.email_timezone)::date
       <> (now() at time zone org.email_timezone)::date then
  update public.email_outbox set state='queued',lease_token=null,lease_until=null,
   scheduled_at=now()+interval '2 minutes',last_error_code='DAILY_BOUNDARY_BACKOFF',updated_at=now()
   where id=p_id;
  return 'backoff';
 end if;
 select * into lead from public.leads where org_id=outgoing.org_id and id=outgoing.lead_id;
 if lead.outreach_timezone is null or lead.outreach_timezone_reviewed_at is null
   or not exists(select 1 from pg_timezone_names z where z.name=lead.outreach_timezone) then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,
   last_error_code='RECIPIENT_TIMEZONE_REVIEW',updated_at=now() where id=p_id;
  return 'held';
 end if;
 local_time:=now() at time zone lead.outreach_timezone;
 if extract(isodow from local_time)>5 or local_time::time<time '09:00'
   or local_time::time>=time '17:00' then
  update public.email_outbox set state='queued',lease_token=null,lease_until=null,
   last_error_code='RECIPIENT_OUTSIDE_WINDOW',updated_at=now() where id=p_id;
  return 'backoff';
 end if;
 return private.check_email_send_policy_before_dispatch_window(p_id,p_token,p_identifier_hash);
end $$;
revoke execute on function public.check_email_send_policy(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.check_email_send_policy(uuid,uuid,text) to service_role;

create function public.gmail_dispatch_summary(p_org uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare org public.organizations; attempts_today bigint; legacy_sent bigint; sent_today bigint;
  inflight bigint; queued bigint; held bigint; account_status jsonb;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select * into org from public.organizations where id=p_org;
 if not found then raise exception 'ORGANIZATION_NOT_FOUND'; end if;
 select count(*) into attempts_today from public.email_send_attempts a where a.org_id=p_org
   and (a.attempted_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date;
 select count(*) into legacy_sent from public.email_outbox o where o.org_id=p_org and o.state='sent'
   and (o.updated_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date
   and not exists(select 1 from public.email_send_attempts a where a.outbox_id=o.id
     and (a.attempted_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date);
 select count(*) into sent_today from public.email_outbox o where o.org_id=p_org and o.state='sent'
   and (o.updated_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date;
 select count(*) into inflight from public.email_outbox o where o.org_id=p_org and o.state='leased';
 select count(*) into queued from public.email_outbox o where o.org_id=p_org and o.state='queued';
 select count(*) into held from public.email_outbox o where o.org_id=p_org and o.state in ('held','uncertain');
 select coalesce(jsonb_agg(jsonb_build_object('connection_id',s.connection_id,
   'paused',s.paused,'send_enabled',s.send_enabled,'daily_cap',s.daily_cap,
   'cooldown_minutes',s.cooldown_minutes,
   'last_attempt_at',(select max(a.attempted_at) from public.email_send_attempts a
     where a.sender_connection_id=s.connection_id),
   'cooldown_until',(select max(a.attempted_at)+make_interval(mins=>s.cooldown_minutes) from public.email_send_attempts a
     where a.sender_connection_id=s.connection_id)) order by s.connection_id),'[]'::jsonb)
   into account_status from public.gmail_account_settings s where s.org_id=p_org;
 return jsonb_build_object('configured_daily_cap',org.email_daily_cap,'absolute_daily_ceiling',500,
   'reporting_timezone',org.email_timezone,'sent_today',sent_today,
   'attempt_reservations_today',attempts_today,'inflight',inflight,
   'remaining_capacity',greatest(0,least(500,org.email_daily_cap)-attempts_today-legacy_sent),
   'queued',queued,'held_or_uncertain',held,'outbound_paused',org.outbound_paused,
   'accounts',account_status);
end $$;
revoke execute on function public.gmail_dispatch_summary(uuid) from public,anon,authenticated;
grant execute on function public.gmail_dispatch_summary(uuid) to authenticated;
