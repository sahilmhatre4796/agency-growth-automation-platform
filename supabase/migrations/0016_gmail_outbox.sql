-- Service-only transactional sender choice and fixed-sender delivery queue.
create function public.enqueue_approved_email(p_org uuid,p_draft uuid,p_identifier_hash text,p_recipient_email text,p_schedule timestamptz,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare org public.organizations; draft public.outbound_drafts; campaign public.campaigns;
 policy public.campaign_sender_policies; contact public.contacts; setting public.gmail_account_settings;
 chosen uuid; existing uuid; pinned uuid[]; n bigint; sent_today bigint; sent_month bigint; pool_cap integer; oid uuid; thread_ref text; reply_ref text; prior_subject text;
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
  order by (select count(*)::numeric/greatest(1,s.daily_cap) from public.email_outbox o where o.org_id=p_org and o.sender_connection_id=s.connection_id and o.state in ('queued','leased','uncertain','sent') and (o.scheduled_at at time zone s.timezone)::date=(p_schedule at time zone s.timezone)::date),s.connection_id
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
 update public.outbound_drafts set state='queued',updated_at=now() where id=draft.id and org_id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context) values(p_org,p_actor,'email_queued','email_outbox',oid,jsonb_build_object('sender_connection_id',chosen));
 return oid;
end $$;

create function public.lease_email_outbox(p_limit integer default 10)
returns setof public.email_outbox language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 -- A crashed worker may have sent successfully before its receipt was saved.
 -- Never re-lease that row for another provider send.
 update public.email_outbox set state='uncertain',last_error_code='LEASE_EXPIRED_UNCERTAIN',lease_token=null,lease_until=null,updated_at=now()
  where state='leased' and lease_until<now();
 update public.email_outbox set state='failed',last_error_code='MAX_ATTEMPTS',lease_token=null,lease_until=null,updated_at=now()
  where state='queued' and attempts>=3;
 return query with candidates as (select o.id from public.email_outbox o join public.gmail_account_settings s on s.connection_id=o.sender_connection_id
  where o.attempts<3 and o.scheduled_at<=now() and o.state='queued' and (s.send_after is null or s.send_after<=now())
  order by o.scheduled_at,o.id for update of o skip locked limit p_limit)
 update public.email_outbox o set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() from candidates c where o.id=c.id returning o.*;
end $$;

create function public.check_email_send_policy(p_id uuid,p_token uuid,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare o public.email_outbox; org public.organizations; setting public.gmail_account_settings; c public.external_connections; campaign public.campaigns; policy public.campaign_sender_policies; contact public.contacts; reserved bigint; pool_cap integer;
begin
 select * into o from public.email_outbox where id=p_id and lease_token=p_token and state='leased' and lease_until>now() for update;
 if not found then raise exception 'LEASE_INVALID'; end if;
 select * into org from public.organizations where id=o.org_id;
 select * into c from public.external_connections where id=o.sender_connection_id and org_id=o.org_id;
 select * into setting from public.gmail_account_settings where connection_id=o.sender_connection_id and org_id=o.org_id;
 select * into campaign from public.campaigns where id=o.campaign_id and org_id=o.org_id;
 select * into policy from public.campaign_sender_policies where campaign_id=o.campaign_id and org_id=o.org_id;
 select * into contact from public.contacts where id=o.contact_id and org_id=o.org_id;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_IDENTIFIER_HASH'; end if;
 if contact.id is null or lower(contact.email_normalized)<>lower(o.recipient_email) then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='CONTACT_EMAIL_CHANGED' where id=p_id; return 'held';
 end if;
 begin
  perform private.email_send_verification_gate(o.org_id,o.contact_id,o.recipient_email);
 exception when others then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='EMAIL_VERIFICATION_CHANGED' where id=p_id; return 'held';
 end;
 if org.outbound_paused or not org.email_live_approved or campaign.state<>'active' or c.state<>'connected' or c.verified_at is null or setting.paused or not setting.send_enabled or not ('https://www.googleapis.com/auth/gmail.send'=any(c.scopes))
   or org.email_daily_cap=0 or org.email_monthly_cap=0 or campaign.daily_send_cap=0 or setting.daily_cap=0 or setting.monthly_cap=0 or policy.campaign_id is null or policy.account_daily_cap=0 then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='POLICY_CHANGED' where id=p_id; return 'held';
 end if;
 if setting.send_after is not null and setting.send_after>now() then
  update public.email_outbox set state='queued',lease_token=null,lease_until=null,last_error_code='ACCOUNT_RATE_BACKOFF',scheduled_at=greatest(scheduled_at,setting.send_after) where id=p_id; return 'backoff';
 end if;
 if (o.scheduled_at at time zone org.email_timezone)::date<>(now() at time zone org.email_timezone)::date
   or (o.scheduled_at at time zone setting.timezone)::date<>(now() at time zone setting.timezone)::date then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='SCHEDULE_DAY_MISSED' where id=p_id; return 'held';
 end if;
 if not (case policy.mode
   when 'single' then o.sender_connection_id=policy.single_connection_id
   when 'manual' then exists(select 1 from public.lead_sender_assignments a where a.campaign_id=o.campaign_id and a.lead_id=o.lead_id and a.connection_id=o.sender_connection_id and a.org_id=o.org_id)
   when 'selected' then exists(select 1 from public.campaign_sender_accounts a where a.campaign_id=o.campaign_id and a.connection_id=o.sender_connection_id and a.enabled and a.daily_cap>0 and a.org_id=o.org_id)
   else policy.mode='all_enabled' end) then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='SENDER_POLICY_CHANGED' where id=p_id; return 'held';
 end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date;
 if reserved>org.email_daily_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='ORGANIZATION_DAILY_CAP' where id=p_id; return 'held'; end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and state in ('queued','leased','uncertain','sent') and date_trunc('month',scheduled_at at time zone org.email_timezone)=date_trunc('month',now() at time zone org.email_timezone);
 if reserved>org.email_monthly_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='ORGANIZATION_MONTHLY_CAP' where id=p_id; return 'held'; end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and campaign_id=o.campaign_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone org.email_timezone)::date=(now() at time zone org.email_timezone)::date;
 if reserved>campaign.daily_send_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='CAMPAIGN_DAILY_CAP' where id=p_id; return 'held'; end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and sender_connection_id=o.sender_connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(now() at time zone setting.timezone)::date;
 if reserved>setting.daily_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='ACCOUNT_DAILY_CAP' where id=p_id; return 'held'; end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and sender_connection_id=o.sender_connection_id and state in ('queued','leased','uncertain','sent') and date_trunc('month',scheduled_at at time zone setting.timezone)=date_trunc('month',now() at time zone setting.timezone);
 if reserved>setting.monthly_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='ACCOUNT_MONTHLY_CAP' where id=p_id; return 'held'; end if;
 select count(*) into reserved from public.email_outbox where org_id=o.org_id and campaign_id=o.campaign_id and sender_connection_id=o.sender_connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(now() at time zone setting.timezone)::date;
 if reserved>policy.account_daily_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='CAMPAIGN_ACCOUNT_CAP' where id=p_id; return 'held'; end if;
 if policy.mode='selected' then
  select daily_cap into pool_cap from public.campaign_sender_accounts where org_id=o.org_id and campaign_id=o.campaign_id and connection_id=o.sender_connection_id;
  select count(*) into reserved from public.email_outbox where org_id=o.org_id and campaign_id=o.campaign_id and sender_connection_id=o.sender_connection_id and state in ('queued','leased','uncertain','sent') and (scheduled_at at time zone setting.timezone)::date=(now() at time zone setting.timezone)::date;
  if reserved>pool_cap then update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='POOL_DAILY_CAP' where id=p_id; return 'held'; end if;
 end if;
 if exists(select 1 from public.suppressions where org_id=o.org_id and channel in ('email','all') and identifier_hash=p_identifier_hash) or not exists(select 1 from public.consent_records cr where cr.org_id=o.org_id and cr.contact_id=o.contact_id and cr.channel='email' and cr.state in ('permitted','opted_in') and cr.revoked_at is null and cr.purpose=campaign.purpose and cr.id=(select id from public.consent_records where org_id=o.org_id and contact_id=o.contact_id and channel='email' order by recorded_at desc,id desc limit 1)) then
  update public.email_outbox set state='suppressed',lease_token=null,lease_until=null,last_error_code='PERMISSION_REVOKED' where id=p_id; return 'suppressed';
 end if;
 if (now() at time zone setting.timezone)::time < setting.window_start or (now() at time zone setting.timezone)::time>=setting.window_end then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='OUTSIDE_WINDOW' where id=p_id; return 'held';
 end if;
 return 'eligible';
end $$;

create function public.finish_email_outbox(p_id uuid,p_token uuid,p_state text,p_error text default null,p_provider_id text default null,p_thread_id text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.email_outbox;
begin
 if p_state not in ('sent','uncertain','held','failed','queued') then raise exception 'INVALID_FINISH_STATE'; end if;
 select * into o from public.email_outbox where id=p_id and lease_token=p_token and state='leased' and lease_until>now() for update;
 if not found then return false; end if;
 if p_state='sent' and (p_provider_id is null or p_thread_id is null) then raise exception 'PROVIDER_RECEIPT_REQUIRED'; end if;
 update public.email_outbox set state=case when p_state='queued' and attempts>=3 then 'failed' else p_state end,
  provider_message_id=case when p_state='sent' then p_provider_id else provider_message_id end,
  provider_thread_id=case when p_state='sent' then p_thread_id else provider_thread_id end,
  last_error_code=left(p_error,80),lease_token=null,lease_until=null,
  scheduled_at=case when p_state='queued' then now()+make_interval(secs=>least(3600,power(2,attempts)::integer*30)) else scheduled_at end,updated_at=now() where id=p_id;
 if p_state='sent' then
  insert into public.message_events(org_id,lead_id,contact_id,draft_id,provider,provider_message_id,provider_thread_id,direction,event_type,safe_metadata)
  values(o.org_id,o.lead_id,o.contact_id,o.draft_id,'gmail',o.sender_connection_id::text||':'||p_provider_id,p_thread_id,'outbound','provider_accepted',jsonb_build_object('sender_connection_id',o.sender_connection_id)) on conflict do nothing;
  insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(o.org_id,'email_provider_accepted','email_outbox',o.id,jsonb_build_object('sender_connection_id',o.sender_connection_id));
 end if;
 return true;
end $$;

revoke execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid),public.lease_email_outbox(integer),public.check_email_send_policy(uuid,uuid,text),public.finish_email_outbox(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid),public.lease_email_outbox(integer),public.check_email_send_policy(uuid,uuid,text),public.finish_email_outbox(uuid,uuid,text,text,text,text) to service_role;
