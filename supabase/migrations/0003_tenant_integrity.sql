-- Core hardening; unrelated to the optional voice migration.
-- Composite keys prevent even privileged writes from mixing tenants.
do $$
declare t text;
begin
  foreach t in array array['leads','contacts','campaigns','outbound_drafts'] loop
    execute format('alter table public.%I add unique (org_id,id)',t);
  end loop;
end $$;
alter table public.contacts add unique(org_id,lead_id,id);
alter table public.contacts add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.lead_evidence add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.lead_scores add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.consent_records add foreign key(org_id,contact_id) references public.contacts(org_id,id);
alter table public.outbound_drafts add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.outbound_drafts add foreign key(org_id,lead_id,contact_id) references public.contacts(org_id,lead_id,id);
alter table public.outbound_drafts add foreign key(org_id,campaign_id) references public.campaigns(org_id,id);
alter table public.message_events add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.message_events add foreign key(org_id,contact_id) references public.contacts(org_id,id);
alter table public.message_events add foreign key(org_id,draft_id) references public.outbound_drafts(org_id,id);
alter table public.tasks add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.appointments add foreign key(org_id,lead_id) references public.leads(org_id,id);
alter table public.appointments add foreign key(org_id,lead_id,attendee_contact_id) references public.contacts(org_id,lead_id,id);
drop policy drafts_insert on public.outbound_drafts;
create policy drafts_insert on public.outbound_drafts for insert to authenticated
with check(private.is_org_admin(org_id) and state in ('draft','needs_review') and approval_by is null and approved_at is null and approved_sha256 is null);

-- Explicit grants: policies do not grant SQL privileges by themselves.
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant insert,update,delete on public.leads,public.contacts,public.lead_evidence to authenticated;
grant insert on public.lead_scores,public.outbound_drafts to authenticated;
grant insert,update on public.tasks to authenticated;

create function private.touch_updated_at() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
create trigger leads_touch before update on public.leads for each row execute function private.touch_updated_at();

create function private.audit_crm_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
  values(coalesce(new.org_id,old.org_id),auth.uid(),lower(tg_op),tg_table_name,coalesce(new.id,old.id));
  return coalesce(new,old);
end $$;
revoke all on function private.audit_crm_change() from public;
create trigger leads_audit after insert or update or delete on public.leads for each row execute function private.audit_crm_change();
create trigger contacts_audit after insert or update or delete on public.contacts for each row execute function private.audit_crm_change();
create trigger evidence_audit after insert or update or delete on public.lead_evidence for each row execute function private.audit_crm_change();
