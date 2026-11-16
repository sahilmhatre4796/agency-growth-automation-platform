-- Follow-ups require a complete recent mailbox state. A partial history page,
-- sync error, or unresolved ambiguous incoming message blocks the whole sender.
alter function public.advance_gmail_sync(uuid,uuid,text,text,text,text) set schema private;
alter function private.advance_gmail_sync(uuid,uuid,text,text,text,text) rename to advance_gmail_sync_legacy;
revoke execute on function private.advance_gmail_sync_legacy(uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role;
create function public.advance_gmail_sync(p_connection uuid,p_token uuid,p_kind text,p_next_page text,p_history text,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.advance_gmail_sync_legacy(p_connection,p_token,p_kind,p_next_page,p_history,p_error);
 -- A completed history page is a fresh inbox check. The original timestamp
 -- only changed during the initial INBOX scan, aging out healthy accounts.
 if p_kind='history' and p_next_page is null and p_error is null then
  update public.gmail_sync_cursors set last_inbox_sync_at=now()
   where connection_id=p_connection and initial_inbox_complete and initial_sent_complete;
 end if;
end $$;
revoke execute on function public.advance_gmail_sync(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.advance_gmail_sync(uuid,uuid,text,text,text,text) to service_role;

create function private.gmail_followup_block_reason(p_org uuid,p_connection uuid,p_thread text,p_since timestamptz)
returns text language plpgsql stable set search_path='' as $$
declare cursor public.gmail_sync_cursors;
begin
 if exists(select 1 from public.gmail_message_reviews r where r.org_id=p_org and r.connection_id=p_connection
  and r.state='review_needed') then return 'AMBIGUOUS_INBOUND_REVIEW_REQUIRED'; end if;
 select * into cursor from public.gmail_sync_cursors where org_id=p_org and connection_id=p_connection;
 if cursor.connection_id is null or not cursor.initial_inbox_complete or not cursor.initial_sent_complete
  or cursor.history_id is null or cursor.last_success_at is null or cursor.last_success_at<=now()-interval '20 minutes'
  then return 'INBOX_SYNC_STALE'; end if;
 if cursor.last_error_code is not null or cursor.inbox_page_token is not null or cursor.sent_page_token is not null
  or cursor.history_page_token is not null then return 'INBOX_SYNC_REVIEW_REQUIRED'; end if;
 if exists(select 1 from public.gmail_messages m join public.gmail_threads t on t.id=m.thread_id and t.connection_id=m.connection_id
  where t.org_id=p_org and t.connection_id=p_connection and t.provider_thread_id=p_thread
   and m.direction='inbound' and m.occurred_at>=p_since) then return 'REPLY_RECEIVED'; end if;
 return null;
end $$;
revoke execute on function private.gmail_followup_block_reason(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function private.gmail_followup_block_reason(uuid,uuid,text,timestamptz) to service_role;

alter function public.set_email_sequence_state(uuid,uuid,text) set schema private;
alter function private.set_email_sequence_state(uuid,uuid,text) rename to set_email_sequence_state_legacy;
revoke execute on function private.set_email_sequence_state_legacy(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.set_email_sequence_state(p_org uuid,p_enrollment uuid,p_state text)
returns void language plpgsql security definer set search_path='' as $$
declare plan public.email_sequence_plans; original public.email_outbox; reason text;
begin
 if p_state='active' then
  if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into plan from public.email_sequence_plans where org_id=p_org and enrollment_id=p_enrollment;
  if plan.enrollment_id is null then raise exception 'SEQUENCE_NOT_FOUND'; end if;
  select * into original from public.email_outbox where id=plan.first_outbox_id and org_id=p_org;
  reason:=private.gmail_followup_block_reason(p_org,plan.sender_connection_id,plan.provider_thread_id,original.updated_at);
  if reason is not null then raise exception '%',reason; end if;
 end if;
 perform private.set_email_sequence_state_legacy(p_org,p_enrollment,p_state);
end $$;
revoke execute on function public.set_email_sequence_state(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.set_email_sequence_state(uuid,uuid,text) to authenticated;

alter function public.advance_email_sequence(uuid,uuid,text,text) set schema private;
alter function private.advance_email_sequence(uuid,uuid,text,text) rename to advance_email_sequence_one_followup;
revoke execute on function private.advance_email_sequence_one_followup(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.advance_email_sequence(p_enrollment uuid,p_token uuid,p_identifier_hash text,p_recipient_email text)
returns text language plpgsql security definer set search_path='' as $$
declare plan public.email_sequence_plans; original public.email_outbox; enrollment public.sequence_enrollments; reason text;
begin
 select * into plan from public.email_sequence_plans where enrollment_id=p_enrollment and lease_token=p_token
  and lease_until>now() for update;
 if plan.enrollment_id is null then raise exception 'SEQUENCE_LEASE_INVALID'; end if;
 select * into enrollment from public.sequence_enrollments where id=p_enrollment and org_id=plan.org_id for update;
 if enrollment.state='active' and enrollment.followups_sent<1 then
  select * into original from public.email_outbox where id=plan.first_outbox_id and org_id=plan.org_id;
  reason:=private.gmail_followup_block_reason(plan.org_id,plan.sender_connection_id,plan.provider_thread_id,original.updated_at);
  if reason is not null then
   update public.sequence_enrollments set state='paused',next_run_at=null where id=p_enrollment;
   update public.email_outbox set state='cancelled',lease_token=null,lease_until=null,last_error_code=reason,updated_at=now()
    where id in (select outbox_id from public.email_sequence_steps where enrollment_id=p_enrollment)
     and state in ('queued','held');
   update public.email_outbox set state='uncertain',lease_token=null,lease_until=null,last_error_code=reason,updated_at=now()
    where id in (select outbox_id from public.email_sequence_steps where enrollment_id=p_enrollment) and state='leased';
   update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=reason where enrollment_id=p_enrollment;
   insert into public.notifications(org_id,title,kind) values(plan.org_id,'Email sequence needs review','email_sequence');
   return 'paused';
  end if;
 end if;
 return private.advance_email_sequence_one_followup(p_enrollment,p_token,p_identifier_hash,p_recipient_email);
end $$;
revoke execute on function public.advance_email_sequence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.advance_email_sequence(uuid,uuid,text,text) to service_role;

alter function public.check_email_send_policy(uuid,uuid,text) set schema private;
alter function private.check_email_send_policy(uuid,uuid,text) rename to check_email_send_policy_qualified;
revoke execute on function private.check_email_send_policy_qualified(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.check_email_send_policy(p_id uuid,p_token uuid,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare outgoing public.email_outbox; plan public.email_sequence_plans; original public.email_outbox; reason text;
begin
 select * into outgoing from public.email_outbox where id=p_id and state='leased' and lease_token=p_token
  and lease_until>now() for update;
 if outgoing.id is null then raise exception 'LEASE_INVALID'; end if;
 select p.* into plan from public.email_sequence_steps s join public.email_sequence_plans p
  on p.enrollment_id=s.enrollment_id and p.org_id=s.org_id where s.outbox_id=p_id and p.org_id=outgoing.org_id;
 if plan.enrollment_id is not null then
  select * into original from public.email_outbox where id=plan.first_outbox_id and org_id=plan.org_id;
  reason:=private.gmail_followup_block_reason(plan.org_id,plan.sender_connection_id,plan.provider_thread_id,original.updated_at);
  if reason is not null then
   update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code=reason,updated_at=now() where id=p_id;
   update public.sequence_enrollments set state='paused',next_run_at=null where id=plan.enrollment_id and state='active';
   update public.email_sequence_plans set last_error_code=reason where enrollment_id=plan.enrollment_id;
   insert into public.notifications(org_id,title,kind) values(plan.org_id,'Email follow-up needs review','email_sequence');
   return 'held';
  end if;
 end if;
 return private.check_email_send_policy_qualified(p_id,p_token,p_identifier_hash);
end $$;
revoke execute on function public.check_email_send_policy(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.check_email_send_policy(uuid,uuid,text) to service_role;
