-- Mail history and queue are scoped to the exact sender connection.
alter table public.organizations add column email_live_approved boolean not null default false;
alter table public.campaigns add column purpose text;
create table public.gmail_threads(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,connection_id uuid not null,
 provider_thread_id text not null,lead_id uuid,contact_id uuid,campaign_id uuid,
 subject text,last_message_at timestamptz not null default now(),created_at timestamptz not null default now(),
 unique(org_id,connection_id,id),unique(connection_id,provider_thread_id),
 foreign key(org_id,connection_id) references public.external_connections(org_id,id),
 foreign key(org_id,lead_id) references public.leads(org_id,id),
 foreign key(org_id,contact_id) references public.contacts(org_id,id),
 foreign key(org_id,campaign_id) references public.campaigns(org_id,id)
);
create table public.gmail_messages(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,connection_id uuid not null,thread_id uuid not null,
 provider_message_id text not null,rfc_message_id text,reply_to_id text,direction text not null check(direction in ('inbound','outbound')),
 subject text,body text check(length(body)<=10000),classification text not null default 'unknown'
   check(classification in ('unknown','interested','not_interested','meeting_request','opt_out','question')),
 occurred_at timestamptz not null,created_at timestamptz not null default now(),
 unique(connection_id,provider_message_id),
 foreign key(org_id,connection_id,thread_id) references public.gmail_threads(org_id,connection_id,id),
 foreign key(org_id,connection_id) references public.external_connections(org_id,id)
);
create index gmail_messages_account_date on public.gmail_messages(org_id,connection_id,occurred_at desc);
create table public.email_outbox(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,campaign_id uuid not null,draft_id uuid not null,
 lead_id uuid not null,contact_id uuid not null,sender_connection_id uuid not null,
 recipient_email text not null,subject text not null,body text not null,
 approved_sha256 text not null,sender_name text not null,idempotency_key text not null,
 state text not null default 'queued' check(state in ('queued','leased','held','uncertain','sent','failed','suppressed','cancelled')),
 scheduled_at timestamptz not null,attempts integer not null default 0 check(attempts between 0 and 10),
 lease_token uuid,lease_until timestamptz,last_error_code text,provider_message_id text,provider_thread_id text,reply_to_rfc_id text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(org_id,draft_id),unique(org_id,idempotency_key),unique(org_id,id),
 foreign key(org_id,campaign_id) references public.campaigns(org_id,id),
 foreign key(org_id,draft_id) references public.outbound_drafts(org_id,id),
 foreign key(org_id,lead_id,contact_id) references public.contacts(org_id,lead_id,id),
 foreign key(org_id,sender_connection_id) references public.external_connections(org_id,id)
);
create index email_outbox_due on public.email_outbox(state,scheduled_at) where state in ('queued','leased','uncertain');
create index email_outbox_account_date on public.email_outbox(org_id,sender_connection_id,scheduled_at);

alter table public.gmail_threads enable row level security;
alter table public.gmail_messages enable row level security;
alter table public.email_outbox enable row level security;
create policy gmail_threads_read on public.gmail_threads for select to authenticated using(private.is_org_admin(org_id));
create policy gmail_messages_read on public.gmail_messages for select to authenticated using(private.is_org_admin(org_id));
create policy email_outbox_read on public.email_outbox for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.gmail_threads,public.gmail_messages,public.email_outbox from public,anon,authenticated;
grant select on public.gmail_threads,public.gmail_messages,public.email_outbox to authenticated;
grant all on public.gmail_threads,public.gmail_messages,public.email_outbox to service_role;

create function public.create_email_campaign(p_org uuid,p_name text,p_purpose text)
returns uuid language plpgsql security definer set search_path='' as $$
declare cid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if length(trim(p_name)) not between 1 and 120 or length(trim(p_purpose)) not between 1 and 200 then raise exception 'INVALID_CAMPAIGN'; end if;
 insert into public.campaigns(org_id,name,channel,state,daily_send_cap,created_by,purpose)
 values(p_org,trim(p_name),'email','draft',0,auth.uid(),trim(p_purpose)) returning id into cid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'email_campaign_created','campaigns',cid);
 return cid;
end $$;
create function public.set_email_campaign_state(p_org uuid,p_campaign uuid,p_state text,p_daily_cap integer)
returns void language plpgsql security definer set search_path='' as $$
declare org public.organizations;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if p_state not in ('active','paused') or p_daily_cap not between 0 and 500 then raise exception 'INVALID_CAMPAIGN_STATE'; end if;
 select * into org from public.organizations where id=p_org for update;
 if p_state='active' and (not org.email_live_approved or org.outbound_paused or p_daily_cap=0) then raise exception 'LIVE_EMAIL_NOT_APPROVED'; end if;
 update public.campaigns set state=p_state,daily_send_cap=p_daily_cap where org_id=p_org and id=p_campaign and channel='email';
 if not found then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
 if p_state='paused' then update public.email_outbox set state='held',last_error_code='CAMPAIGN_PAUSED' where org_id=p_org and campaign_id=p_campaign and state='queued'; end if;
 if p_state='active' then update public.email_outbox set state='queued',last_error_code=null where org_id=p_org and campaign_id=p_campaign and state='held' and last_error_code='CAMPAIGN_PAUSED'; end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'email_campaign_'||p_state,'campaigns',p_campaign);
end $$;
create function public.pause_gmail_account(p_org uuid,p_connection uuid,p_paused boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.external_connections where id=p_connection and org_id=p_org and provider='gmail' for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 update public.gmail_account_settings set paused=p_paused,updated_at=now() where org_id=p_org and connection_id=p_connection;
 if p_paused then update public.email_outbox set state='held',last_error_code='ACCOUNT_PAUSED' where org_id=p_org and sender_connection_id=p_connection and state='queued'; end if;
 if not p_paused then update public.email_outbox set state='queued',last_error_code=null where org_id=p_org and sender_connection_id=p_connection and state='held' and last_error_code='ACCOUNT_PAUSED'; end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),case when p_paused then 'gmail_paused' else 'gmail_resumed' end,'external_connections',p_connection);
end $$;
create function public.disconnect_gmail_account(p_org uuid,p_connection uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 update public.external_connections set state='disconnected',last_error_code='DISCONNECTED_BY_OWNER' where id=p_connection and org_id=p_org and provider='gmail';
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 delete from private.oauth_secrets where connection_id=p_connection;
 update public.gmail_account_settings set paused=true,send_enabled=false,updated_at=now() where connection_id=p_connection and org_id=p_org;
 update public.email_outbox set state='held',last_error_code='ACCOUNT_DISCONNECTED',lease_token=null,lease_until=null where org_id=p_org and sender_connection_id=p_connection and state='queued';
 update public.email_outbox set state='uncertain',last_error_code='ACCOUNT_DISCONNECTED_DURING_SEND',lease_token=null,lease_until=null where org_id=p_org and sender_connection_id=p_connection and state='leased';
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'gmail_disconnected','external_connections',p_connection);
end $$;

create function public.gmail_account_summary(p_org uuid)
returns table(connection_id uuid,address text,sender_name text,signature text,connection_state text,verified_at timestamptz,scopes text[],send_enabled boolean,paused boolean,daily_cap integer,monthly_cap integer,timezone text,window_start time,window_end time,
 sent_today bigint,sent_month bigint,replies bigint,failed_sends bigint,assigned_campaigns bigint,last_sync_at timestamptz,last_error_code text)
language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 return query select c.id,c.provider_account_id,s.sender_name,s.signature,c.state,c.verified_at,c.scopes,s.send_enabled,s.paused,s.daily_cap,s.monthly_cap,s.timezone,s.window_start,s.window_end,
  (select count(*) from public.email_outbox o where o.org_id=p_org and o.sender_connection_id=c.id and o.state='sent' and (o.updated_at at time zone s.timezone)::date=(now() at time zone s.timezone)::date),
  (select count(*) from public.email_outbox o where o.org_id=p_org and o.sender_connection_id=c.id and o.state='sent' and date_trunc('month',o.updated_at at time zone s.timezone)=date_trunc('month',now() at time zone s.timezone)),
  (select count(*) from public.gmail_messages m where m.org_id=p_org and m.connection_id=c.id and m.direction='inbound'),
  (select count(*) from public.email_outbox o where o.org_id=p_org and o.sender_connection_id=c.id and o.state='failed'),
  (select count(*) from public.campaign_sender_accounts a where a.org_id=p_org and a.connection_id=c.id and a.enabled),
  sc.last_success_at,coalesce(sc.last_error_code,c.last_error_code)
 from public.external_connections c join public.gmail_account_settings s on s.connection_id=c.id and s.org_id=c.org_id
 left join public.gmail_sync_cursors sc on sc.connection_id=c.id and sc.org_id=c.org_id
 where c.org_id=p_org and c.provider='gmail' order by c.created_at,c.id;
end $$;

revoke execute on function public.create_email_campaign(uuid,text,text),public.set_email_campaign_state(uuid,uuid,text,integer),public.pause_gmail_account(uuid,uuid,boolean),public.disconnect_gmail_account(uuid,uuid),public.gmail_account_summary(uuid) from public,anon,authenticated;
grant execute on function public.create_email_campaign(uuid,text,text),public.set_email_campaign_state(uuid,uuid,text,integer),public.pause_gmail_account(uuid,uuid,boolean),public.disconnect_gmail_account(uuid,uuid),public.gmail_account_summary(uuid) to authenticated;
