// Batch intake-handoff worker: claims queued leads, runs qualification + preview,
// marks rows completed/failed/manual_review. Fail-closed behind ENABLE_INTAKE_HANDOFF_BATCH.
// External AI/provider calls (research-preview Edge Function) stay outside DB transactions.
// Claim → generate outside transaction → finalize RPC atomically completes idempotency.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  planIntakeHandoff,
  applyIntakeHandoff,
  handoffIntakePreview,
  type IntakeHandoffDb,
} from "../packages/server/intake-handoff.ts";

const BATCH_SIZE = Number(process.env.INTAKE_HANDOFF_BATCH_SIZE ?? "10");
const LEASE_TTL_MIN = Number(process.env.INTAKE_HANDOFF_LEASE_TTL_MIN ?? "5");
const MAX_ATTEMPTS = Number(process.env.INTAKE_HANDOFF_MAX_ATTEMPTS ?? "3");

const mapped = <T>(result: { data: T | null; error: { code?: string; message: string } | null }) =>
  ({ data: result.data, error: result.error ? { code: result.error.code, message: result.error.message } : null });

type QueueRow = { id: string; org_id: string; lead_id: string; stage: string; claim_token: string; lease_until: string; attempt_count: number };
type IdempotentRow = { org_id: string; lead_id: string; claim_token: string; lease_until: string; status: string; preview_id: string | null; result: unknown };

const backoffAt = (attempt: number): string => {
  const minutes = [15, 60, 360][Math.min(attempt - 1, 2)];
  return new Date(Date.now() + minutes * 60000).toISOString();
};

const terminalActions: Set<string> = new Set([
  "hold_identity_review", "skip_not_eligible", "review_rejected_matches",
  "hold_needs_evidence", "hold_needs_assessment", "hold_further_research",
]);

const loadLeadContext = async (db: SupabaseClient, orgId: string, leadId: string) => {
  const [evidence, matches, services, assessments, audits, proposals, contacts] = await Promise.all([
    db.from("lead_evidence").select("source_url,rejected_by").eq("org_id", orgId).eq("lead_id", leadId).limit(30),
    db.from("lead_service_matches").select("service_id,status,reason,evidence_ids,confidence").eq("org_id", orgId).eq("lead_id", leadId).limit(10),
    db.from("service_catalog").select("id,service_key").eq("org_id", orgId),
    db.from("lead_website_assessments").select("status,official_url,observed_at").eq("org_id", orgId).eq("lead_id", leadId).order("observed_at", { ascending: false }).limit(1),
    db.from("website_audit_observations").select("id,checked_url,checked_at,outcome,http_status").eq("org_id", orgId).eq("lead_id", leadId).order("checked_at", { ascending: false }).limit(5),
    db.from("lead_discovery_sources").select("id,source_url,proposed_website_url,observed_at").eq("org_id", orgId).eq("lead_id", leadId).not("proposed_website_url", "is", null).order("observed_at", { ascending: false }).limit(5),
    db.from("vibe_contact_points").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("lead_id", leadId),
  ]);
  const loads = [evidence, matches, services, assessments, audits, proposals, contacts];
  if (loads.some((l) => l.error)) throw new Error("INTAKE_HANDOFF_STATE_UNAVAILABLE");
  return {
    evidence: evidence.data ?? [], matches: matches.data ?? [], services: services.data ?? [],
    assessments: assessments.data ?? [], audits: audits.data ?? [], proposals: proposals.data ?? [], contacts: contacts.count ?? 0,
  };
};

const processRow = async (db: SupabaseClient, supabaseUrl: string, row: QueueRow,
  reclaimedPreview: Map<string, string>): Promise<void> => {
  const { data: leadRow, error: leadError } = await db.from("leads")
    .select("id,org_id,business_name,website_url,country,is_demo,status")
    .eq("id", row.lead_id).eq("org_id", row.org_id).maybeSingle();
  if (leadError) throw new Error(`INTAKE_HANDOFF_LEAD_UNAVAILABLE: ${leadError.message}`);
  if (!leadRow) throw new Error("INTAKE_HANDOFF_LEAD_NOT_FOUND");

  const ctx = await loadLeadContext(db, row.org_id, row.lead_id);

  const serviceKeys = new Map((ctx.services as Array<{ id: string; service_key: string }>).map((s) => [s.id, s.service_key]));
  const plan = await planIntakeHandoff({
    identityState: "matched",
    lead: {
      id: leadRow.id, country: leadRow.country, website_url: leadRow.website_url,
      is_demo: leadRow.is_demo, status: leadRow.status,
    },
    evidence: ctx.evidence as Array<{ source_url: string; rejected_by: string | null }>,
    reviewedAssessment: ctx.assessments[0] ?? null,
    audits: ctx.audits as Array<{ id: string; checked_url: string; checked_at: string; outcome: string; http_status: number | null }>,
    proposals: (ctx.proposals as Array<{ id: string; source_url: string; proposed_website_url: string; observed_at: string }>)
      .filter((p) => p.proposed_website_url !== null),
    matches: (ctx.matches as Array<{ service_id: string; status: string; reason: string; evidence_ids: string[]; confidence: number }>)
      .map((m) => ({ service_key: serviceKeys.get(m.service_id) ?? "", status: m.status, reason: m.reason, evidence_ids: m.evidence_ids ?? [], confidence: Number(m.confidence) })),
  });

  const handoffDb: IntakeHandoffDb = {
    findOpenTask: async (input) => mapped(await db.from("tasks").select("id")
      .eq("org_id", input.org_id).eq("lead_id", input.lead_id).eq("state", "open")
      .eq("title", input.title).limit(1)
      .then((r) => ({ data: r.data?.[0] ?? null, error: r.error }))),
    insertTask: async (input) => mapped(await db.from("tasks")
      .insert({ org_id: input.org_id, lead_id: input.lead_id, title: input.title, description: input.description })
      .select("id").single()),
    findObservation: async (input) => mapped(await db.from("lead_website_observations").select("id")
      .eq("org_id", input.org_id).eq("lead_id", input.lead_id)
      .eq("source_fingerprint", input.source_fingerprint).limit(1)
      .then((r) => ({ data: r.data?.[0] ?? null, error: r.error }))),
    insertObservation: async (input) => {
      const { org_id: orgId, lead_id: lead, ...row } = input;
      return mapped(await db.from("lead_website_observations").insert({ org_id: orgId, lead_id: lead, ...row })
        .select("id").single());
    },
    updateLeadStatus: async (input) => mapped(await db.from("leads").update({ status: input.status })
      .eq("org_id", input.org_id).eq("id", input.lead_id).select("id").maybeSingle()),
  };

  await applyIntakeHandoff(handoffDb, {
    lead: { id: leadRow.id, org_id: row.org_id, status: leadRow.status }, plan,
  });

  if (terminalActions.has(plan.action)) {
    const { error } = await db.rpc("manual_review_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
    if (error) throw new Error(`QUEUE_MANUAL_REVIEW_FAILED: ${error.message}`);
    return;
  }

  if (plan.action === "request_preview_handoff") {
    const { data: claimRows, error: claimError } = await db.rpc("claim_intake_handoff_preview_idempotent", {
      p_org_id: row.org_id, p_lead_id: row.lead_id,
    });
    if (claimError) throw new Error(`IDEMPOTENT_CLAIM_FAILED: ${claimError.message}`);
    const freshClaims = (claimRows ?? []) as IdempotentRow[];
    let previewToken: string;
    if (freshClaims.length > 0) {
      // Fresh INSERT claim (RPC returns a row only on insert): proceed to preview.
      previewToken = freshClaims[0].claim_token;
    } else {
      // Row already exists: an empty claim never means completed — inspect its state.
      const reclaimedToken = reclaimedPreview.get(`${row.org_id}/${row.lead_id}`);
      if (reclaimedToken) {
        // We reclaimed this expired processing lease earlier this batch; we own it.
        previewToken = reclaimedToken;
      } else {
        const { data: idem, error: idemError } = await db.from("intake_handoff_preview_idempotent")
          .select("status, lease_until")
          .eq("org_id", row.org_id).eq("lead_id", row.lead_id)
          .eq("operation", "intake_handoff_preview").maybeSingle();
        if (idemError) throw new Error(`IDEMPOTENT_STATE_UNAVAILABLE: ${idemError.message}`);
        if (!idem) throw new Error("IDEMPOTENT_CLAIM_MISSING");
        const state = idem as { status: string; lease_until: string | null };
        if (state.status === "completed") {
          const { error } = await db.rpc("complete_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
          if (error) throw new Error(`QUEUE_COMPLETE_FAILED: ${error.message}`);
          return;
        }
        if (state.status === "failed") {
          // Terminal idempotency failure: explicit human outcome, never silent completion.
          const { error } = await db.rpc("manual_review_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
          if (error) throw new Error(`QUEUE_MANUAL_REVIEW_FAILED: ${error.message}`);
          return;
        }
        if (state.status === "processing" && state.lease_until !== null &&
          new Date(state.lease_until).getTime() > Date.now()) {
          // Another worker actively owns the preview: leave our queue row claimed;
          // queue lease recovery retries once that worker finishes or crashes.
          return;
        }
        // pending/invalid state, or an expired lease this batch did not reclaim: retry.
        throw new Error(`PREVIEW_IDEMPOTENT_${state.status.toUpperCase()}_UNAVAILABLE`);
      }
    }

    const secret = process.env.INTERNAL_CRON_SECRET;
    let previewResult: "submitted" | "not_configured" | "disabled";
    try {
      previewResult = await handoffIntakePreview({
        supabaseUrl: supabaseUrl, internalSecret: secret, leadId: row.lead_id, org_id: row.org_id,
      });
    } catch (cause) {
      const attempts = row.attempt_count + 1;
      const nextRetryAt = attempts >= MAX_ATTEMPTS ? null : backoffAt(attempts);
      const { error: rpcError } = await db.rpc("fail_intake_handoff_queue_row", {
        p_id: row.id, p_claim_token: row.claim_token, p_error: cause instanceof Error ? cause.message : String(cause),
        p_next_retry_at: nextRetryAt, p_attempt_count: attempts,
      });
      if (rpcError) throw new Error(`QUEUE_FAIL_FAILED: ${rpcError.message}`);
      return;
    }

    if (previewResult === "not_configured" || previewResult === "disabled") {
      // No preview was produced: explicit terminal outcome, never silent completion.
      const { error } = await db.rpc("manual_review_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
      if (error) throw new Error(`QUEUE_MANUAL_REVIEW_FAILED: ${error.message}`);
      return;
    }

    const { data: finalized, error: rpcError } = await db.rpc("finalize_intake_handoff_preview", {
      p_org_id: row.org_id, p_lead_id: row.lead_id, p_claim_token: previewToken, p_preview_id: null,
      p_result: { status: previewResult }, p_status: "completed",
    });
    if (rpcError) throw new Error(`IDEMPOTENT_FINALIZE_FAILED: ${rpcError.message}`);
    // Zero-row/stale-token no-op (lease reclaimed elsewhere): fail for retry,
    // never complete the queue row as if the preview were recorded.
    if (finalized !== true) throw new Error("IDEMPOTENT_FINALIZE_STALE");
    const { error: completeError } = await db.rpc("complete_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
    if (completeError) throw new Error(`QUEUE_COMPLETE_FAILED: ${completeError.message}`);
    return;
  }

  const { error } = await db.rpc("complete_intake_handoff_queue_row", { p_id: row.id, p_claim_token: row.claim_token });
  if (error) throw new Error(`QUEUE_COMPLETE_FAILED: ${error.message}`);
};

export const createBatchWorker = (db: SupabaseClient) => {
  if (process.env.ENABLE_INTAKE_HANDOFF_BATCH !== "true") {
    throw new Error("INTAKE_HANDOFF_BATCH_DISABLED");
  }
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_WORKER_CONFIG_REQUIRED");
  const queueDb = {
    reclaim: async (orgId: string): Promise<QueueRow[]> => {
      const { data, error } = await db.rpc("reclaim_expired_intake_handoff_leases", { p_org_id: orgId, p_ttl_min: LEASE_TTL_MIN });
      if (error) throw new Error(`QUEUE_RECLAIM_FAILED: ${error.message}`);
      return (data ?? []) as QueueRow[];
    },
    claim: async (orgId: string): Promise<QueueRow[]> => {
      const { data, error } = await db.rpc("claim_intake_handoff_queue_rows", { p_org_id: orgId, p_limit: BATCH_SIZE });
      if (error) throw new Error(`QUEUE_CLAIM_FAILED: ${error.message}`);
      return (data ?? []) as QueueRow[];
    },
  };

  const processBatch = async () => {
    const nowIso = new Date().toISOString();
    const { error: resetError } = await db.from("lead_intake_handoff_queue")
      .update({ state: "pending", next_retry_at: null })
      .eq("state", "failed")
      .not("next_retry_at", "is", null)
      .lte("next_retry_at", nowIso);
    if (resetError) throw new Error(`QUEUE_RESET_FAILED: ${resetError.message}`);
    // Recovery: reclaim expired preview idempotency leases (fresh token, stays
    // processing) before claiming, so rows orphaned by a crash between claim and
    // finalize become claimable again this batch.
    const { data: previewReclaimed, error: previewReclaimError } =
      await db.rpc("reclaim_expired_intake_handoff_preview_leases", { p_ttl_min: LEASE_TTL_MIN });
    if (previewReclaimError) throw new Error(`PREVIEW_RECLAIM_FAILED: ${previewReclaimError.message}`);
    const reclaimedPreview = new Map<string, string>();
    for (const r of (previewReclaimed ?? []) as Array<{ org_id: string; lead_id: string; claim_token: string }>) {
      reclaimedPreview.set(`${r.org_id}/${r.lead_id}`, r.claim_token);
    }
    // Scan pending rows AND claimed rows with expired leases: a crash that leaves
    // every org row claimed must still trigger reclaim on the next run.
    // Flat typed filters: the raw `next_retry_at.isnull` token is not valid
    // PostgREST (only `.is(col, null)` emits `is.null`), and nested or-groups
    // are unverifiable against a fake chain — three explicit queries instead.
    const [ready, retryable, orphaned] = await Promise.all([
      db.from("lead_intake_handoff_queue").select("org_id")
        .eq("state", "pending").is("next_retry_at", null),
      db.from("lead_intake_handoff_queue").select("org_id")
        .eq("state", "pending").lte("next_retry_at", nowIso),
      db.from("lead_intake_handoff_queue").select("org_id")
        .eq("state", "claimed").lt("lease_until", nowIso),
    ]);
    const scanError = ready.error ?? retryable.error ?? orphaned.error;
    if (scanError) throw new Error(`QUEUE_SCAN_FAILED: ${scanError.message}`);
    const orgs = [...new Set([...(ready.data ?? []), ...(retryable.data ?? []), ...(orphaned.data ?? [])]
      .map((r) => r.org_id))];

    const rows: QueueRow[] = [];
    for (const orgId of orgs) {
      const [reclaimedRows, claimedRows] = await Promise.all([
        queueDb.reclaim(orgId),
        queueDb.claim(orgId),
      ]);
      rows.push(...reclaimedRows, ...claimedRows);
    }

    for (const row of rows) {
      try {
        await processRow(db, url, row, reclaimedPreview);
      } catch (cause) {
        const attempts = row.attempt_count + 1;
        const nextRetryAt = attempts >= MAX_ATTEMPTS ? null : backoffAt(attempts);
        try {
          const { error: rpcError } = await db.rpc("fail_intake_handoff_queue_row", {
            p_id: row.id, p_claim_token: row.claim_token, p_error: cause instanceof Error ? cause.message : String(cause),
            p_next_retry_at: nextRetryAt, p_attempt_count: attempts,
          });
          if (rpcError) throw new Error(`QUEUE_FAIL_FAILED: ${rpcError.message}`);
        } catch { /* fail-write failure: row stays claimed; next reclaim cycle recovers */ }
      }
    }

    console.log(JSON.stringify({ processed: rows.length, at: nowIso }));
  };

  return { processBatch };
};

if (import.meta.main) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_WORKER_CONFIG_REQUIRED");
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { processBatch } = createBatchWorker(db);
  void processBatch();
}
