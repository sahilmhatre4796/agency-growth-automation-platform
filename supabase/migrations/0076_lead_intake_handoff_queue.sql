-- Lead intake-handoff queue: one persistent record per (org_id, lead_id).
-- Atomic claim/reclaim via SQL functions with claim_token + lease_until.
-- No pending-state window between reclaim and claim: both assign claimed state directly.
create table public.lead_intake_handoff_queue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  lead_id uuid not null,
  source_run_id uuid,
  stage text not null default 'qualification' check (stage in ('qualification','preview')),
  state text not null default 'pending' check (state in ('pending','claimed','completed','failed','manual_review')),
  attempt_count integer not null default 0,
  last_error text,
  next_retry_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(org_id, lead_id),
  foreign key(org_id, lead_id) references public.leads(org_id, id) on delete cascade
);
alter table public.lead_intake_handoff_queue enable row level security;
create policy lead_intake_handoff_queue_admin_read on public.lead_intake_handoff_queue
  for select to authenticated using(private.is_org_admin(org_id));
create policy lead_intake_handoff_queue_service_role_all on public.lead_intake_handoff_queue
  for all to service_role;
grant select on public.lead_intake_handoff_queue to authenticated;
grant select, insert, update, delete on public.lead_intake_handoff_queue to service_role;
create index lead_intake_handoff_queue_claim on public.lead_intake_handoff_queue(org_id, state, next_retry_at);

-- Atomically claim up to p_limit pending rows for this org.
-- Aliased + qualified references: unqualified columns collide with RETURNS TABLE
-- OUT params (plpgsql raises "column reference is ambiguous" at runtime).
create or replace function public.claim_intake_handoff_queue_rows(p_org_id uuid, p_limit integer)
returns table (id uuid, org_id uuid, lead_id uuid, stage text, claim_token uuid, lease_until timestamptz, attempt_count integer)
language plpgsql as $$
begin
  return query
  with locked as (
    select lq.id
    from public.lead_intake_handoff_queue lq
    where lq.org_id = p_org_id
      and lq.state = 'pending'
      and (lq.next_retry_at is null or lq.next_retry_at <= now())
    order by lq.next_retry_at
    limit p_limit
    for update skip locked
  )
  update public.lead_intake_handoff_queue q
  set state = 'claimed',
      claim_token = gen_random_uuid(),
      lease_until = now() + interval '5 minutes'
  from locked l
  where q.id = l.id
  returning q.id, q.org_id, q.lead_id, q.stage, q.claim_token, q.lease_until, q.attempt_count;
end;
$$;

-- Atomically reclaim expired leases: assigns fresh token + lease in one UPDATE,
-- never passing through a pending state (no reclaim/claim race).
create or replace function public.reclaim_expired_intake_handoff_leases(p_org_id uuid, p_ttl_min integer)
returns table (id uuid, org_id uuid, lead_id uuid, stage text, claim_token uuid, lease_until timestamptz, attempt_count integer)
language plpgsql as $$
begin
  return query
  update public.lead_intake_handoff_queue q
  set state = 'claimed',
      claim_token = gen_random_uuid(),
      lease_until = now() + (p_ttl_min || ' minutes')::interval
  where q.org_id = p_org_id
    and q.state = 'claimed'
    and q.lease_until < now()
  returning q.id, q.org_id, q.lead_id, q.stage, q.claim_token, q.lease_until, q.attempt_count;
end;
$$;

-- Mark a queue row completed (owned by claim_token).
create or replace function public.complete_intake_handoff_queue_row(p_id uuid, p_claim_token uuid)
returns void language plpgsql as $$
begin
  update public.lead_intake_handoff_queue
  set state = 'completed',
      completed_at = now()
  where id = p_id
    and claim_token = p_claim_token
    and state = 'claimed';
end;
$$;

-- Mark a queue row failed with backoff (owned by claim_token).
create or replace function public.fail_intake_handoff_queue_row(
  p_id uuid, p_claim_token uuid, p_error text, p_next_retry_at timestamptz, p_attempt_count integer
)
returns void language plpgsql as $$
begin
  update public.lead_intake_handoff_queue
  set state = 'failed',
      last_error = p_error,
      next_retry_at = p_next_retry_at,
      attempt_count = p_attempt_count
  where id = p_id
    and claim_token = p_claim_token
    and state = 'claimed';
end;
$$;

-- Mark a queue row manual_review (terminal, no retry).
create or replace function public.manual_review_intake_handoff_queue_row(p_id uuid, p_claim_token uuid)
returns void language plpgsql as $$
begin
  update public.lead_intake_handoff_queue
  set state = 'manual_review',
      completed_at = now()
  where id = p_id
    and claim_token = p_claim_token
    and state = 'claimed';
end;
$$;

-- Idempotent backfill: insert pending queue rows for eligible leads in completed
-- discovery runs that lack a queue record. Safe to run repeatedly.
create or replace function public.reconcile_intake_handoff_queue(p_now timestamptz)
returns table (org_id uuid, lead_id uuid)
language plpgsql as $$
begin
  return query
  -- Targetless ON CONFLICT: a named conflict target (org_id, lead_id) collides
  -- with the OUT params of the same names. The queue's only unique constraint is
  -- its primary key, so targetless DO NOTHING is equivalent here.
  insert into public.lead_intake_handoff_queue as i (org_id, lead_id, source_run_id, stage, state, next_retry_at)
  select l.org_id, l.id, lds.discovery_run_id, 'qualification', 'pending', p_now
  from public.leads l
  join public.lead_discovery_sources lds on lds.lead_id = l.id and lds.org_id = l.org_id
  join public.discovery_runs dr on dr.id = lds.discovery_run_id and dr.org_id = l.org_id
  where dr.state = 'completed'
    and l.status not in ('disqualified', 'lost', 'won')
    and not l.is_demo
    and not exists (
      select 1 from public.lead_intake_handoff_queue q
      where q.org_id = l.org_id and q.lead_id = l.id
    )
  on conflict do nothing
  returning i.org_id, i.lead_id;
end;
$$;

-- Enqueue a single lead into the intake-handoff queue (idempotent).
create or replace function public.enqueue_intake_handoff_queue(p_org uuid, p_lead uuid, p_run uuid)
returns void language plpgsql as $$
begin
  insert into public.lead_intake_handoff_queue (org_id, lead_id, source_run_id, stage, state)
  values (p_org, p_lead, p_run, 'qualification', 'pending')
  on conflict (org_id, lead_id) do nothing;
end;
$$;
revoke all on function public.claim_intake_handoff_queue_rows(uuid, integer) from public, anon;
revoke all on function public.reclaim_expired_intake_handoff_leases(uuid, integer) from public, anon;
revoke all on function public.complete_intake_handoff_queue_row(uuid, uuid) from public, anon;
revoke all on function public.fail_intake_handoff_queue_row(uuid, uuid, text, timestamptz, integer) from public, anon;
revoke all on function public.manual_review_intake_handoff_queue_row(uuid, uuid) from public, anon;
revoke all on function public.reconcile_intake_handoff_queue(timestamptz) from public, anon;
revoke all on function public.enqueue_intake_handoff_queue(uuid, uuid, uuid) from public, anon;
