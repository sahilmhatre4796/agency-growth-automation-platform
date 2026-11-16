-- Idempotency key for intake-handoff preview requests only.
-- One row per (org_id, lead_id, 'intake_handoff_preview').
-- Preserves existing multi-draft preview workflows (no org_id key = untouched).
create table public.intake_handoff_preview_idempotent (
  org_id uuid not null,
  lead_id uuid not null,
  operation text not null default 'intake_handoff_preview',
  claim_token uuid,
  lease_until timestamptz,
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  preview_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(org_id, lead_id, operation),
  foreign key(org_id, lead_id) references public.leads(org_id, id) on delete cascade
);
alter table public.intake_handoff_preview_idempotent enable row level security;
create policy intake_handoff_preview_idempotent_admin_read on public.intake_handoff_preview_idempotent
  for select to authenticated using(private.is_org_admin(org_id));
create policy intake_handoff_preview_idempotent_service_role_all on public.intake_handoff_preview_idempotent
  for all to service_role;
grant select on public.intake_handoff_preview_idempotent to authenticated;
grant select, insert, update, delete on public.intake_handoff_preview_idempotent to service_role;

-- Atomically claim the idempotency key. Returns empty if already owned.
-- Aliased/qualified refs + targetless ON CONFLICT: named conflict-target columns
-- and bare RETURNING columns collide with the OUT params (plpgsql ambiguity).
-- The table's only unique constraint is the primary key, so targetless
-- DO NOTHING is equivalent.
create or replace function public.claim_intake_handoff_preview_idempotent(
  p_org_id uuid, p_lead_id uuid
)
returns table (org_id uuid, lead_id uuid, claim_token uuid, lease_until timestamptz, status text, preview_id uuid, result jsonb)
language plpgsql as $$
begin
  return query
  insert into public.intake_handoff_preview_idempotent as i (org_id, lead_id, operation, claim_token, lease_until, status)
  values (p_org_id, p_lead_id, 'intake_handoff_preview', gen_random_uuid(), now() + interval '5 minutes', 'processing')
  on conflict do nothing
  returning i.org_id, i.lead_id, i.claim_token, i.lease_until, i.status, i.preview_id, i.result;
end;
$$;

-- Atomically reclaim expired processing leases (fresh token, stays processing).
create or replace function public.reclaim_expired_intake_handoff_preview_leases(p_ttl_min integer)
returns table (org_id uuid, lead_id uuid, claim_token uuid, lease_until timestamptz)
language plpgsql as $$
begin
  return query
  update public.intake_handoff_preview_idempotent q
  set claim_token = gen_random_uuid(),
      lease_until = now() + (p_ttl_min || ' minutes')::interval
  where q.status = 'processing'
    and q.lease_until < now()
  returning q.org_id, q.lead_id, q.claim_token, q.lease_until;
end;
$$;

-- Atomically finalize: record preview_id + result + complete status for the owning token.
-- Returns true only when this token owned a processing row; false on a stale/zero-row
-- no-op so callers never treat a lost lease as success.
create or replace function public.finalize_intake_handoff_preview(
  p_org_id uuid, p_lead_id uuid, p_claim_token uuid, p_preview_id uuid, p_result jsonb, p_status text
)
returns boolean language plpgsql as $$
begin
  update public.intake_handoff_preview_idempotent
  set preview_id = p_preview_id,
      status = p_status,
      result = p_result,
      completed_at = now()
  where org_id = p_org_id
    and lead_id = p_lead_id
    and operation = 'intake_handoff_preview'
    and claim_token = p_claim_token
    and status = 'processing';
  return found;
end;
$$;

revoke all on function public.claim_intake_handoff_preview_idempotent(uuid, uuid) from public, anon;
revoke all on function public.reclaim_expired_intake_handoff_preview_leases(integer) from public, anon;
revoke all on function public.finalize_intake_handoff_preview(uuid, uuid, uuid, uuid, jsonb, text) from public, anon;
