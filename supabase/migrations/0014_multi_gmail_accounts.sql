-- Add independent Gmail identities without changing existing connection IDs.
alter table public.organizations
  add column email_daily_cap integer not null default 0 check (email_daily_cap between 0 and 10000),
  add column email_monthly_cap integer not null default 0 check (email_monthly_cap between 0 and 100000),
  add column email_timezone text not null default 'Asia/Kolkata';
alter table public.external_connections add column last_error_code text;
alter table private.oauth_states add column expected_connection_id uuid;
alter table private.oauth_states add constraint oauth_expected_org_fk
  foreign key(org_id,expected_connection_id) references public.external_connections(org_id,id);

-- All existing Gmail rows receive zero-cap, paused settings. No migration sends mail.
create table public.gmail_account_settings(
  org_id uuid not null,
  connection_id uuid primary key,
  sender_name text not null default 'ChainCraft Studio' check(length(sender_name) between 1 and 120 and sender_name !~ '[\r\n]'),
  signature text not null default '' check(length(signature)<=1000),
  timezone text not null default 'Asia/Kolkata',
  window_start time not null default '10:00',
  window_end time not null default '17:00',
  daily_cap integer not null default 0 check(daily_cap between 0 and 500),
  monthly_cap integer not null default 0 check(monthly_cap between 0 and 10000),
  send_enabled boolean not null default false,
  paused boolean not null default true,
  send_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(window_end>window_start),
  foreign key(org_id,connection_id) references public.external_connections(org_id,id) on delete cascade
);
insert into public.gmail_account_settings(org_id,connection_id)
  select org_id,id from public.external_connections where provider='gmail';
create table public.gmail_sync_cursors(
  org_id uuid not null,
  connection_id uuid primary key,
  history_id text,
  last_inbox_sync_at timestamptz,
  last_sent_sync_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  next_run_at timestamptz,
  foreign key(org_id,connection_id) references public.external_connections(org_id,id) on delete cascade
);
insert into public.gmail_sync_cursors(org_id,connection_id)
  select org_id,id from public.external_connections where provider='gmail';

create table public.campaign_sender_policies(
  org_id uuid not null,
  campaign_id uuid primary key,
  mode text not null default 'single' check(mode in ('single','selected','all_enabled','manual')),
  single_connection_id uuid,
  account_daily_cap integer not null default 0 check(account_daily_cap between 0 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(org_id,campaign_id) references public.campaigns(org_id,id) on delete cascade,
  foreign key(org_id,single_connection_id) references public.external_connections(org_id,id),
  check((mode='single')=(single_connection_id is not null))
);
create table public.campaign_sender_accounts(
  org_id uuid not null,
  campaign_id uuid not null,
  connection_id uuid not null,
  daily_cap integer not null default 0 check(daily_cap between 0 and 500),
  enabled boolean not null default false,
  primary key(campaign_id,connection_id),
  foreign key(org_id,campaign_id) references public.campaigns(org_id,id) on delete cascade,
  foreign key(org_id,connection_id) references public.external_connections(org_id,id)
);
create table public.lead_sender_assignments(
  org_id uuid not null,
  campaign_id uuid not null,
  lead_id uuid not null,
  connection_id uuid not null,
  assigned_by uuid not null,
  assigned_at timestamptz not null default now(),
  primary key(campaign_id,lead_id),
  foreign key(org_id,campaign_id) references public.campaigns(org_id,id) on delete cascade,
  foreign key(org_id,lead_id) references public.leads(org_id,id),
  foreign key(org_id,connection_id) references public.external_connections(org_id,id),
  foreign key(org_id,assigned_by) references public.memberships(org_id,user_id)
);

alter table public.gmail_account_settings enable row level security;
alter table public.gmail_sync_cursors enable row level security;
alter table public.campaign_sender_policies enable row level security;
alter table public.campaign_sender_accounts enable row level security;
alter table public.lead_sender_assignments enable row level security;
create policy gmail_settings_read on public.gmail_account_settings for select to authenticated using(private.is_org_admin(org_id));
create policy gmail_sync_read on public.gmail_sync_cursors for select to authenticated using(private.is_org_admin(org_id));
create policy sender_policy_read on public.campaign_sender_policies for select to authenticated using(private.is_org_admin(org_id));
create policy sender_pool_read on public.campaign_sender_accounts for select to authenticated using(private.is_org_admin(org_id));
create policy sender_assignment_read on public.lead_sender_assignments for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.gmail_account_settings,public.gmail_sync_cursors,public.campaign_sender_policies,public.campaign_sender_accounts,public.lead_sender_assignments from public,anon,authenticated;
grant select on public.gmail_account_settings,public.gmail_sync_cursors,public.campaign_sender_policies,public.campaign_sender_accounts,public.lead_sender_assignments to authenticated;
grant all on public.gmail_account_settings,public.gmail_sync_cursors,public.campaign_sender_policies,public.campaign_sender_accounts,public.lead_sender_assignments to service_role;

-- The old OAuth callback keeps its signature; Gmail now locks the organization
-- before counting and refuses duplicates rather than silently replacing tokens.
create or replace function public.save_oauth_connection(p_org uuid,p_provider text,p_account text,p_scopes text[],p_ciphertext bytea,p_iv bytea,p_expires timestamptz,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare cid uuid; existing public.external_connections;
begin
 if p_provider not in ('gmail','calendar') or not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') or octet_length(p_iv)<>12 then raise exception 'FORBIDDEN'; end if;
 if p_provider='gmail' then
  if p_account !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'INVALID_ACCOUNT'; end if;
  perform 1 from public.organizations where id=p_org for update;
  select * into existing from public.external_connections where provider='gmail' and lower(provider_account_id)=lower(p_account) for update;
  if found then
   if existing.org_id<>p_org then raise exception 'ACCOUNT_ORGANIZATION_CONFLICT'; end if;
   if existing.state='connected' then raise exception 'ACCOUNT_ALREADY_CONNECTED'; end if;
   if (select count(*) from public.external_connections where org_id=p_org and provider='gmail' and state='connected')>=10 then raise exception 'GMAIL_CAPACITY_REACHED'; end if;
   cid:=existing.id;
   update public.external_connections set provider_account_id=lower(p_account),state='connected',verified_at=now(),scopes=p_scopes,last_error_code=null where id=cid;
  else
   if (select count(*) from public.external_connections where org_id=p_org and provider='gmail' and state='connected')>=10 then raise exception 'GMAIL_CAPACITY_REACHED'; end if;
   insert into public.external_connections(org_id,provider,provider_account_id,state,verified_at,scopes)
     values(p_org,'gmail',lower(p_account),'connected',now(),p_scopes) returning id into cid;
  end if;
  insert into public.gmail_account_settings(org_id,connection_id) values(p_org,cid) on conflict(connection_id) do update set paused=true,send_enabled=false,updated_at=now();
  insert into public.gmail_sync_cursors(org_id,connection_id) values(p_org,cid) on conflict(connection_id) do nothing;
 else
  insert into public.external_connections(org_id,provider,provider_account_id,state,verified_at,scopes) values(p_org,p_provider,p_account,'connected',now(),p_scopes)
    on conflict(provider,provider_account_id) do update set state='connected',verified_at=now(),scopes=excluded.scopes where public.external_connections.org_id=p_org returning id into cid;
  if cid is null then raise exception 'ACCOUNT_ORGANIZATION_CONFLICT'; end if;
 end if;
 insert into private.oauth_secrets(connection_id,ciphertext,iv,expires_at) values(cid,p_ciphertext,p_iv,p_expires)
   on conflict(connection_id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,expires_at=excluded.expires_at,updated_at=now();
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,p_actor,'google_connected','external_connections',cid);
 return cid;
end $$;

create function public.store_oauth_state_for_connection(p_hash text,p_org uuid,p_user uuid,p_profile text,p_ciphertext bytea,p_iv bytea,p_redirect text,p_connection uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_profile<>'mail' or not exists(select 1 from public.external_connections where id=p_connection and org_id=p_org and provider='gmail') then raise exception 'INVALID_RECONNECT_TARGET'; end if;
 perform public.store_oauth_state(p_hash,p_org,p_user,p_profile,p_ciphertext,p_iv,p_redirect);
 update private.oauth_states set expected_connection_id=p_connection where state_hash=p_hash;
end $$;

create function public.reconnect_oauth_connection(p_org uuid,p_connection uuid,p_account text,p_scopes text[],p_ciphertext bytea,p_iv bytea,p_expires timestamptz,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.external_connections;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') or octet_length(p_iv)<>12 then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.organizations where id=p_org for update;
 select * into c from public.external_connections where id=p_connection and org_id=p_org and provider='gmail' for update;
 if not found or lower(c.provider_account_id)<>lower(p_account) then raise exception 'RECONNECT_ACCOUNT_MISMATCH'; end if;
 if c.state<>'connected' and (select count(*) from public.external_connections where org_id=p_org and provider='gmail' and state='connected')>=10 then raise exception 'GMAIL_CAPACITY_REACHED'; end if;
 update public.external_connections set state='connected',verified_at=now(),scopes=p_scopes,last_error_code=null where id=p_connection;
 insert into private.oauth_secrets(connection_id,ciphertext,iv,expires_at) values(p_connection,p_ciphertext,p_iv,p_expires)
  on conflict(connection_id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,expires_at=excluded.expires_at,updated_at=now();
 update public.gmail_account_settings set paused=true,send_enabled=false,updated_at=now() where connection_id=p_connection and org_id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,p_actor,'gmail_reconnected','external_connections',p_connection);
 return p_connection;
end $$;

create function public.configure_gmail_account(p_org uuid,p_connection uuid,p_sender_name text,p_signature text,p_timezone text,p_daily_cap integer,p_monthly_cap integer,p_window_start time,p_window_end time,p_enabled boolean,p_paused boolean)
returns void language plpgsql security definer set search_path='' as $$
declare c public.external_connections;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select * into c from public.external_connections where id=p_connection and org_id=p_org and provider='gmail' for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if p_enabled and (c.state<>'connected' or not ('https://www.googleapis.com/auth/gmail.send'=any(c.scopes))) then raise exception 'SEND_SCOPE_REQUIRED'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'INVALID_TIMEZONE'; end if;
 update public.gmail_account_settings set sender_name=p_sender_name,signature=p_signature,timezone=p_timezone,daily_cap=p_daily_cap,monthly_cap=p_monthly_cap,window_start=p_window_start,window_end=p_window_end,send_enabled=p_enabled,paused=p_paused,updated_at=now() where org_id=p_org and connection_id=p_connection;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'gmail_settings_updated','external_connections',p_connection);
end $$;

create function public.configure_campaign_senders(p_org uuid,p_campaign uuid,p_mode text,p_single uuid,p_pool uuid[],p_cap integer)
returns void language plpgsql security definer set search_path='' as $$
declare account uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.campaigns where id=p_campaign and org_id=p_org and channel='email' and state in ('draft','paused') for update;
 if not found then raise exception 'CAMPAIGN_NOT_EDITABLE'; end if;
 if p_mode not in ('single','selected','all_enabled','manual') or coalesce(array_length(p_pool,1),0)>10 or p_cap<0 or p_cap>500 then raise exception 'INVALID_POLICY'; end if;
 if (p_mode='single')<>(p_single is not null) then raise exception 'INVALID_SINGLE_ACCOUNT'; end if;
 if p_single is not null and not exists(select 1 from public.external_connections where id=p_single and org_id=p_org and provider='gmail') then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 if exists(select 1 from unnest(coalesce(p_pool,'{}'::uuid[])) x where not exists(select 1 from public.external_connections where id=x and org_id=p_org and provider='gmail')) then raise exception 'INVALID_POOL_ACCOUNT'; end if;
 insert into public.campaign_sender_policies(org_id,campaign_id,mode,single_connection_id,account_daily_cap) values(p_org,p_campaign,p_mode,p_single,p_cap)
 on conflict(campaign_id) do update set mode=excluded.mode,single_connection_id=excluded.single_connection_id,account_daily_cap=excluded.account_daily_cap,updated_at=now();
 delete from public.campaign_sender_accounts where org_id=p_org and campaign_id=p_campaign;
 foreach account in array coalesce(p_pool,'{}'::uuid[]) loop
  insert into public.campaign_sender_accounts(org_id,campaign_id,connection_id,daily_cap,enabled) values(p_org,p_campaign,account,p_cap,true) on conflict do nothing;
 end loop;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'campaign_sender_policy_updated','campaigns',p_campaign);
end $$;

create function public.assign_lead_sender(p_org uuid,p_campaign uuid,p_lead uuid,p_connection uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if not exists(select 1 from public.campaign_sender_policies where org_id=p_org and campaign_id=p_campaign and mode='manual') or not exists(select 1 from public.external_connections where org_id=p_org and id=p_connection and provider='gmail') then raise exception 'INVALID_ASSIGNMENT'; end if;
 insert into public.lead_sender_assignments(org_id,campaign_id,lead_id,connection_id,assigned_by) values(p_org,p_campaign,p_lead,p_connection,auth.uid())
 on conflict(campaign_id,lead_id) do update set connection_id=excluded.connection_id,assigned_by=excluded.assigned_by,assigned_at=now();
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'lead_sender_assigned','leads',p_lead);
end $$;

revoke execute on function public.save_oauth_connection(uuid,text,text,text[],bytea,bytea,timestamptz,uuid),public.reconnect_oauth_connection(uuid,uuid,text,text[],bytea,bytea,timestamptz,uuid),public.store_oauth_state_for_connection(text,uuid,uuid,text,bytea,bytea,text,uuid),public.configure_gmail_account(uuid,uuid,text,text,text,integer,integer,time,time,boolean,boolean),public.configure_campaign_senders(uuid,uuid,text,uuid,uuid[],integer),public.assign_lead_sender(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_oauth_connection(uuid,text,text,text[],bytea,bytea,timestamptz,uuid),public.reconnect_oauth_connection(uuid,uuid,text,text[],bytea,bytea,timestamptz,uuid),public.store_oauth_state_for_connection(text,uuid,uuid,text,bytea,bytea,text,uuid) to service_role;
grant execute on function public.configure_gmail_account(uuid,uuid,text,text,text,integer,integer,time,time,boolean,boolean),public.configure_campaign_senders(uuid,uuid,text,uuid,uuid[],integer),public.assign_lead_sender(uuid,uuid,uuid,uuid) to authenticated;
