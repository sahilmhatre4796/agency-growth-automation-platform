-- Inbound Gmail creates owner work and stops the matching conversation. It never sends a response.
create table public.gmail_message_reviews (
 message_id uuid primary key references public.gmail_messages(id) on delete cascade,
 org_id uuid not null references public.organizations(id) on delete cascade,
 connection_id uuid not null,
 provider_thread_id text not null,
 peer_email text not null,
 reason text not null check(reason in ('peer_mismatch','unmatched_contact')),
 state text not null default 'review_needed' check(state in ('review_needed','resolved','dismissed')),
 created_at timestamptz not null default now(),
 foreign key(org_id,connection_id) references public.external_connections(org_id,id)
);
alter table public.gmail_message_reviews enable row level security;
create policy gmail_message_reviews_read on public.gmail_message_reviews for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.gmail_message_reviews from public,anon,authenticated;
grant select on public.gmail_message_reviews to authenticated;
grant all on public.gmail_message_reviews to service_role;

alter function public.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) set schema private;
alter function private.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) rename to accept_gmail_message_legacy;
revoke execute on function private.accept_gmail_message_legacy(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
create function public.accept_gmail_message(p_connection uuid,p_provider_id text,p_provider_thread text,p_rfc_id text,p_reply_to text,p_direction text,p_peer text,p_subject text,p_body text,p_classification text,p_at timestamptz,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare result text; message public.gmail_messages; thread public.gmail_threads; prior public.lead_qualifications; expected_email text; review_message_id uuid;
begin
 if p_direction='inbound' then
  select * into thread from public.gmail_threads where connection_id=p_connection and provider_thread_id=p_provider_thread for update;
  if thread.id is not null and thread.contact_id is not null then
   select email_normalized into expected_email from public.contacts where org_id=thread.org_id and id=thread.contact_id;
   if expected_email is null or lower(expected_email)<>lower(p_peer) then
    if not exists(select 1 from public.external_connections where org_id=thread.org_id and id=p_connection and provider='gmail' and state='connected')
      or length(coalesce(p_provider_id,'')) not between 1 and 200 or length(coalesce(p_provider_thread,'')) not between 1 and 200
      or p_peer !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or length(coalesce(p_body,''))>10000
      or length(coalesce(p_subject,''))>300 or p_at>now()+interval '5 minutes' then raise exception 'INVALID_GMAIL_MESSAGE'; end if;
    if exists(select 1 from public.gmail_messages where connection_id=p_connection and provider_message_id=p_provider_id) then return 'duplicate'; end if;
    insert into public.gmail_messages(org_id,connection_id,thread_id,provider_message_id,rfc_message_id,reply_to_id,direction,subject,body,classification,occurred_at)
    values(thread.org_id,p_connection,thread.id,p_provider_id,left(p_rfc_id,250),left(p_reply_to,250),'inbound',left(p_subject,300),p_body,'unknown',p_at)
    returning id into review_message_id;
    insert into public.gmail_message_reviews(message_id,org_id,connection_id,provider_thread_id,peer_email,reason)
    values(review_message_id,thread.org_id,p_connection,p_provider_thread,lower(p_peer),'peer_mismatch');
    update public.email_outbox set state='cancelled',last_error_code='AMBIGUOUS_THREAD_REPLY',lease_token=null,lease_until=null,updated_at=now()
     where org_id=thread.org_id and sender_connection_id=p_connection and provider_thread_id=p_provider_thread and state in ('queued','held');
    update public.email_outbox set state='uncertain',last_error_code='AMBIGUOUS_THREAD_REPLY_DURING_SEND',lease_token=null,lease_until=null,updated_at=now()
     where org_id=thread.org_id and sender_connection_id=p_connection and provider_thread_id=p_provider_thread and state='leased';
    update public.sequence_enrollments e set state='paused',next_run_at=null from public.email_sequence_plans plan
     where plan.enrollment_id=e.id and plan.org_id=thread.org_id and plan.sender_connection_id=p_connection
      and plan.provider_thread_id=p_provider_thread and e.state='active';
    insert into public.tasks(org_id,title,description) values(thread.org_id,'OWNER_REPLY_REQUIRED','Review an ambiguous Gmail sender in the unified inbox before responding.');
    insert into public.notifications(org_id,title,kind) values(thread.org_id,'Ambiguous Gmail reply needs review','gmail_reply');
    return 'review_needed';
   end if;
  end if;
 end if;
 result:=private.accept_gmail_message_legacy(p_connection,p_provider_id,p_provider_thread,p_rfc_id,p_reply_to,p_direction,p_peer,p_subject,p_body,p_classification,p_at,p_identifier_hash);
 if result<>'created' or p_direction<>'inbound' then return result; end if;
 select * into message from public.gmail_messages where connection_id=p_connection and provider_message_id=p_provider_id;
 select * into thread from public.gmail_threads where id=message.thread_id and connection_id=p_connection;
 if thread.contact_id is null then
  insert into public.gmail_message_reviews(message_id,org_id,connection_id,provider_thread_id,peer_email,reason)
  values(message.id,thread.org_id,p_connection,p_provider_thread,lower(p_peer),'unmatched_contact');
 end if;
 -- Thread-level stop also covers a reply whose sender address could not be mapped to one contact.
 update public.email_outbox set state='cancelled',last_error_code='THREAD_REPLY_RECEIVED',lease_token=null,lease_until=null,updated_at=now()
  where org_id=thread.org_id and sender_connection_id=p_connection and provider_thread_id=p_provider_thread and state in ('queued','held');
 update public.email_outbox set state='uncertain',last_error_code='THREAD_REPLY_DURING_SEND',lease_token=null,lease_until=null,updated_at=now()
  where org_id=thread.org_id and sender_connection_id=p_connection and provider_thread_id=p_provider_thread and state='leased';
 update public.sequence_enrollments e set state='paused',next_run_at=null
  from public.email_sequence_plans plan where plan.enrollment_id=e.id and plan.org_id=thread.org_id
   and plan.sender_connection_id=p_connection and plan.provider_thread_id=p_provider_thread and e.state='active';
 insert into public.tasks(org_id,lead_id,title,description,assigned_to)
 select thread.org_id,thread.lead_id,'OWNER_REPLY_REQUIRED',
  case when thread.lead_id is null then 'Review an unmatched Gmail reply in the unified inbox.'
   else 'Review the Gmail reply and respond personally from the original account.' end,
  (select owner_user_id from public.leads where id=thread.lead_id and org_id=thread.org_id);
 if thread.lead_id is not null then
  update public.leads set status='replied' where org_id=thread.org_id and id=thread.lead_id and status not in ('won','lost','disqualified');
  select * into prior from public.lead_qualifications where org_id=thread.org_id and lead_id=thread.lead_id order by evaluated_at desc,id desc limit 1;
  insert into public.lead_qualifications(org_id,lead_id,primary_service_id,status,score,confidence,reasons,evidence_ids,suggested_angle,recommended_cta)
  values(thread.org_id,thread.lead_id,prior.primary_service_id,case when p_classification='opt_out' then 'SUPPRESSED' else 'OWNER_REPLY_REQUIRED' end,
   coalesce(prior.score,0),coalesce(prior.confidence,0),array['Inbound Gmail reply requires owner review.'],coalesce(prior.evidence_ids,'{}'),prior.suggested_angle,prior.recommended_cta);
 end if;
 return result;
end $$;
revoke execute on function public.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.accept_gmail_message(uuid,text,text,text,text,text,text,text,text,text,timestamptz,text) to service_role;
