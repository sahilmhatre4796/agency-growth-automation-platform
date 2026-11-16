create table public.external_connections(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),
 provider text not null check(provider in ('gmail','calendar','whatsapp')),provider_account_id text not null,
 state text not null default 'not_verified' check(state in ('not_verified','connected','disconnected','error')),verified_at timestamptz,
 scopes text[] not null default '{}',created_at timestamptz not null default now(),unique(org_id,id),unique(provider,provider_account_id)
);
create table private.oauth_secrets(
 connection_id uuid primary key references public.external_connections(id) on delete cascade,
 ciphertext bytea not null,iv bytea not null,expires_at timestamptz not null,updated_at timestamptz not null default now()
);
revoke all on private.oauth_secrets from public,anon,authenticated;
alter table private.oauth_secrets enable row level security;
grant usage on schema private to service_role;
grant all on private.oauth_secrets to service_role;
create table public.provider_webhook_events(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),connection_id uuid not null,
 provider_event_id text not null,received_at timestamptz not null default now(),unique(connection_id,provider_event_id),
 foreign key(org_id,connection_id) references public.external_connections(org_id,id)
);
create table public.communication_messages(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),lead_id uuid not null,contact_id uuid not null,
 provider_event_id text not null,channel text not null check(channel in ('email','whatsapp')),body text check(length(body)<=10000),
 classification text not null default 'unknown',occurred_at timestamptz not null,created_at timestamptz not null default now(),
 foreign key(org_id,lead_id,contact_id) references public.contacts(org_id,lead_id,id)
);
create table public.sequence_enrollments(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),contact_id uuid not null,
 state text not null default 'paused' check(state in ('active','paused','cancelled','completed')),approved_by uuid,
 followups_sent integer not null default 0 check(followups_sent between 0 and 2),next_run_at timestamptz,
 foreign key(org_id,contact_id) references public.contacts(org_id,id),foreign key(org_id,approved_by) references public.memberships(org_id,user_id)
);
alter table public.external_connections enable row level security;
alter table public.provider_webhook_events enable row level security;
alter table public.communication_messages enable row level security;
alter table public.sequence_enrollments enable row level security;
create policy connection_read on public.external_connections for select to authenticated using(private.is_org_admin(org_id));
create policy webhook_read on public.provider_webhook_events for select to authenticated using(private.is_org_admin(org_id));
create policy communication_read on public.communication_messages for select to authenticated using(private.is_org_member(org_id));
create policy sequence_read on public.sequence_enrollments for select to authenticated using(private.is_org_admin(org_id));
grant select on public.external_connections,public.provider_webhook_events,public.communication_messages,public.sequence_enrollments to authenticated;
grant all on public.external_connections,public.provider_webhook_events,public.communication_messages,public.sequence_enrollments to service_role;

create function public.accept_whatsapp_inbound(p_connection uuid,p_event text,p_from text,p_at timestamptz,p_body text,p_classification text,p_identifier_hash text) returns text language plpgsql security definer set search_path='' as $$
declare connection public.external_connections;event_id uuid;lid uuid;cid uuid;mid uuid;matches integer;
begin
 select * into connection from public.external_connections where id=p_connection and provider='whatsapp' and state='connected' and verified_at is not null for update;
 if not found then raise exception 'CONNECTION_NOT_VERIFIED';end if;
 if p_classification not in ('unknown','unsubscribe','negative','question') or p_from!~'^\+[1-9][0-9]{7,14}$' or length(p_event)>200 or length(coalesce(p_body,''))>10000 or p_identifier_hash!~'^[a-f0-9]{64}$' or p_at>now()+interval '5 minutes' then raise exception 'INVALID_INBOUND';end if;
 insert into public.provider_webhook_events(org_id,connection_id,provider_event_id) values(connection.org_id,p_connection,p_event) on conflict do nothing returning id into event_id;
 if event_id is null then return 'duplicate';end if;
 select count(*) into matches from public.contacts where org_id=connection.org_id and phone_e164=p_from;
 if matches>1 then raise exception 'AMBIGUOUS_CONTACT_REVIEW_REQUIRED';end if;
 select id,lead_id into cid,lid from public.contacts where org_id=connection.org_id and phone_e164=p_from limit 1;
 if cid is null then
  insert into public.leads(org_id,business_name,source_type,source_observed_at) values(connection.org_id,'Inbound WhatsApp enquiry '||event_id::text,'inbound',p_at) returning id into lid;
  insert into public.contacts(org_id,lead_id,phone_e164) values(connection.org_id,lid,p_from) returning id into cid;
 end if;
 insert into public.communication_messages(org_id,lead_id,contact_id,provider_event_id,channel,body,classification,occurred_at) values(connection.org_id,lid,cid,p_event,'whatsapp',p_body,p_classification,p_at) returning id into mid;
 update public.sequence_enrollments set state='paused' where org_id=connection.org_id and contact_id=cid and state='active';
 update public.jobs set state='cancelled',last_error_code='HUMAN_REPLY' where org_id=connection.org_id and payload->>'contact_id'=cid::text and state in ('queued','leased');
 if p_classification='unsubscribe' then
  insert into public.consent_records(org_id,contact_id,channel,state,source,evidence_ref,revoked_at) values(connection.org_id,cid,'whatsapp','opted_out','verified_inbound',p_event,now());
  insert into public.suppressions(org_id,channel,identifier_hash,reason) values(connection.org_id,'whatsapp',p_identifier_hash,'Explicit opt-out') on conflict do nothing;
  update public.sequence_enrollments set state='cancelled' where org_id=connection.org_id and contact_id=cid and state<>'completed';
 end if;
 insert into public.notifications(org_id,lead_id,title,kind) values(connection.org_id,lid,case when p_classification='unsubscribe' then 'WhatsApp opt-out applied' else 'New WhatsApp reply requires review' end,'whatsapp_inbound');
 insert into public.audit_events(org_id,action,entity_table,entity_id) values(connection.org_id,'whatsapp_inbound','communication_messages',mid);
 return 'created';
end $$;
revoke all on function public.accept_whatsapp_inbound(uuid,text,text,timestamptz,text,text,text) from public;
grant execute on function public.accept_whatsapp_inbound(uuid,text,text,timestamptz,text,text,text) to service_role;
