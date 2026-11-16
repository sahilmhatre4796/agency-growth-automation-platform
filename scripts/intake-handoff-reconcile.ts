// Intake-handoff reconciliation: backfills missing queue records from eligible
// leads in completed discovery runs. Idempotent (NOT EXISTS + ON CONFLICT DO NOTHING),
// safe to run repeatedly. Covers the ingestion-succeeded/enqueue-failed gap.
// Fail-closed behind ENABLE_INTAKE_HANDOFF_RECONCILE.
import { createClient } from "@supabase/supabase-js";

if (process.env.ENABLE_INTAKE_HANDOFF_RECONCILE !== "true") {
  throw new Error("INTAKE_HANDOFF_RECONCILE_DISABLED");
}
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("SUPABASE_WORKER_CONFIG_REQUIRED");

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const processReconcile = async () => {
  const nowIso = new Date().toISOString();
  const { data, error } = await db.rpc("reconcile_intake_handoff_queue", { p_now: nowIso });
  if (error) throw new Error(`RECONCILE_FAILED: ${error.message}`);
  const inserted = (data ?? []) as Array<{ org_id: string; lead_id: string }>;
  console.log(JSON.stringify({ reconciled: inserted.length, at: nowIso }));
};

void processReconcile();
