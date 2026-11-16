-- Preserve all queue policy checks and replace only sender ordering.
-- Connected Gmail accounts rotate by connection order; a paused account is skipped.
-- Existing conversations remain pinned to their original sender.
create table public.gmail_rotation_cursors (
 org_id uuid primary key references public.organizations(id) on delete cascade,
 last_connection_id uuid not null,
 updated_at timestamptz not null default now(),
 foreign key(org_id,last_connection_id) references public.external_connections(org_id,id)
);
alter table public.gmail_rotation_cursors enable row level security;
revoke all on public.gmail_rotation_cursors from public,anon,authenticated;
grant select,insert,update on public.gmail_rotation_cursors to service_role;

create or replace function public.enqueue_approved_email(p_org uuid,p_draft uuid,p_identifier_hash text,p_recipient_email text,p_schedule timestamptz,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare org public.organizations; draft public.outbound_drafts; campaign public.campaigns;
 policy public.campaign_sender_policies; contact public.contacts; setting public.gmail_account_settings;
 chosen uuid; existing uuid; last_sender uuid; pinned uuid[]; n bigint; sent_today bigint; sent_month bigint; pool_cap integer; oid uuid; thread_ref text; reply_ref text; prior_subject text;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') then raise exception 'FORBIDDEN'; end if;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' or p_schedule<now()-interval '1 minute' or p_schedule>now()+interval '30 days' then raise exception 'INVALID_QUEUE_REQUEST'; end if;
 select id into existing from public.email_outbox where org_id=p_org and draft_id=p_draft and state in ('queued','leased','sent');
 if found then return existing; end if;
 if exists(select 1 from public.email_outbox where org_id=p_org and draft_id=p_draft) then raise exception 'OUTBOX_REVIEW_REQUIRED'; end if;
 select * into org from public.organizations where id=p_org for update;
 if not found or org.outbound_paused or not org.email_live_approved or org.email_daily_cap=0 or org.email_monthly_cap=0 then raise exception 'EMAIL_NOT_ENABLED'; end if;
 select * into draft from public.outbound_drafts where org_id=p_org and id=p_draft for update;
 if not found or draft.channel<>'email' or draft.state<>'approved' or draft.approval_by is null or draft.approved_at is null or not draft.claims_reviewed or draft.campaign_id is null then raise exception 'DRAFT_NOT_APPROVED'; end if;
 if draft.approved_sha256<>encode(sha256(convert_to(coalesce(draft.subject,'')||chr(10)||draft.body,'UTF8')),'hex') then raise exception 'STALE_APPROVAL'; end if;
 select * into campaign from public.campaigns where id=draft.campaign_id and org_id=p_org and channel='email' and state='active' for update;
 if not found or campaign.daily_send_cap=0 or campaign.purpose is null then raise exception 'CAMPAIGN_NOT_ACTIVE'; end if;
 select * into contact from public.contacts where org_id=p_org and id=draft.contact_id and lead_id=draft.lead_id and email_normalized is not null;
 if not found then raise exception 'EMAIL_CONTACT_REQUIRED'; end if;
 if lower(trim(p_recipient_email))<>lower(contact.email_normalized) then raise exception 'CONTACT_EMAIL_CHANGED'; end if;
 perform private.email_send_verification_gate(p_org,contact.id,contact.email_normalized);
 if exists(select 1 from public.suppressions where org_id=p_org and channel in ('email','all') and identifier_hash=p_identifier_hash) then raise exception 'EMAIL_SUPPRESSED'; end if;
 if not exists(select 1 from public.consent_records cr where cr.org_id=p_org and cr.contact_id=contact.id and cr.channel='email'
   and cr.state in ('permitted','opted_in') and cr.revoked_at is null and cr.purpose=campaign.purpose
   and cr.id=(select id from public.consent_records where org_id=p_org and contact_id=contact.id and channel='email' order by recorded_at desc,id desc limit 1)) then raise exception 'EMAIL_PERMISSION_REQUIRED'; end if;
 select * into policy from public.campaign_sender_policies where org_id=p_org and campaign_id=campaign.id;
 if not found or policy.account_daily_cap=0 then raise exception 'SENDER_POLICY_REQUIRED'; end if;
 select array_agg(distinct connection_id) into pinned from (
  select connection_id from public.gmail_threads where org_id=p_org and contact_id=contact.id and campaign_id=campaign.id
  union select sender_connection_id from public.email_outbox where org_id=p_org and contact_id=contact.id and campaign_id=campaign.id and state='sent'
 ) prior;
 if coalesce(array_length(pinned,1),0)>1 then raise exception 'MULTIPLE_EXISTING_SENDERS_REVIEW'; end if;
 select last_connection_id into last_sender from public.gmail_rotation_cursors where org_id=p_org;
 select count(*) into n from public.email_outbox where org_id=p_org and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone org.email_timezone)::date=(p_schedule at time zone org.email_timezone)::date;
 if n>=org.email_daily_cap then raise exception 'ORGANIZATION_DAILY_CAP'; end if;
 select count(*) into n from public.email_outbox where org_id=p_org and state in ('queued','leased','uncertain','sent') and date_trunc('month',scheduled_at at time zone org.email_timezone)=date_trunc('month',p_schedule at time zone org.email_timezone);
 if n>=org.email_monthly_cap then raise exception 'ORGANIZATION_MONTHLY_CAP'; end if;
 select count(*) into n from public.email_outbox where org_id=p_org and campaign_id=campaign.id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone org.email_timezone)::date=(p_schedule at time zone org.email_timezone)::date;
 if n>=campaign.daily_send_cap then raise exception 'CAMPAIGN_DAILY_CAP'; end if;
 for setting in select s.* from public.gmail_account_settings s join public.external_connections c on c.id=s.connection_id and c.org_id=s.org_id
  where s.org_id=p_org and c.provider='gmail' and c.state='connected' and c.verified_at is not null and 'https://www.googleapis.com/auth/gmail.send'=any(c.scopes)
   and s.send_enabled and not s.paused and (s.send_after is null or s.send_after<=p_schedule) and s.daily_cap>0 and s.monthly_cap>0
   and (coalesce(array_length(pinned,1),0)=0 or s.connection_id=pinned[1])
   and (case policy.mode
       when 'single' then s.connection_id=policy.single_connection_id
       when 'manual' then exists(select 1 from public.lead_sender_assignments a where a.org_id=p_org and a.campaign_id=campaign.id and a.lead_id=draft.lead_id and a.connection_id=s.connection_id)
       when 'selected' then exists(select 1 from public.campaign_sender_accounts a where a.org_id=p_org and a.campaign_id=campaign.id and a.connection_id=s.connection_id and a.enabled and a.daily_cap>0)
       else policy.mode='all_enabled' end)
  order by case when last_sender is null then 0 when (c.created_at,c.id) > (select previous.created_at,previous.id from public.external_connections previous where previous.org_id=p_org and previous.id=last_sender) then 0 else 1 end,c.created_at,c.id
 loop
  if (p_schedule at time zone setting.timezone)::time < setting.window_start or (p_schedule at time zone setting.timezone)::time >= setting.window_end then continue; end if;
  if setting.signature<>'' and right(trim(draft.body),length(trim(setting.signature)))<>trim(setting.signature) then raise exception 'SIGNATURE_REVIEW_REQUIRED'; end if;
  select count(*) into sent_today from public.email_outbox where org_id=p_org and sender_connection_id=setting.connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(p_schedule at time zone setting.timezone)::date;
  select count(*) into sent_month from public.email_outbox where org_id=p_org and sender_connection_id=setting.connection_id and state in ('queued','leased','uncertain','sent') and date_trunc('month',scheduled_at at time zone setting.timezone)=date_trunc('month',p_schedule at time zone setting.timezone);
  if sent_today>=setting.daily_cap or sent_month>=setting.monthly_cap then continue; end if;
  select count(*) into n from public.email_outbox where org_id=p_org and campaign_id=campaign.id and sender_connection_id=setting.connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(p_schedule at time zone setting.timezone)::date;
  if n>=policy.account_daily_cap then continue; end if;
  if policy.mode='selected' then
   select a.daily_cap into pool_cap from public.campaign_sender_accounts a where a.org_id=p_org and a.campaign_id=campaign.id and a.connection_id=setting.connection_id;
   select count(*) into n from public.email_outbox where org_id=p_org and campaign_id=campaign.id and sender_connection_id=setting.connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(p_schedule at time zone setting.timezone)::date;
   if n>=pool_cap then continue; end if;
  end if;
  chosen:=setting.connection_id; exit;
 end loop;
 if chosen is null then raise exception 'NO_ELIGIBLE_SENDER'; end if;
 if coalesce(array_length(pinned,1),0)=1 then
  select t.provider_thread_id,m.rfc_message_id,t.subject into thread_ref,reply_ref,prior_subject
  from public.gmail_threads t left join lateral (select rfc_message_id from public.gmail_messages where thread_id=t.id and rfc_message_id is not null order by occurred_at desc limit 1) m on true
  where t.org_id=p_org and t.contact_id=contact.id and t.campaign_id=campaign.id and t.connection_id=chosen
  order by t.last_message_at desc limit 1;
  if thread_ref is null or reply_ref is null then
   select o.provider_thread_id,'<'||o.id||'@'||split_part(c.provider_account_id,'@',2)||'>',o.subject into thread_ref,reply_ref,prior_subject
   from public.email_outbox o join public.external_connections c on c.id=o.sender_connection_id
   where o.org_id=p_org and o.contact_id=contact.id and o.campaign_id=campaign.id and o.sender_connection_id=chosen and o.state='sent'
   order by o.updated_at desc limit 1;
  end if;
  if thread_ref is null or reply_ref is null then raise exception 'THREAD_REFERENCE_REQUIRED'; end if;
  if lower(regexp_replace(coalesce(draft.subject,''),'^(re:\s*)+','','i'))<>lower(regexp_replace(coalesce(prior_subject,''),'^(re:\s*)+','','i')) then raise exception 'THREAD_SUBJECT_MISMATCH'; end if;
 end if;
 insert into public.email_outbox(org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at,provider_thread_id,reply_to_rfc_id)
 values(p_org,campaign.id,draft.id,draft.lead_id,contact.id,chosen,contact.email_normalized,coalesce(draft.subject,''),draft.body,draft.approved_sha256,setting.sender_name,draft.id::text,p_schedule,thread_ref,reply_ref) returning id into oid;
 if policy.mode in ('selected','all_enabled') and coalesce(array_length(pinned,1),0)=0 then
  insert into public.gmail_rotation_cursors(org_id,last_connection_id) values(p_org,chosen)
   on conflict(org_id) do update set last_connection_id=excluded.last_connection_id,updated_at=now();
 end if;
 update public.outbound_drafts set state='queued',updated_at=now() where id=draft.id and org_id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context) values(p_org,p_actor,'email_queued','email_outbox',oid,jsonb_build_object('sender_connection_id',chosen));
 return oid;
end $$;

revoke execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) to service_role;
