-- Starter RLS draft, test thoroughly; sensitive writes go through verified server functions.
create schema if not exists private;

create or replace function private.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;
create or replace function private.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;
revoke all on function private.is_org_member(uuid) from public;
revoke all on function private.is_org_admin(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.is_org_admin(uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.leads enable row level security;
alter table public.contacts enable row level security;
alter table public.lead_evidence enable row level security;
alter table public.lead_scores enable row level security;
alter table public.consent_records enable row level security;
alter table public.suppressions enable row level security;
alter table public.campaigns enable row level security;
alter table public.outbound_drafts enable row level security;
alter table public.message_events enable row level security;
alter table public.jobs enable row level security;
alter table public.tasks enable row level security;
alter table public.appointments enable row level security;
alter table public.audit_events enable row level security;

create policy org_select on public.organizations for select to authenticated
  using (private.is_org_member(id));
-- Organizations and memberships bootstrapped by trusted admin backend only.
create policy membership_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or private.is_org_admin(org_id));

-- Lead and operational data: member may view, admin may mutate for M0.
create policy leads_select on public.leads for select to authenticated using (private.is_org_member(org_id));
create policy leads_insert on public.leads for insert to authenticated with check (private.is_org_admin(org_id));
create policy leads_update on public.leads for update to authenticated using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));
create policy leads_delete on public.leads for delete to authenticated using (private.is_org_admin(org_id));

create policy contacts_select on public.contacts for select to authenticated using (private.is_org_member(org_id));
create policy contacts_insert on public.contacts for insert to authenticated with check (private.is_org_admin(org_id));
create policy contacts_update on public.contacts for update to authenticated using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));
create policy contacts_delete on public.contacts for delete to authenticated using (private.is_org_admin(org_id));

create policy evidence_select on public.lead_evidence for select to authenticated using (private.is_org_member(org_id));
create policy evidence_insert on public.lead_evidence for insert to authenticated with check (private.is_org_admin(org_id));
create policy evidence_update on public.lead_evidence for update to authenticated using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));
create policy evidence_delete on public.lead_evidence for delete to authenticated using (private.is_org_admin(org_id));

create policy scores_select on public.lead_scores for select to authenticated using (private.is_org_member(org_id));
create policy scores_insert on public.lead_scores for insert to authenticated with check (private.is_org_admin(org_id));
-- Never allow client UPDATE/DELETE score history: append-only.

create policy consent_select on public.consent_records for select to authenticated using (private.is_org_member(org_id));
-- Consent updates performed only through trusted audited server-side function; no browser insert/update.

create policy suppress_select on public.suppressions for select to authenticated using (private.is_org_admin(org_id));
-- Suppression records modified exclusively through trusted server-side functions.

create policy campaigns_select on public.campaigns for select to authenticated using (private.is_org_member(org_id));
-- Campaign enablement requires trusted admin function and policy gate; no direct browser writes.

create policy drafts_select on public.outbound_drafts for select to authenticated using (private.is_org_member(org_id));
create policy drafts_insert on public.outbound_drafts for insert to authenticated with check (private.is_org_admin(org_id) and state in ('draft','needs_review'));
-- Approval/state changes are **server-side only**, no direct UPDATE policies.

create policy events_select on public.message_events for select to authenticated using (private.is_org_member(org_id));
create policy jobs_select on public.jobs for select to authenticated using (private.is_org_admin(org_id));
create policy tasks_select on public.tasks for select to authenticated using (private.is_org_member(org_id));
create policy tasks_insert on public.tasks for insert to authenticated with check (private.is_org_admin(org_id));
create policy tasks_update on public.tasks for update to authenticated using (private.is_org_admin(org_id)) with check (private.is_org_admin(org_id));
create policy appointments_select on public.appointments for select to authenticated using (private.is_org_member(org_id));
create policy audit_select on public.audit_events for select to authenticated using (private.is_org_admin(org_id));
-- Events, jobs, appointment writes and audit entries are performed only by trusted server-side operations.

-- IMPORTANT M0 SECURITY GAPS: cross-org foreign keys remain possible with service_role writes unless enforced
-- by additional composite FKs or triggers; add and test before live operation. RLS isn't full data validation.
