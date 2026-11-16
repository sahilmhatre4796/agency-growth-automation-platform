// Full local intake-handoff pipeline against real PGlite with all migrations:
// discovery enqueue → queue claim → qualification → preview idempotency claim →
// preview request (injected fetcher) → finalize → queue completion, plus the
// failure/recovery cases. Real RPCs and real server functions throughout; only
// the outbound HTTP hop to the Edge Function is injected. True E2E (PostgREST +
// deployed Edge Function) cannot run locally and is not claimed here.
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import { createIntakePgLite } from "./helpers/intake-pglite.ts";
import {
  planIntakeHandoff, applyIntakeHandoff, handoffIntakePreview, type IntakeHandoffDb,
} from "../packages/server/intake-handoff.ts";
import type { PGlite } from "@electric-sql/pglite";

let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000501";
const orgB = "00000000-0000-4000-8000-000000000502";
const runA = "00000000-0000-4000-8000-000000000503";
const runB = "00000000-0000-4000-8000-000000000504";
const leadA = "00000000-0000-4000-8000-000000000505"; // orgA: happy path
const leadB = "00000000-0000-4000-8000-000000000506"; // orgA: failure/recovery
const leadC = "00000000-0000-4000-8000-000000000507"; // orgB: scoping
const leadD = "00000000-0000-4000-8000-000000000508"; // orgA: scoping
const previewUrl = "https://test.supabase.co/functions/v1/research-preview-jobs";
const secret = "intake-pipeline-secret-0123456789abcdef"; // >= 32

// Queue/idempotency tokens carried across sequential stages.
let queueIdA: string, queueTokenA: string;
let failedRow: { id: string; claim_token: string; idemToken: string };

const planInputs = (leadId: string) => ({
  identityState: "matched" as const,
  lead: { id: leadId, country: "US", website_url: null, is_demo: false, status: "new" },
  evidence: [
    { source_url: "https://yellowpages.example.com/listing", rejected_by: null },
    { source_url: "https://chamber.example.org/profile", rejected_by: null },
  ],
  reviewedAssessment: { status: "NO_OFFICIAL_WEBSITE_DISCOVERED", official_url: null,
    observed_at: new Date().toISOString() },
  audits: [], proposals: [], matches: [],
});

// Same flat write interface the worker maps, backed by real SQL.
const handoffDb: IntakeHandoffDb = {
  findOpenTask: async (input) => {
    const r = await db.query(`select id from public.tasks
      where org_id=$1::uuid and lead_id=$2::uuid and state='open' and title=$3 limit 1`,
    [input.org_id, input.lead_id, input.title]);
    return { data: (r.rows[0] as { id: string } | undefined) ?? null, error: null };
  },
  insertTask: async (input) => {
    const r = await db.query(`insert into public.tasks(org_id,lead_id,title,description)
      values($1::uuid,$2::uuid,$3,$4) returning id`,
    [input.org_id, input.lead_id, input.title, input.description]);
    return { data: r.rows[0] as { id: string }, error: null };
  },
  findObservation: async (input) => {
    const r = await db.query(`select id from public.lead_website_observations
      where org_id=$1::uuid and lead_id=$2::uuid and source_fingerprint=$3 limit 1`,
    [input.org_id, input.lead_id, input.source_fingerprint]);
    return { data: (r.rows[0] as { id: string } | undefined) ?? null, error: null };
  },
  insertObservation: async (input) => {
    const { org_id: o, lead_id: l, ...row } = input;
    const keys = Object.keys(row);
    const r = await db.query(
      `insert into public.lead_website_observations(org_id, lead_id, ${keys.join(",")})
       values($1::uuid, $2::uuid, ${keys.map((_, i) => `$${i + 3}`).join(",")}) returning id`,
      [o, l, ...keys.map((k) => (row as Record<string, unknown>)[k])]);
    return { data: r.rows[0] as { id: string }, error: null };
  },
  updateLeadStatus: async (input) => {
    const r = await db.query(`update public.leads set status=$1
      where org_id=$2::uuid and id=$3::uuid returning id`,
    [input.status, input.org_id, input.lead_id]);
    return { data: (r.rows[0] as { id: string } | undefined) ?? null, error: null };
  },
};

const previewCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
const okFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  previewCalls.push({ url: String(input),
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers: (init?.headers ?? {}) as Record<string, string> });
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

const previewInput = (leadId: string) => ({
  supabaseUrl: "https://test.supabase.co", internalSecret: secret, leadId, org_id: orgA,
});

beforeAll(async () => {
  db = await createIntakePgLite();
  await db.query(
    `insert into public.organizations(id,name,research_provider,research_monthly_credit_cap) values
     ($1::uuid,'Pipeline Org A','serper',100), ($2::uuid,'Pipeline Org B','serper',100)`, [orgA, orgB]);
  await db.query(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit) values
     ($1::uuid,$2::uuid,'serper','completed',10), ($3::uuid,$4::uuid,'serper','completed',10)`,
  [runA, orgA, runB, orgB]);
  await db.query(
    `insert into public.leads(id,org_id,business_name,source_type,status) values
     ($1::uuid,$2::uuid,'Pipeline Cafe A','serper','new'),
     ($3::uuid,$2::uuid,'Pipeline Cafe B','serper','new'),
     ($4::uuid,$2::uuid,'Pipeline Cafe D','serper','new'),
     ($5::uuid,$6::uuid,'Pipeline Cafe C','serper','new')`,
  [leadA, orgA, leadB, leadD, leadC, orgB]);
  await db.query(
    `insert into public.lead_discovery_sources(org_id,lead_id,discovery_run_id,source,actual_provider,observed_at)
     values($1::uuid,$2::uuid,$3::uuid,'serper','serper',now()),
           ($4::uuid,$5::uuid,$6::uuid,'serper','serper',now())`,
  [orgA, leadA, runA, orgB, leadC, runB]);
});

afterAll(async () => { await db.close(); });

test("stage 1-2: discovery enqueue → queue claim", async () => {
  // What serper-discovery-jobs does right after creating a lead:
  await db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`, [orgA, leadA, runA]);
  // Idempotent: a repeat enqueue no-ops, and reconcile backfills only the lead
  // not yet queued (leadC in orgB) — never re-adding leadA.
  await db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`, [orgA, leadA, runA]);
  const backfill = await db.query(`select * from public.reconcile_intake_handoff_queue(now())`);
  expect(backfill.rows).toEqual([{ org_id: orgB, lead_id: leadC }]);

  const queued = await db.query(
    `select id, state, stage, attempt_count from public.lead_intake_handoff_queue where org_id=$1::uuid`, [orgA]);
  expect(queued.rows).toHaveLength(1);
  expect(queued.rows[0]).toMatchObject({ state: "pending", stage: "qualification", attempt_count: 0 });

  const claim = await db.query(`select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(claim.rows).toHaveLength(1);
  queueIdA = (claim.rows[0] as { id: string }).id;
  queueTokenA = (claim.rows[0] as { claim_token: string }).claim_token;
  expect(queueTokenA).toBeTruthy();
});

test("stage 3: qualification plans the preview handoff and applies without duplicates", async () => {
  const plan = await planIntakeHandoff(planInputs(leadA));
  expect(plan.action).toBe("request_preview_handoff");

  const applied = await applyIntakeHandoff(handoffDb,
    { lead: { id: leadA, org_id: orgA, status: "new" }, plan });
  expect(applied).toMatchObject({ status_updated: true, task_created: true });
  expect(applied.suggested_service).toMatch(/^service_/);
  expect((await db.query(`select status from public.leads where id=$1::uuid`, [leadA])).rows[0])
    .toEqual({ status: "researching" });

  // Re-applying the same qualification never duplicates the task.
  const again = await applyIntakeHandoff(handoffDb,
    { lead: { id: leadA, org_id: orgA, status: "researching" }, plan });
  expect(again.task_created).toBe(false);
  expect(again.status_updated).toBe(false);
  const tasks = await db.query(`select count(*)::int as n from public.tasks where lead_id=$1::uuid`, [leadA]);
  expect(tasks.rows[0]).toEqual({ n: 1 });
});

test("stage 4-7: preview idempotency claim → request → finalize → queue completion", async () => {
  const idem = await db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid,$2::uuid)`,
    [orgA, leadA]);
  expect(idem.rows).toHaveLength(1);
  const idemToken = (idem.rows[0] as { claim_token: string }).claim_token;

  previewCalls.length = 0;
  expect(await handoffIntakePreview(previewInput(leadA), okFetcher)).toBe("submitted");
  expect(previewCalls).toHaveLength(1);
  expect(previewCalls[0].url).toBe(previewUrl);
  expect(previewCalls[0].body).toEqual({ lead_ids: [leadA], org_id: orgA });
  expect(previewCalls[0].headers["X-Cron-Signature"]).toBe(secret);

  const fin = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid,$2::uuid,$3::uuid,null::uuid,$4::jsonb,'completed') as ok`,
    [orgA, leadA, idemToken, JSON.stringify({ status: "submitted" })]);
  expect(fin.rows[0]).toEqual({ ok: true });

  await db.query(`select public.complete_intake_handoff_queue_row($1::uuid,$2::uuid)`, [queueIdA, queueTokenA]);
  const done = await db.query(
    `select state, completed_at from public.lead_intake_handoff_queue where id=$1::uuid`, [queueIdA]);
  expect(done.rows[0]).toMatchObject({ state: "completed" });
  expect((done.rows[0] as { completed_at: unknown }).completed_at).not.toBeNull();
  const idemDone = await db.query(
    `select status, result from public.intake_handoff_preview_idempotent where org_id=$1::uuid and lead_id=$2::uuid`,
    [orgA, leadA]);
  expect(idemDone.rows[0]).toMatchObject({ status: "completed", result: { status: "submitted" } });
});

test("failure: preview provider failure fails the queue row with backoff, never completes", async () => {
  await db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`, [orgA, leadB, runA]);
  const claim = await db.query(`select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(claim.rows).toHaveLength(1); // leadA's row is completed; only leadB is claimable
  const row = claim.rows[0] as { id: string; claim_token: string };

  const idem = await db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid,$2::uuid)`,
    [orgA, leadB]);
  expect(idem.rows).toHaveLength(1);
  const idemToken = (idem.rows[0] as { claim_token: string }).claim_token;

  const failing = vi.fn(async () =>
    new Response(JSON.stringify({ error: "RESEARCH_EVIDENCE_UNAVAILABLE" }),
      { status: 500, headers: { "content-type": "application/json" } }));
  await expect(handoffIntakePreview(previewInput(leadB), failing as unknown as typeof fetch))
    .rejects.toThrow("INTAKE_PREVIEW_HANDOFF_FAILED");

  // Worker failure path: attempt_count + 1, backoff, state=failed (not completed).
  await db.query(`select public.fail_intake_handoff_queue_row($1::uuid,$2::uuid,$3,now() + interval '5 minutes',1)`,
    [row.id, row.claim_token, "INTAKE_PREVIEW_HANDOFF_FAILED"]);
  const failed = await db.query(
    `select state, attempt_count, next_retry_at from public.lead_intake_handoff_queue where id=$1::uuid`, [row.id]);
  expect(failed.rows[0]).toMatchObject({ state: "failed", attempt_count: 1 });
  expect((failed.rows[0] as { next_retry_at: unknown }).next_retry_at).not.toBeNull();
  // The preview claim survives untouched: still processing, no recorded result.
  const st = await db.query(
    `select status, result from public.intake_handoff_preview_idempotent where org_id=$1::uuid and lead_id=$2::uuid`,
    [orgA, leadB]);
  expect(st.rows[0]).toMatchObject({ status: "processing", result: null });
  failedRow = { id: row.id, claim_token: row.claim_token, idemToken };
});

test("recovery: crash after preview claim → lease expiry → reclaim → stale token rejected", async () => {
  // Crash simulation: the preview lease expires with no finalize ever recorded.
  await db.query(
    `update public.intake_handoff_preview_idempotent set lease_until = now() - interval '1 minute'
     where org_id=$1::uuid and lead_id=$2::uuid`, [orgA, leadB]);
  const reclaimed = await db.query(`select * from public.reclaim_expired_intake_handoff_preview_leases(5)`);
  expect(reclaimed.rows).toHaveLength(1);
  const freshToken = (reclaimed.rows[0] as { claim_token: string }).claim_token;
  expect(freshToken).not.toBe(failedRow.idemToken);

  // Queue retry becomes due; the worker's reset predicate re-arms the row.
  await db.query(
    `update public.lead_intake_handoff_queue set next_retry_at = now() - interval '1 minute'
     where id=$1::uuid`, [failedRow.id]);
  await db.query(`update public.lead_intake_handoff_queue set state='pending', next_retry_at=null
    where state='failed' and next_retry_at is not null and next_retry_at <= now()`);
  const claim = await db.query(`select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(claim.rows).toHaveLength(1);

  // Claiming the existing idempotency row conflicts (empty) — the worker then
  // inspects state and finds this batch's reclaimed processing lease.
  const again = await db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid,$2::uuid)`,
    [orgA, leadB]);
  expect(again.rows).toHaveLength(0);
  const st = await db.query(
    `select status, claim_token from public.intake_handoff_preview_idempotent where org_id=$1::uuid and lead_id=$2::uuid`,
    [orgA, leadB]);
  expect(st.rows[0]).toMatchObject({ status: "processing", claim_token: freshToken });

  // Preview retry succeeds; finalization uses the reclaimed token.
  previewCalls.length = 0;
  expect(await handoffIntakePreview(previewInput(leadB), okFetcher)).toBe("submitted");
  expect(previewCalls).toHaveLength(1);
  const fin = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid,$2::uuid,$3::uuid,null::uuid,$4::jsonb,'completed') as ok`,
    [orgA, leadB, freshToken, JSON.stringify({ status: "submitted" })]);
  expect(fin.rows[0]).toEqual({ ok: true });

  // The pre-reclaim token is stale: finalize is a false no-op, never success.
  const stale = await db.query(
    `select public.finalize_intake_handoff_preview($1::uuid,$2::uuid,$3::uuid,null::uuid,'{}'::jsonb,'completed') as ok`,
    [orgA, leadB, failedRow.idemToken]);
  expect(stale.rows[0]).toEqual({ ok: false });

  const row = claim.rows[0] as { id: string; claim_token: string };
  await db.query(`select public.complete_intake_handoff_queue_row($1::uuid,$2::uuid)`, [row.id, row.claim_token]);
  const done = await db.query(`select state from public.lead_intake_handoff_queue where id=$1::uuid`, [row.id]);
  expect(done.rows[0]).toEqual({ state: "completed" });
});

test("retry after completion creates no duplicate idempotency row, preview call, or draft", async () => {
  // Claim conflicts → the worker inspects state, sees completed, and completes
  // the queue without ever re-running the preview.
  const claim = await db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid,$2::uuid)`,
    [orgA, leadB]);
  expect(claim.rows).toHaveLength(0);
  const state = await db.query(
    `select status from public.intake_handoff_preview_idempotent where org_id=$1::uuid and lead_id=$2::uuid`,
    [orgA, leadB]);
  expect(state.rows[0]).toEqual({ status: "completed" });
  const count = await db.query(
    `select count(*)::int as n from public.intake_handoff_preview_idempotent
     where org_id=$1::uuid and lead_id=$2::uuid`, [orgA, leadB]);
  expect(count.rows[0]).toEqual({ n: 1 });
  previewCalls.length = 0;

  // DB backstop: an identical evidence-only draft violates the unique index
  // (full constraint coverage lives in tests/integration/database.test.ts).
  const svc = await db.query(
    `insert into public.service_catalog(org_id, service_key, name)
     values($1::uuid,'service_01','Business websites') returning id`, [orgA]);
  const serviceId = (svc.rows[0] as { id: string }).id;
  const fact1 = "00000000-0000-4000-8000-0000000005f1";
  const fact2 = "00000000-0000-4000-8000-0000000005f2";
  const draft = async () => db.query(
    `insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim)
     values($1::uuid,$2::uuid,$3::uuid,array['First subject','Second subject'],$4,
       array[$5::uuid,$6::uuid],0.9,'grounded_template','potential_use_case',$7)`,
    [orgA, leadB, serviceId, "Preview body for duplicate-retry test.", fact1, fact2,
      "A verified public fact about this business location."]);
  await draft();
  await expect(draft()).rejects.toThrow(/duplicate key/);
  const drafts = await db.query(
    `select count(*)::int as n from public.research_draft_previews where lead_id=$1::uuid`, [leadB]);
  expect(drafts.rows[0]).toEqual({ n: 1 });
  // The retry never re-invoked the preview endpoint.
  expect(previewCalls).toHaveLength(0);
});

test("organization mismatch: cross-org writes fail and claims stay org-scoped", async () => {
  // Composite FK (org_id, lead_id) → leads rejects a foreign org's lead.
  await expect(db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`,
    [orgB, leadA, runA])).rejects.toThrow(/foreign key/);
  await expect(db.query(`select * from public.claim_intake_handoff_preview_idempotent($1::uuid,$2::uuid)`,
    [orgB, leadA])).rejects.toThrow(/foreign key/);

  // Concurrent pending rows in both orgs: each claim returns only its own org.
  await db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`, [orgA, leadD, runA]);
  await db.query(`select public.enqueue_intake_handoff_queue($1::uuid,$2::uuid,$3::uuid)`, [orgB, leadC, runB]);
  const orgBClaim = await db.query(`select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgB]);
  expect(orgBClaim.rows).toHaveLength(1);
  expect((orgBClaim.rows[0] as { lead_id: string }).lead_id).toBe(leadC);
  const orgAClaim = await db.query(`select * from public.claim_intake_handoff_queue_rows($1::uuid, 10)`, [orgA]);
  expect(orgAClaim.rows).toHaveLength(1);
  expect((orgAClaim.rows[0] as { lead_id: string }).lead_id).toBe(leadD);
});
