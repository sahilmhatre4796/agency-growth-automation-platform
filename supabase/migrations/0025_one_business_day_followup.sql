-- One previously approved follow-up is the maximum; the default wait is two business days.
alter table public.organizations add column followup_wait_business_days smallint not null default 2 check(followup_wait_business_days between 1 and 2);

create function public.set_followup_wait_days(p_org uuid,p_days smallint)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_days not between 1 and 2 then raise exception 'INVALID_FOLLOWUP_WAIT'; end if;
 update public.organizations set followup_wait_business_days=p_days where id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'followup_wait_changed','organizations',p_org,jsonb_build_object('business_days',p_days));
end $$;
revoke execute on function public.set_followup_wait_days(uuid,smallint) from public,anon,authenticated;
grant execute on function public.set_followup_wait_days(uuid,smallint) to authenticated;

create function private.followup_earliest(p_sent timestamptz,p_days smallint,p_timezone text,p_window_start time)
returns timestamptz language plpgsql stable set search_path='' as $$
declare local_sent timestamp; candidate date; counted integer:=0; due_time time;
begin
 if p_days not between 1 and 2 then raise exception 'INVALID_FOLLOWUP_WAIT'; end if;
 local_sent:=p_sent at time zone p_timezone;
 candidate:=local_sent::date;
 while counted<p_days loop
  candidate:=candidate+1;
  if extract(isodow from candidate) between 1 and 5 then counted:=counted+1; end if;
 end loop;
 due_time:=greatest(local_sent::time,p_window_start);
 return (candidate+due_time) at time zone p_timezone;
end $$;
revoke execute on function private.followup_earliest(timestamptz,smallint,text,time) from public,anon,authenticated;
grant execute on function private.followup_earliest(timestamptz,smallint,text,time) to service_role;

alter function public.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz) set schema private;
alter function private.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz) rename to create_email_sequence_legacy;
revoke execute on function private.create_email_sequence_legacy(uuid,uuid,uuid,timestamptz,uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.create_email_sequence(p_org uuid,p_first_outbox uuid,p_step1_draft uuid,p_step1_at timestamptz,p_step2_draft uuid default null,p_step2_at timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare original public.email_outbox; sender public.gmail_account_settings; org public.organizations; earliest timestamptz;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_step2_draft is not null or p_step2_at is not null then raise exception 'ONE_FOLLOWUP_MAXIMUM'; end if;
 select * into original from public.email_outbox where org_id=p_org and id=p_first_outbox and state='sent';
 if not found then raise exception 'SENT_CONVERSATION_REQUIRED'; end if;
 select * into sender from public.gmail_account_settings where org_id=p_org and connection_id=original.sender_connection_id;
 select * into org from public.organizations where id=p_org;
 if sender.connection_id is null or org.id is null then raise exception 'SENDER_SETTINGS_MISSING'; end if;
 earliest:=private.followup_earliest(original.updated_at,org.followup_wait_business_days,sender.timezone,sender.window_start);
 if p_step1_at<earliest then raise exception 'FOLLOWUP_BUSINESS_DAY_WAIT_REQUIRED'; end if;
 return private.create_email_sequence_legacy(p_org,p_first_outbox,p_step1_draft,p_step1_at,null,null);
end $$;
revoke execute on function public.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.create_email_sequence(uuid,uuid,uuid,timestamptz,uuid,timestamptz) to authenticated;

-- Older locally planned two-step records remain visible, but the worker may never queue step two.
alter function public.advance_email_sequence(uuid,uuid,text,text) set schema private;
alter function private.advance_email_sequence(uuid,uuid,text,text) rename to advance_email_sequence_legacy;
revoke execute on function private.advance_email_sequence_legacy(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.advance_email_sequence(p_enrollment uuid,p_token uuid,p_identifier_hash text,p_recipient_email text)
returns text language plpgsql security definer set search_path='' as $$
declare plan public.email_sequence_plans; enrollment public.sequence_enrollments; result text;
begin
 select * into plan from public.email_sequence_plans where enrollment_id=p_enrollment and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'SEQUENCE_LEASE_INVALID'; end if;
 select * into enrollment from public.sequence_enrollments where id=p_enrollment and org_id=plan.org_id for update;
 if enrollment.followups_sent>=1 then
  update public.sequence_enrollments set state='completed',next_run_at=null where id=p_enrollment;
  update public.email_sequence_plans set lease_token=null,lease_until=null where enrollment_id=p_enrollment;
  return 'completed';
 end if;
 result:=private.advance_email_sequence_legacy(p_enrollment,p_token,p_identifier_hash,p_recipient_email);
 if result='next_step' then
  update public.sequence_enrollments set state='completed',next_run_at=null where id=p_enrollment;
  return 'completed';
 end if;
 return result;
end $$;
revoke execute on function public.advance_email_sequence(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.advance_email_sequence(uuid,uuid,text,text) to service_role;
