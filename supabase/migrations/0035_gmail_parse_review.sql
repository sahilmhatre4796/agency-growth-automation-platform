-- Mail that cannot be mapped safely is recorded without storing unparsed body or addresses.
-- Its account is held for owner review; sync may advance past the provider message.
create table public.gmail_parse_reviews (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 connection_id uuid not null,
 provider_message_id text not null check(length(provider_message_id) between 1 and 200),
 provider_thread_id text not null check(length(provider_thread_id) between 1 and 200),
 reason text not null check(reason in ('RECIPIENT_REVIEW_REQUIRED','MESSAGE_NOT_FOR_ACCOUNT','INVALID_MESSAGE_DATE','MESSAGE_PARSE_REVIEW_REQUIRED')),
 state text not null default 'review_needed' check(state in ('review_needed','dismissed')),
 review_note text,
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 unique(connection_id,provider_message_id),
 foreign key(org_id,connection_id) references public.external_connections(org_id,id)
);
create index gmail_parse_reviews_pending on public.gmail_parse_reviews(org_id,connection_id,created_at desc)
 where state='review_needed';
alter table public.gmail_parse_reviews enable row level security;
create policy gmail_parse_reviews_read on public.gmail_parse_reviews for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.gmail_parse_reviews from public,anon,authenticated;
grant select on public.gmail_parse_reviews to authenticated;
grant all on public.gmail_parse_reviews to service_role;

create function public.record_gmail_parse_review(p_connection uuid,p_provider_id text,p_thread text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare org uuid; saved uuid;
begin
 select org_id into org from public.external_connections where id=p_connection and provider='gmail' and state='connected';
 if not found then raise exception 'ACCOUNT_NOT_CONNECTED'; end if;
 if length(coalesce(p_provider_id,'')) not between 1 and 200 or length(coalesce(p_thread,'')) not between 1 and 200
  or p_reason not in ('RECIPIENT_REVIEW_REQUIRED','MESSAGE_NOT_FOR_ACCOUNT','INVALID_MESSAGE_DATE','MESSAGE_PARSE_REVIEW_REQUIRED')
  then raise exception 'INVALID_GMAIL_PARSE_REVIEW'; end if;
 insert into public.gmail_parse_reviews(org_id,connection_id,provider_message_id,provider_thread_id,reason)
 values(org,p_connection,p_provider_id,p_thread,p_reason) on conflict(connection_id,provider_message_id) do nothing returning id into saved;
 if saved is null then return; end if;
 update public.gmail_account_settings set paused=true,send_enabled=false,updated_at=now()
  where org_id=org and connection_id=p_connection;
 update public.email_outbox set state='held',last_error_code='GMAIL_PARSE_REVIEW_REQUIRED',lease_token=null,lease_until=null,updated_at=now()
  where org_id=org and sender_connection_id=p_connection and state='queued';
 update public.email_outbox set state='uncertain',last_error_code='GMAIL_PARSE_DURING_SEND',lease_token=null,lease_until=null,updated_at=now()
  where org_id=org and sender_connection_id=p_connection and state='leased';
 insert into public.tasks(org_id,title,description)
 values(org,'OWNER_REPLY_REQUIRED','Inspect an unparsed Gmail message in its original account. Sending is paused for this account.');
 insert into public.notifications(org_id,title,kind)
 values(org,'Gmail message needs owner review','gmail_reply');
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context)
 values(org,'gmail_parse_review_created','gmail_parse_reviews',saved,jsonb_build_object('reason',p_reason,'connection_id',p_connection));
end $$;
revoke execute on function public.record_gmail_parse_review(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_gmail_parse_review(uuid,text,text,text) to service_role;

create function public.dismiss_unrelated_gmail_parse_review(p_org uuid,p_review uuid,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare review public.gmail_parse_reviews;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if length(trim(coalesce(p_note,''))) not between 20 and 500 then raise exception 'REVIEW_REASON_REQUIRED'; end if;
 select * into review from public.gmail_parse_reviews where org_id=p_org and id=p_review and state='review_needed' for update;
 if not found then raise exception 'GMAIL_PARSE_REVIEW_NOT_PENDING'; end if;
 update public.gmail_parse_reviews set state='dismissed',review_note=trim(p_note),reviewed_by=auth.uid(),reviewed_at=now()
  where id=p_review;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'gmail_parse_review_dismissed','gmail_parse_reviews',p_review,
  jsonb_build_object('connection_id',review.connection_id));
end $$;
revoke execute on function public.dismiss_unrelated_gmail_parse_review(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dismiss_unrelated_gmail_parse_review(uuid,uuid,text) to authenticated;

create or replace function private.gmail_followup_block_reason(p_org uuid,p_connection uuid,p_thread text,p_since timestamptz)
returns text language plpgsql stable set search_path='' as $$
declare cursor public.gmail_sync_cursors;
begin
 if exists(select 1 from public.gmail_parse_reviews r where r.org_id=p_org and r.connection_id=p_connection
  and r.state='review_needed') then return 'UNPARSED_GMAIL_REVIEW_REQUIRED'; end if;
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
