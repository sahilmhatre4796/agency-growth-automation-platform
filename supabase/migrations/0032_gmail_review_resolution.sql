-- Only a human admin can release an account-wide ambiguous-inbound hold,
-- after checking the original mailbox and recording why it is unrelated.
alter table public.gmail_message_reviews
 add column reviewed_by uuid references auth.users(id),
 add column reviewed_at timestamptz,
 add column review_note text;

create function public.dismiss_unrelated_gmail_review(p_org uuid,p_message uuid,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare review public.gmail_message_reviews;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if length(trim(coalesce(p_note,''))) not between 15 and 500 then raise exception 'REVIEW_REASON_REQUIRED'; end if;
 select * into review from public.gmail_message_reviews where org_id=p_org and message_id=p_message
  and state='review_needed' for update;
 if review.message_id is null then raise exception 'GMAIL_REVIEW_NOT_PENDING'; end if;
 update public.gmail_message_reviews set state='dismissed',reviewed_by=auth.uid(),reviewed_at=now(),review_note=trim(p_note)
  where message_id=p_message;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'gmail_review_dismissed_unrelated','gmail_messages',p_message,
  jsonb_build_object('connection_id',review.connection_id,'reason',review.reason));
end $$;
revoke execute on function public.dismiss_unrelated_gmail_review(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dismiss_unrelated_gmail_review(uuid,uuid,text) to authenticated;
