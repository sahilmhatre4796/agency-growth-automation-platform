-- Service-only vault access and account-bound provider history persistence.
create function public.get_gmail_oauth_secret(p_connection uuid)
returns table(org_id uuid,account text,ciphertext bytea,iv bytea,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
 return query select c.org_id,c.provider_account_id,s.ciphertext,s.iv,s.expires_at
 from public.external_connections c join private.oauth_secrets s on s.connection_id=c.id
 where c.id=p_connection and c.provider='gmail' and c.state='connected';
end $$;
create function public.update_gmail_oauth_secret(p_connection uuid,p_ciphertext bytea,p_iv bytea,p_expires timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if octet_length(p_iv)<>12 or p_expires<=now() then raise exception 'INVALID_SECRET_UPDATE'; end if;
 select org_id into org from public.external_connections where id=p_connection and provider='gmail' and state='connected' for update;
 if not found then raise exception 'ACCOUNT_DISCONNECTED'; end if;
 update private.oauth_secrets set ciphertext=p_ciphertext,iv=p_iv,expires_at=p_expires,updated_at=now() where connection_id=p_connection;
 if not found then raise exception 'SECRET_NOT_FOUND'; end if;
 insert into public.audit_events(org_id,action,entity_table,entity_id) values(org,'gmail_token_refreshed','external_connections',p_connection);
end $$;
create function public.mark_gmail_account_error(p_connection uuid,p_code text,p_revoked boolean)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if length(coalesce(p_code,'')) not between 1 and 80 then raise exception 'INVALID_ERROR_CODE'; end if;
 update public.external_connections set state=case when p_revoked then 'disconnected' else 'error' end,last_error_code=p_code where id=p_connection and provider='gmail' returning org_id into org;
 if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
 update public.gmail_account_settings set paused=true,send_enabled=false,updated_at=now() where connection_id=p_connection;
 update public.email_outbox set state='held',last_error_code=p_code,lease_token=null,lease_until=null where sender_connection_id=p_connection and state='queued';
 update public.email_outbox set state='uncertain',last_error_code='ACCOUNT_ERROR_DURING_SEND',lease_token=null,lease_until=null where sender_connection_id=p_connection and state='leased';
 if p_revoked then delete from private.oauth_secrets where connection_id=p_connection; end if;
 insert into public.notifications(org_id,title,kind) values(org,'Gmail account needs attention','gmail_account');
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(org,'gmail_account_error','external_connections',p_connection,jsonb_build_object('code',p_code,'revoked',p_revoked));
end $$;

create function public.backoff_gmail_account(p_connection uuid,p_code text,p_minutes integer default 15)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if p_code<>'GOOGLE_RATE_LIMITED' or p_minutes not between 1 and 60 then raise exception 'INVALID_BACKOFF'; end if;
 select org_id into org from public.external_connections where id=p_connection and provider='gmail' and state='connected';
 if not found then raise exception 'ACCOUNT_NOT_CONNECTED'; end if;
 update public.gmail_account_settings set send_after=greatest(coalesce(send_after,now()),now()+make_interval(mins=>p_minutes)),updated_at=now() where connection_id=p_connection;
 update public.gmail_sync_cursors set next_run_at=greatest(coalesce(next_run_at,now()),now()+make_interval(mins=>p_minutes)),last_error_code=p_code where connection_id=p_connection;
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(org,'gmail_rate_backoff','external_connections',p_connection,jsonb_build_object('minutes',p_minutes));
end $$;

create function public.accept_gmail_message(p_connection uuid,p_provider_id text,p_provider_thread text,p_rfc_id text,p_reply_to text,p_direction text,p_peer text,p_subject text,p_body text,p_classification text,p_at timestamptz,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare c public.external_connections; tid uuid; mid uuid; lid uuid; cid uuid; campaign uuid; matches integer; existing public.gmail_threads;
begin
 select * into c from public.external_connections where id=p_connection and provider='gmail' and state='connected' for update;
 if not found then raise exception 'ACCOUNT_NOT_CONNECTED'; end if;
 if length(p_provider_id) not between 1 and 200 or length(p_provider_thread) not between 1 and 200 or p_direction not in ('inbound','outbound')
   or p_classification not in ('unknown','interested','not_interested','meeting_request','opt_out','question')
   or p_peer !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or length(coalesce(p_body,''))>10000
   or length(coalesce(p_subject,''))>300 or p_at>now()+interval '5 minutes' or p_identifier_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_GMAIL_MESSAGE'; end if;
 if exists(select 1 from public.gmail_messages where connection_id=p_connection and provider_message_id=p_provider_id) then return 'duplicate'; end if;
 select * into existing from public.gmail_threads where connection_id=p_connection and provider_thread_id=p_provider_thread for update;
 if found then
  tid:=existing.id;lid:=existing.lead_id;cid:=existing.contact_id;campaign:=existing.campaign_id;
  if cid is null then
   select count(*) into matches from public.contacts where org_id=c.org_id and lower(coalesce(email_normalized,email,''))=lower(p_peer);
   if matches=1 then
    select id,lead_id into cid,lid from public.contacts where org_id=c.org_id and lower(coalesce(email_normalized,email,''))=lower(p_peer) limit 1;
    update public.gmail_threads set contact_id=cid,lead_id=lid where id=tid;
   end if;
  end if;
 else
  select count(*) into matches from public.contacts where org_id=c.org_id and lower(coalesce(email_normalized,email,''))=lower(p_peer);
  if matches=1 then select id,lead_id into cid,lid from public.contacts where org_id=c.org_id and lower(coalesce(email_normalized,email,''))=lower(p_peer) limit 1; end if;
  select campaign_id into campaign from public.email_outbox where org_id=c.org_id and sender_connection_id=p_connection and provider_thread_id=p_provider_thread and state='sent' order by updated_at desc limit 1;
  insert into public.gmail_threads(org_id,connection_id,provider_thread_id,lead_id,contact_id,campaign_id,subject,last_message_at)
  values(c.org_id,p_connection,p_provider_thread,lid,cid,campaign,left(p_subject,300),p_at) returning id into tid;
 end if;
 insert into public.gmail_messages(org_id,connection_id,thread_id,provider_message_id,rfc_message_id,reply_to_id,direction,subject,body,classification,occurred_at)
 values(c.org_id,p_connection,tid,p_provider_id,left(p_rfc_id,250),left(p_reply_to,250),p_direction,left(p_subject,300),p_body,p_classification,p_at)
 on conflict(connection_id,provider_message_id) do nothing returning id into mid;
 if mid is null then return 'duplicate'; end if;
 update public.gmail_threads set last_message_at=greatest(last_message_at,p_at),subject=coalesce(subject,left(p_subject,300)) where id=tid;
 if p_direction='inbound' then
  insert into public.message_events(org_id,lead_id,contact_id,provider,provider_message_id,provider_thread_id,direction,event_type,safe_metadata)
  values(c.org_id,lid,cid,'gmail',p_connection::text||':'||p_provider_id,p_provider_thread,'inbound','received',jsonb_build_object('sender_connection_id',p_connection,'classification',p_classification)) on conflict do nothing;
  if cid is not null then
   update public.email_outbox set state='cancelled',last_error_code='REPLY_RECEIVED',lease_token=null,lease_until=null where org_id=c.org_id and contact_id=cid and state in ('queued','held');
   update public.email_outbox set state='uncertain',last_error_code='REPLY_DURING_SEND',lease_token=null,lease_until=null where org_id=c.org_id and contact_id=cid and state='leased';
   update public.sequence_enrollments set state='paused' where org_id=c.org_id and contact_id=cid and state='active';
   update public.jobs set state='cancelled',last_error_code='REPLY_RECEIVED' where org_id=c.org_id and payload->>'contact_id'=cid::text and state in ('queued','leased');
   update public.leads set status='replied' where org_id=c.org_id and id=lid and status='contacted';
  end if;
  if p_classification='opt_out' then
   insert into public.suppressions(org_id,channel,identifier_hash,reason) values(c.org_id,'email',p_identifier_hash,'Verified Gmail opt-out') on conflict do nothing;
   if cid is not null then
    insert into public.consent_records(org_id,contact_id,channel,state,source,evidence_ref,revoked_at) values(c.org_id,cid,'email','unsubscribed','verified_gmail_reply',p_provider_id,now());
    update public.sequence_enrollments set state='cancelled' where org_id=c.org_id and contact_id=cid and state<>'completed';
   end if;
  end if;
  insert into public.notifications(org_id,lead_id,title,kind) values(c.org_id,lid,case when p_classification='opt_out' then 'Email opt-out applied' else 'Gmail reply needs review' end,'gmail_reply');
 end if;
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(c.org_id,'gmail_message_ingested','gmail_messages',mid,jsonb_build_object('connection_id',p_connection,'direction',p_direction));
 return 'created';
end $$;

create function public.save_gmail_sync_cursor(p_connection uuid,p_history_id text,p_kind text,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 select org_id into org from public.external_connections where id=p_connection and provider='gmail' and state='connected';
 if not found then raise exception 'ACCOUNT_NOT_CONNECTED'; end if;
 if p_kind not in ('inbox','sent') or length(coalesce(p_history_id,''))>100 or length(coalesce(p_error,''))>80 then raise exception 'INVALID_CURSOR'; end if;
 update public.gmail_sync_cursors set history_id=coalesce(p_history_id,history_id),
  last_inbox_sync_at=case when p_kind='inbox' and p_error is null then now() else last_inbox_sync_at end,
  last_sent_sync_at=case when p_kind='sent' and p_error is null then now() else last_sent_sync_at end,
  last_success_at=case when p_error is null then now() else last_success_at end,last_error_code=p_error where connection_id=p_connection and org_id=org;
 if p_error is not null then insert into public.notifications(org_id,title,kind) values(org,'Gmail sync needs attention','gmail_sync'); end if;
end $$;

revoke execute on function public.get_gmail_oauth_secret(uuid),public.update_gmail_oauth_secret(uuid,bytea,bytea,timestamptz),public.mark_gmail_account_error(uuid,text,boolean),public.backoff_gmail_account(uuid,text,integer),public.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text),public.save_gmail_sync_cursor(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.get_gmail_oauth_secret(uuid),public.update_gmail_oauth_secret(uuid,bytea,bytea,timestamptz),public.mark_gmail_account_error(uuid,text,boolean),public.backoff_gmail_account(uuid,text,integer),public.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text),public.save_gmail_sync_cursor(uuid,text,text,text) to service_role;
