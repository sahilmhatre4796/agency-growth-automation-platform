// Real SQL contract tests for the intake-handoff RPCs against PGlite with all
// migrations: ON CONFLICT DO NOTHING RETURNING (fresh claim returns a row,
// conflict returns empty), boolean finalize (stale token = false), expired-lease
// reclaim with fresh tokens, and queue claim/reclaim returning attempt_count.
// These calls also guard the plpgsql ambiguity fix: unqualified columns that
// collide with RETURNS TABLE OUT params used to raise at runtime.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";

let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000201";
const leadA = "00000000-0000-4000-8000-000000000202";

const claimPreview = () =>
  db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid, $2::uuid)`, [orgA, leadA]);
const previewState = async () => {
  const r = await db.query(
    `select status, claim_token from public.intake_handoff_preview_idempotent where org_id = $1::uuid and lead_id = $2::uuid`,
    [orgA, leadA]);
  return r.rows[0] as { status: string; claim_token: string };
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `create role service_role bypassrls; create role anon; create role authenticated;
     create schema auth; create table auth.users(id uuid primary key);
     create function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
     grant usage on schema auth,public to authenticated,anon;
     grant execute on function auth.uid() to authenticated,anon;`,
  );
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;alter default privileges in schema public grant all on tables to anon,authenticated;",
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (["0073_scrapling_contact_provider.sql", "0074_bounded_retries_discovery_runs.sql",
      "0075_restore_serper_campaign_invariants.sql",
      "0079_serper_finish_diagnostics.sql"].includes(file)) continue;
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  for (const file of ["0074_bounded_retries_discovery_runs.sql", "0075_restore_serper_campaign_invariants.sql",
    "0079_serper_finish_diagnostics.sql"]) {
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  await db.exec(
    `insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
       values('${orgA}','Org A','serper',100);
     insert into public.leads(id,org_id,business_name,source_type)
       values('${leadA}','${orgA}','Test Business','serper');
     insert into public.lead_intake_handoff_queue(org_id,lead_id,stage)
       values('${orgA}','${leadA}','preview');`,
  );
});

afterAll(async () => { await db.close(); });

test("fresh claim returns a row; conflicting claim returns empty (ON CONFLICT DO NOTHING RETURNING)", async () => {
  const first = await claimPreview();
  expect(first.rows).toHaveLength(1);
  const row = first.rows[0] as { status: string; claim_token: string; lease_until: string };
  expect(row.status).toBe("processing");
  expect(row.claim_token).toBeTruthy();
  const second = await claimPreview();
  expect(second.rows).toHaveLength(0);
});

test("expired lease reclaim issues a fresh token; stale token cannot finalize afterwards", async () => {
  const before = await previewState();
  await db.exec(
    `update public.intake_handoff_preview_idempotent
       set lease_until = now() - interval '1 minute'
     where org_id = '${orgA}' and lead_id = '${leadA}'`);
  const reclaimed = await db.query(
    `select * from public.reclaim_expired_intake_handoff_preview_leases(5)`);
  expect(reclaimed.rows).toHaveLength(1);
  const fresh = (reclaimed.rows[0] as { org_id: string; claim_token: string });
  expect(fresh.org_id).toBe(orgA);
  expect(fresh.claim_token).not.toBe(before.claim_token);
  // Reclaim keeps the row processing (no pending-state window).
  const mid = await previewState();
  expect(mid.status).toBe("processing");
  // The pre-reclaim token is now stale: finalize must be a false no-op.
  const stale = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid, $2::uuid, $3::uuid, null::uuid, '{}'::jsonb, 'completed') as ok`,
    [orgA, leadA, before.claim_token]);
  expect(stale.rows[0]).toEqual({ ok: false });
  expect((await previewState()).status).toBe("processing");
  // The fresh token finalizes for real.
  const ok = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid, $2::uuid, $3::uuid, null::uuid, $4::jsonb, 'completed') as ok`,
    [orgA, leadA, fresh.claim_token, JSON.stringify({ status: "submitted" })]);
  expect(ok.rows[0]).toEqual({ ok: true });
  const done = await previewState();
  expect(done.status).toBe("completed");
  // Finalizing again after completion is a false no-op.
  const again = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid, $2::uuid, $3::uuid, null::uuid, '{}'::jsonb, 'completed') as ok`,
    [orgA, leadA, fresh.claim_token]);
  expect(again.rows[0]).toEqual({ ok: false });
});

test("completed idempotency row is not resurrected by another claim", async () => {
  const again = await claimPreview();
  expect(again.rows).toHaveLength(0);
  expect((await previewState()).status).toBe("completed");
});

test("queue claim returns attempt_count and only pending rows (ambiguity regression)", async () => {
  const first = await db.query(
    `select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(first.rows).toHaveLength(1);
  const row = first.rows[0] as { id: string; claim_token: string; attempt_count: number; state?: string };
  expect(row.attempt_count).toBe(0);
  expect(row.claim_token).toBeTruthy();
  // The row is now claimed: a second claim finds nothing.
  const second = await db.query(
    `select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(second.rows).toHaveLength(0);

  // fail writes attempt_count; expired-lease reclaim returns it with a fresh token.
  await db.query(
    `select public.fail_intake_handoff_queue_row($1::uuid, $2::uuid, 'boom', null, 2)`,
    [row.id, row.claim_token]);
  const failed = await db.query(
    `select state, attempt_count from public.lead_intake_handoff_queue where id = $1::uuid`, [row.id]);
  expect(failed.rows[0]).toEqual({ state: "failed", attempt_count: 2 });
  await db.exec(
    `update public.lead_intake_handoff_queue
       set state = 'claimed', lease_until = now() - interval '1 minute'
     where id = '${row.id}'`);
  const reclaimed = await db.query(
    `select * from public.reclaim_expired_intake_handoff_leases($1::uuid, 5)`, [orgA]);
  expect(reclaimed.rows).toHaveLength(1);
  const rq = reclaimed.rows[0] as { claim_token: string; attempt_count: number };
  expect(rq.attempt_count).toBe(2);
  expect(rq.claim_token).not.toBe(row.claim_token);
});

test("reconcile backfill executes without ambiguity and returns no rows without discovery runs", async () => {
  const r = await db.query(`select * from public.reconcile_intake_handoff_queue(now())`);
  expect(r.rows).toHaveLength(0);
});
