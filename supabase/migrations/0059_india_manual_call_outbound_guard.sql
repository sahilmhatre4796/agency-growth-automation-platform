-- Indian business prospects are reserved for owner-managed manual calling.
-- This guard covers new queue rows, leasing, and the final pre-send check.
-- It changes no existing lead, contact, consent, or outbox row.

create function private.block_india_email_outbox()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state in ('queued','leased','sent') and exists(
  select 1 from public.leads l where l.org_id=new.org_id and l.id=new.lead_id
   and lower(trim(coalesce(l.country,''))) in ('india','in','bharat')
 ) then raise exception 'INDIA_MANUAL_CALL_ONLY'; end if;
 return new;
end $$;
revoke execute on function private.block_india_email_outbox() from public,anon,authenticated,service_role;

create trigger block_india_email_outbox before insert or update of state,org_id,lead_id
on public.email_outbox for each row execute function private.block_india_email_outbox();

alter function public.check_email_send_policy(uuid,uuid,text) set schema private;
alter function private.check_email_send_policy(uuid,uuid,text) rename to check_email_send_policy_before_india_guard;
revoke execute on function private.check_email_send_policy_before_india_guard(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.check_email_send_policy(p_id uuid,p_token uuid,p_identifier_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare outgoing public.email_outbox;
begin
 select * into outgoing from public.email_outbox where id=p_id and state='leased'
  and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'LEASE_INVALID'; end if;
 if exists(select 1 from public.leads l where l.org_id=outgoing.org_id and l.id=outgoing.lead_id
   and lower(trim(coalesce(l.country,''))) in ('india','in','bharat')) then
  update public.email_outbox set state='held',lease_token=null,lease_until=null,
   last_error_code='INDIA_MANUAL_CALL_ONLY',updated_at=now() where id=p_id;
  return 'held';
 end if;
 return private.check_email_send_policy_before_india_guard(p_id,p_token,p_identifier_hash);
end $$;
revoke execute on function public.check_email_send_policy(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.check_email_send_policy(uuid,uuid,text) to service_role;
