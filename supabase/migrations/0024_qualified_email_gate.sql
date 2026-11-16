-- Existing Gmail policy remains intact behind a new qualification check.
create function private.require_current_qualification(p_org uuid,p_lead uuid)
returns void language plpgsql security definer set search_path='' as $$
declare q public.lead_qualifications; lead public.leads;
begin
 select * into lead from public.leads where org_id=p_org and id=p_lead;
 if not found or lead.is_demo or lead.status in ('disqualified','lost','won') then raise exception 'LEAD_NOT_ELIGIBLE'; end if;
 select * into q from public.lead_qualifications where org_id=p_org and lead_id=p_lead order by evaluated_at desc,id desc limit 1;
 if not found or q.status<>'QUALIFIED' or q.evaluated_at<=now()-interval '30 days' then raise exception 'CURRENT_QUALIFICATION_REQUIRED'; end if;
 if not exists(select 1 from public.service_catalog s where s.org_id=p_org and s.id=q.primary_service_id and s.status in ('active','custom_quote'))
   then raise exception 'APPROVED_SERVICE_REQUIRED'; end if;
 if not exists(select 1 from public.lead_service_matches m where m.org_id=p_org and m.lead_id=p_lead and m.service_id=q.primary_service_id
   and m.status='verified_gap' and m.id=(select id from public.lead_service_matches where org_id=p_org and lead_id=p_lead and service_id=q.primary_service_id order by assessed_at desc,id desc limit 1))
   then raise exception 'CURRENT_SERVICE_GAP_REQUIRED'; end if;
end $$;
revoke execute on function private.require_current_qualification(uuid,uuid) from public,anon,authenticated,service_role;

alter function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) set schema private;
alter function private.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) rename to enqueue_approved_email_legacy;
revoke execute on function private.enqueue_approved_email_legacy(uuid,uuid,text,text,timestamptz,uuid) from public,anon,authenticated,service_role;
create function public.enqueue_approved_email(p_org uuid,p_draft uuid,p_identifier_hash text,p_recipient_email text,p_schedule timestamptz,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare draft public.outbound_drafts;
begin
 select * into draft from public.outbound_drafts where org_id=p_org and id=p_draft;
 if not found then raise exception 'DRAFT_NOT_FOUND'; end if;
 perform private.require_current_qualification(p_org,draft.lead_id);
 return private.enqueue_approved_email_legacy(p_org,p_draft,p_identifier_hash,p_recipient_email,p_schedule,p_actor);
end $$;
revoke execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_approved_email(uuid,uuid,text,text,timestamptz,uuid) to service_role;

alter function public.check_email_send_policy(uuid,uuid,text) set schema private;
alter function private.check_email_send_policy(uuid,uuid,text) rename to check_email_send_policy_legacy;
revoke execute on function private.check_email_send_policy_legacy(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.check_email_send_policy(p_id uuid,p_token uuid,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare outgoing public.email_outbox;
begin
 select * into outgoing from public.email_outbox where id=p_id and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'LEASE_INVALID'; end if;
 begin
  perform private.require_current_qualification(outgoing.org_id,outgoing.lead_id);
 exception when others then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,last_error_code='QUALIFICATION_CHANGED',updated_at=now() where id=p_id;
  return 'held';
 end;
 return private.check_email_send_policy_legacy(p_id,p_token,p_identifier_hash);
end $$;
revoke execute on function public.check_email_send_policy(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.check_email_send_policy(uuid,uuid,text) to service_role;
