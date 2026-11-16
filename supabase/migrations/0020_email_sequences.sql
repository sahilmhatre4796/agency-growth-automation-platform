-- Human-authored Gmail follow-ups. Existing generic enrollments remain paused by default;
-- only these account-bound plans are eligible for the dedicated service runner.
alter table public.sequence_enrollments add constraint sequence_enrollments_org_id_key unique(org_id,id);

create table public.email_sequence_plans (
 enrollment_id uuid primary key,
 org_id uuid not null,
 campaign_id uuid not null,
 first_outbox_id uuid not null,
 sender_connection_id uuid not null,
 provider_thread_id text not null,
 lease_token uuid,
 lease_until timestamptz,
 last_error_code text,
 created_at timestamptz not null default now(),
 unique(org_id,enrollment_id),unique(org_id,first_outbox_id),
 foreign key(org_id,enrollment_id) references public.sequence_enrollments(org_id,id) on delete cascade,
 foreign key(org_id,campaign_id) references public.campaigns(org_id,id),
 foreign key(org_id,first_outbox_id) references public.email_outbox(org_id,id),
 foreign key(org_id,sender_connection_id) references public.external_connections(org_id,id)
);
create table public.email_sequence_steps (
 org_id uuid not null,
 enrollment_id uuid not null,
 step_number smallint not null check(step_number between 1 and 2),
 draft_id uuid not null,
 due_at timestamptz not null,
 outbox_id uuid,
 primary key(enrollment_id,step_number),unique(org_id,draft_id),unique(org_id,outbox_id),
 foreign key(org_id,enrollment_id) references public.email_sequence_plans(org_id,enrollment_id) on delete cascade,
 foreign key(org_id,draft_id) references public.outbound_drafts(org_id,id),
 foreign key(org_id,outbox_id) references public.email_outbox(org_id,id)
);
create index email_sequence_due on public.sequence_enrollments(state,next_run_at) where state='active';
alter table public.email_sequence_plans enable row level security;
alter table public.email_sequence_steps enable row level security;
create policy email_sequence_plans_read on public.email_sequence_plans for select to authenticated using(private.is_org_admin(org_id));
create policy email_sequence_steps_read on public.email_sequence_steps for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.email_sequence_plans,public.email_sequence_steps from public,anon,authenticated;
grant select on public.email_sequence_plans,public.email_sequence_steps to authenticated;
grant all on public.email_sequence_plans,public.email_sequence_steps to service_role;

create function public.create_email_sequence(p_org uuid,p_first_outbox uuid,p_step1_draft uuid,p_step1_at timestamptz,p_step2_draft uuid default null,p_step2_at timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare original public.email_outbox; d public.outbound_drafts; sender public.gmail_account_settings; campaign public.campaigns; sid uuid; candidate uuid; due_at timestamptz; step_no integer;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select * into original from public.email_outbox where org_id=p_org and id=p_first_outbox and state='sent' and provider_message_id is not null and provider_thread_id is not null for update;
 if not found then raise exception 'SENT_CONVERSATION_REQUIRED'; end if;
 select * into campaign from public.campaigns where org_id=p_org and id=original.campaign_id and channel='email';
 select * into sender from public.gmail_account_settings where org_id=p_org and connection_id=original.sender_connection_id;
 if not found or campaign.id is null then raise exception 'EMAIL_CAMPAIGN_OR_SENDER_MISSING'; end if;
 if (p_step2_draft is null)<>(p_step2_at is null) or p_step1_draft=p_step2_draft then raise exception 'INVALID_SEQUENCE_STEPS'; end if;
 if p_step1_at<greatest(now()-interval '1 minute',original.updated_at+interval '1 day') or p_step1_at>now()+interval '30 days'
   or (p_step2_at is not null and (p_step2_at<p_step1_at+interval '1 day' or p_step2_at>now()+interval '60 days')) then raise exception 'INVALID_SEQUENCE_TIMING'; end if;
 if exists(select 1 from public.gmail_messages m join public.gmail_threads t on t.id=m.thread_id and t.connection_id=m.connection_id
  where t.org_id=p_org and t.connection_id=original.sender_connection_id and t.provider_thread_id=original.provider_thread_id
   and m.direction='inbound' and m.occurred_at>=original.updated_at) then raise exception 'REPLY_REVIEW_REQUIRED'; end if;
 if exists(select 1 from public.email_sequence_plans p join public.sequence_enrollments e on e.id=p.enrollment_id
   join public.email_outbox o on o.id=p.first_outbox_id where p.org_id=p_org and p.campaign_id=original.campaign_id and e.contact_id=original.contact_id
   and e.state in ('active','paused') and o.id<>original.id) then raise exception 'EXISTING_SEQUENCE_REVIEW_REQUIRED'; end if;
 for step_no in 1..2 loop
  candidate:=case when step_no=1 then p_step1_draft else p_step2_draft end;
  due_at:=case when step_no=1 then p_step1_at else p_step2_at end;
  if candidate is null then continue; end if;
  select * into d from public.outbound_drafts where org_id=p_org and id=candidate and state='approved' and channel='email' and campaign_id=original.campaign_id
    and lead_id=original.lead_id and contact_id=original.contact_id and approval_by is not null and approved_at is not null and claims_reviewed;
  if not found or candidate=original.draft_id or d.approved_sha256<>encode(sha256(convert_to(coalesce(d.subject,'')||chr(10)||d.body,'UTF8')),'hex')
    or exists(select 1 from public.email_outbox where org_id=p_org and draft_id=candidate) then raise exception 'APPROVED_FOLLOWUP_REQUIRED'; end if;
  if lower(regexp_replace(coalesce(d.subject,''),'^(re:\s*)+','','i'))<>lower(regexp_replace(original.subject,'^(re:\s*)+','','i'))
    or (sender.signature<>'' and right(trim(d.body),length(trim(sender.signature)))<>trim(sender.signature)) then raise exception 'THREAD_CONTENT_REVIEW_REQUIRED'; end if;
  if (due_at at time zone sender.timezone)::time<sender.window_start or (due_at at time zone sender.timezone)::time>=sender.window_end then raise exception 'FOLLOWUP_OUTSIDE_SEND_WINDOW'; end if;
 end loop;
 insert into public.sequence_enrollments(org_id,contact_id,state,approved_by,next_run_at)
 values(p_org,original.contact_id,'paused',auth.uid(),p_step1_at) returning id into sid;
 insert into public.email_sequence_plans(enrollment_id,org_id,campaign_id,first_outbox_id,sender_connection_id,provider_thread_id)
 values(sid,p_org,original.campaign_id,original.id,original.sender_connection_id,original.provider_thread_id);
 insert into public.email_sequence_steps(org_id,enrollment_id,step_number,draft_id,due_at)
 values(p_org,sid,1,p_step1_draft,p_step1_at);
 if p_step2_draft is not null then
  insert into public.email_sequence_steps(org_id,enrollment_id,step_number,draft_id,due_at)
  values(p_org,sid,2,p_step2_draft,p_step2_at);
 end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'email_sequence_created','sequence_enrollments',sid,jsonb_build_object('step_count',case when p_step2_draft is null then 1 else 2 end));
 return sid;
end $$;

create function public.set_email_sequence_state(p_org uuid,p_enrollment uuid,p_state text)
returns void language plpgsql security definer set search_path='' as $$
declare plan public.email_sequence_plans; enrollment public.sequence_enrollments; original public.email_outbox; org public.organizations; campaign public.campaigns; sender public.gmail_account_settings; step public.email_sequence_steps;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if p_state not in ('active','paused','cancelled') then raise exception 'INVALID_SEQUENCE_STATE'; end if;
 select * into plan from public.email_sequence_plans where org_id=p_org and enrollment_id=p_enrollment for update;
 if not found then raise exception 'SEQUENCE_NOT_FOUND'; end if;
 select * into enrollment from public.sequence_enrollments where id=p_enrollment and org_id=p_org for update;
 if enrollment.state in ('cancelled','completed') then raise exception 'SEQUENCE_TERMINAL'; end if;
 if p_state='active' then
  if enrollment.state<>'paused' then raise exception 'SEQUENCE_NOT_PAUSED'; end if;
  select * into org from public.organizations where id=p_org;
  select * into campaign from public.campaigns where id=plan.campaign_id and org_id=p_org;
  select * into sender from public.gmail_account_settings where connection_id=plan.sender_connection_id and org_id=p_org;
  select * into original from public.email_outbox where id=plan.first_outbox_id and org_id=p_org;
  if org.outbound_paused or not org.email_live_approved or org.email_daily_cap=0 or org.email_monthly_cap=0
    or campaign.state<>'active' or sender.paused or not sender.send_enabled or sender.daily_cap=0 or sender.monthly_cap=0
    or original.state<>'sent' then raise exception 'EMAIL_NOT_ENABLED'; end if;
  if not exists(select 1 from public.gmail_sync_cursors s where s.connection_id=plan.sender_connection_id and s.org_id=p_org
      and s.initial_inbox_complete and s.last_inbox_sync_at>now()-interval '20 minutes') then raise exception 'INBOX_SYNC_STALE'; end if;
  if exists(select 1 from public.gmail_messages m join public.gmail_threads t on t.id=m.thread_id and t.connection_id=m.connection_id
    where t.org_id=p_org and t.connection_id=plan.sender_connection_id and t.provider_thread_id=plan.provider_thread_id
    and m.direction='inbound' and m.occurred_at>=original.updated_at) then raise exception 'REPLY_REVIEW_REQUIRED'; end if;
  if exists(select 1 from public.email_sequence_steps s join public.email_outbox o on o.id=s.outbox_id
    where s.enrollment_id=p_enrollment and o.state in ('cancelled','held','uncertain','failed','suppressed')) then raise exception 'SEQUENCE_REVIEW_REQUIRED'; end if;
  for step in select * from public.email_sequence_steps where enrollment_id=p_enrollment loop
   if not exists(select 1 from public.outbound_drafts d where d.id=step.draft_id and d.org_id=p_org and d.state in ('approved','queued')
     and d.approval_by is not null and d.claims_reviewed and d.approved_sha256=encode(sha256(convert_to(coalesce(d.subject,'')||chr(10)||d.body,'UTF8')),'hex')) then raise exception 'FOLLOWUP_APPROVAL_CHANGED'; end if;
  end loop;
 end if;
 update public.sequence_enrollments set state=p_state where id=p_enrollment and org_id=p_org;
 if p_state<>'active' then
  update public.email_outbox set state='cancelled',last_error_code='SEQUENCE_STOPPED',lease_token=null,lease_until=null,updated_at=now()
   where org_id=p_org and id in (select outbox_id from public.email_sequence_steps where enrollment_id=p_enrollment) and state in ('queued','held');
  update public.email_outbox set state='uncertain',last_error_code='SEQUENCE_STOPPED_DURING_SEND',lease_token=null,lease_until=null,updated_at=now()
   where org_id=p_org and id in (select outbox_id from public.email_sequence_steps where enrollment_id=p_enrollment) and state='leased';
 end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,auth.uid(),'email_sequence_'||p_state,'sequence_enrollments',p_enrollment);
end $$;

create function public.lease_due_email_sequences(p_limit integer default 10)
returns table(enrollment_id uuid,org_id uuid,recipient_email text,lease_token uuid)
language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 return query with candidates as (
  select p.enrollment_id from public.email_sequence_plans p join public.sequence_enrollments e on e.id=p.enrollment_id and e.org_id=p.org_id
  where e.state='active' and e.next_run_at<=now() and (p.lease_until is null or p.lease_until<now())
  order by e.next_run_at,p.enrollment_id for update of p skip locked limit p_limit
 ) update public.email_sequence_plans p set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
 from candidates c where p.enrollment_id=c.enrollment_id
 returning p.enrollment_id,p.org_id,
  (select ct.email_normalized from public.sequence_enrollments e join public.contacts ct on ct.id=e.contact_id and ct.org_id=e.org_id where e.id=p.enrollment_id),p.lease_token;
end $$;

create function public.advance_email_sequence(p_enrollment uuid,p_token uuid,p_identifier_hash text,p_recipient_email text)
returns text language plpgsql security definer set search_path='' as $$
declare plan public.email_sequence_plans; enrollment public.sequence_enrollments; step public.email_sequence_steps; prior public.email_outbox; queued public.email_outbox; sender public.gmail_account_settings; cursor public.gmail_sync_cursors; next_step public.email_sequence_steps; scheduled timestamptz; new_outbox uuid; reason text;
begin
 if p_identifier_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_IDENTIFIER_HASH'; end if;
 select * into plan from public.email_sequence_plans where enrollment_id=p_enrollment and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'SEQUENCE_LEASE_INVALID'; end if;
 select * into enrollment from public.sequence_enrollments where id=p_enrollment and org_id=plan.org_id for update;
 if enrollment.state<>'active' or enrollment.next_run_at>now() then
  update public.email_sequence_plans set lease_token=null,lease_until=null where enrollment_id=p_enrollment;
  return 'inactive';
 end if;
 select * into step from public.email_sequence_steps where enrollment_id=p_enrollment and step_number=enrollment.followups_sent+1 for update;
 if not found then
  update public.sequence_enrollments set state='completed',next_run_at=null where id=p_enrollment;
  update public.email_sequence_plans set lease_token=null,lease_until=null where enrollment_id=p_enrollment;
  return 'completed';
 end if;
 select * into prior from public.email_outbox where id=plan.first_outbox_id and org_id=plan.org_id;
 if prior.state<>'sent' or prior.provider_thread_id<>plan.provider_thread_id or prior.sender_connection_id<>plan.sender_connection_id then reason:='ORIGINAL_CONVERSATION_CHANGED'; end if;
 if reason is null and (p_recipient_email is null or p_recipient_email !~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$') then reason:='EMAIL_CONTACT_REQUIRED'; end if;
 if reason is null and exists(select 1 from public.gmail_messages m join public.gmail_threads t on t.id=m.thread_id and t.connection_id=m.connection_id
   where t.org_id=plan.org_id and t.connection_id=plan.sender_connection_id and t.provider_thread_id=plan.provider_thread_id
   and m.direction='inbound' and m.occurred_at>=prior.updated_at) then reason:='REPLY_RECEIVED'; end if;
 select * into cursor from public.gmail_sync_cursors where org_id=plan.org_id and connection_id=plan.sender_connection_id;
 if reason is null and (cursor.connection_id is null or not cursor.initial_inbox_complete or cursor.last_inbox_sync_at is null
   or cursor.last_inbox_sync_at<=now()-interval '20 minutes') then reason:='INBOX_SYNC_STALE'; end if;
 if reason is not null then
  update public.sequence_enrollments set state='paused',next_run_at=null where id=p_enrollment;
  update public.email_outbox set state='cancelled',last_error_code=reason,lease_token=null,lease_until=null where id=step.outbox_id and state in ('queued','held');
  update public.email_outbox set state='uncertain',last_error_code=reason,lease_token=null,lease_until=null where id=step.outbox_id and state='leased';
  update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=reason where enrollment_id=p_enrollment;
  insert into public.notifications(org_id,title,kind) values(plan.org_id,'Email sequence needs review','email_sequence');
  return 'paused';
 end if;
 if step.outbox_id is not null then
  select * into queued from public.email_outbox where id=step.outbox_id and org_id=plan.org_id;
  if queued.state='sent' then
   update public.sequence_enrollments set followups_sent=step.step_number where id=p_enrollment;
   select * into next_step from public.email_sequence_steps where enrollment_id=p_enrollment and step_number=step.step_number+1;
   if found then
    update public.sequence_enrollments set next_run_at=greatest(next_step.due_at,queued.updated_at+interval '1 day') where id=p_enrollment;
    update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=null where enrollment_id=p_enrollment;
    return 'next_step';
   end if;
   update public.sequence_enrollments set state='completed',next_run_at=null where id=p_enrollment;
   update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=null where enrollment_id=p_enrollment;
   insert into public.audit_events(org_id,action,entity_table,entity_id) values(plan.org_id,'email_sequence_completed','sequence_enrollments',p_enrollment);
   return 'completed';
  elsif queued.state in ('queued','leased') then
   update public.sequence_enrollments set next_run_at=greatest(now()+interval '5 minutes',queued.scheduled_at+interval '5 minutes') where id=p_enrollment;
   update public.email_sequence_plans set lease_token=null,lease_until=null where enrollment_id=p_enrollment;
   return 'pending_send';
  else
   reason:='FOLLOWUP_SEND_NEEDS_REVIEW';
  end if;
 else
  select * into sender from public.gmail_account_settings where org_id=plan.org_id and connection_id=plan.sender_connection_id;
  if not found then reason:='SENDER_SETTINGS_MISSING'; end if;
  if reason is null then
   if (now() at time zone sender.timezone)::time<sender.window_start then
    scheduled:=((now() at time zone sender.timezone)::date+sender.window_start) at time zone sender.timezone;
   elsif (now() at time zone sender.timezone)::time>=sender.window_end then
    scheduled:=(((now() at time zone sender.timezone)::date+1)+sender.window_start) at time zone sender.timezone;
   else scheduled:=now(); end if;
   begin
    new_outbox:=public.enqueue_approved_email(plan.org_id,step.draft_id,p_identifier_hash,p_recipient_email,scheduled,enrollment.approved_by);
    select * into queued from public.email_outbox where id=new_outbox and org_id=plan.org_id;
    if queued.sender_connection_id<>plan.sender_connection_id or queued.provider_thread_id<>plan.provider_thread_id then raise exception 'SEQUENCE_SENDER_OR_THREAD_MISMATCH'; end if;
    update public.email_sequence_steps set outbox_id=new_outbox where enrollment_id=p_enrollment and step_number=step.step_number;
    update public.sequence_enrollments set next_run_at=greatest(now()+interval '5 minutes',scheduled+interval '5 minutes') where id=p_enrollment;
    update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=null where enrollment_id=p_enrollment;
    insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context)
    values(plan.org_id,'email_sequence_step_queued','sequence_enrollments',p_enrollment,jsonb_build_object('step',step.step_number,'outbox_id',new_outbox));
    return 'queued';
   exception when others then reason:=left(SQLERRM,80);
   end;
  end if;
 end if;
 update public.sequence_enrollments set state='paused',next_run_at=null where id=p_enrollment;
 update public.email_sequence_plans set lease_token=null,lease_until=null,last_error_code=reason where enrollment_id=p_enrollment;
 insert into public.notifications(org_id,title,kind) values(plan.org_id,'Email sequence needs review','email_sequence');
 return 'paused';
end $$;

revoke execute on function public.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz),public.set_email_sequence_state(uuid,uuid,text),public.lease_due_email_sequences(integer),public.advance_email_sequence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz),public.set_email_sequence_state(uuid,uuid,text) to authenticated;
grant execute on function public.lease_due_email_sequences(integer),public.advance_email_sequence(uuid,uuid,text,text) to service_role;
