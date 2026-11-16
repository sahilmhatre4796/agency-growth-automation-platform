import { createClient } from "@supabase/supabase-js";
import { applyIntakeHandoff, handoffIntakePreview, planIntakeHandoff, type IntakeHandoffDb } from "../packages/server/intake-handoff.ts";

// One-job, owner-invoked intake → assessment → preview handoff. It reads one
// exact lead, records only factual CRM updates, and never sends outreach or
// changes qualification. The discovery Edge function wiring stays a separate,
// deploy-gated change.
if (process.env.ENABLE_INTAKE_HANDOFF !== "true") throw new Error("INTAKE_HANDOFF_DISABLED");
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const leadId = process.env.INTAKE_HANDOFF_LEAD_ID;
if (!url || !serviceKey) throw new Error("SUPABASE_WORKER_CONFIG_REQUIRED");
if (!leadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId))
  throw new Error("INTAKE_HANDOFF_LEAD_ID_REQUIRED");

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const mapped = <T>(result: { data: T | null; error: { code?: string; message: string } | null }) =>
  ({ data: result.data, error: result.error ? { code: result.error.code, message: result.error.message } : null });

const { data: leadRow, error: leadError } = await db.from("leads")
  .select("id,org_id,business_name,website_url,country,is_demo,status")
  .eq("id", leadId).maybeSingle();
if (leadError) throw new Error("INTAKE_HANDOFF_LEAD_UNAVAILABLE");
if (!leadRow) throw new Error("INTAKE_HANDOFF_LEAD_NOT_FOUND");

const [evidence, matches, services, assessments, audits, proposals, contacts] = await Promise.all([
  db.from("lead_evidence").select("source_url,rejected_by")
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id).limit(30),
  db.from("lead_service_matches").select("service_id,status,reason,evidence_ids,confidence")
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id).limit(10),
  db.from("service_catalog").select("id,service_key").eq("org_id", leadRow.org_id),
  db.from("lead_website_assessments").select("status,official_url,observed_at")
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id)
    .order("observed_at", { ascending: false }).limit(1),
  db.from("website_audit_observations").select("id,checked_url,checked_at,outcome,http_status")
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id)
    .order("checked_at", { ascending: false }).limit(5),
  db.from("lead_discovery_sources").select("id,source_url,proposed_website_url,observed_at")
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id)
    .not("proposed_website_url", "is", null).order("observed_at", { ascending: false }).limit(5),
  db.from("vibe_contact_points").select("id", { count: "exact", head: true })
    .eq("org_id", leadRow.org_id).eq("lead_id", leadRow.id),
]);
const loads = [evidence, matches, services, assessments, audits, proposals, contacts];
if (loads.some((load) => load.error)) throw new Error("INTAKE_HANDOFF_STATE_UNAVAILABLE");

const serviceKeys = new Map((services.data ?? []).map((row) => [row.id, row.service_key]));
const plan = await planIntakeHandoff({
  // An existing CRM lead already resolved its identity at intake; ambiguous
  // candidates never became leads and stay in the owner review queue.
  identityState: "matched",
  lead: { id: leadRow.id, country: leadRow.country, website_url: leadRow.website_url,
    is_demo: leadRow.is_demo, status: leadRow.status },
  evidence: evidence.data ?? [],
  reviewedAssessment: assessments.data?.[0] ?? null,
  audits: audits.data ?? [],
  proposals: (proposals.data ?? []).filter((row) => row.proposed_website_url !== null),
  matches: (matches.data ?? []).map((row) => ({ service_key: serviceKeys.get(row.service_id) ?? "",
    status: row.status, reason: row.reason, evidence_ids: row.evidence_ids ?? [],
    confidence: Number(row.confidence) })),
});

const handoffDb: IntakeHandoffDb = {
  findOpenTask: async (input) => mapped(await db.from("tasks").select("id")
    .eq("org_id", input.org_id).eq("lead_id", input.lead_id).eq("state", "open")
    .eq("title", input.title).limit(1).then((result) => ({ data: result.data?.[0] ?? null, error: result.error }))),
  insertTask: async (input) => mapped(await db.from("tasks")
    .insert({ org_id: input.org_id, lead_id: input.lead_id, title: input.title, description: input.description })
    .select("id").single()),
  findObservation: async (input) => mapped(await db.from("lead_website_observations").select("id")
    .eq("org_id", input.org_id).eq("lead_id", input.lead_id)
    .eq("source_fingerprint", input.source_fingerprint).limit(1)
    .then((result) => ({ data: result.data?.[0] ?? null, error: result.error }))),
  insertObservation: async (input) => {
    const { org_id: orgId, lead_id: lead, ...row } = input;
    return mapped(await db.from("lead_website_observations").insert({ org_id: orgId, lead_id: lead, ...row })
      .select("id").single());
  },
  updateLeadStatus: async (input) => mapped(await db.from("leads").update({ status: input.status })
    .eq("org_id", input.org_id).eq("id", input.lead_id).select("id").maybeSingle()),
};

const applied = await applyIntakeHandoff(handoffDb, {
  lead: { id: leadRow.id, org_id: leadRow.org_id, status: leadRow.status }, plan });

let previewHandoff: "submitted" | "not_configured" | "disabled" | "failed" | "not_applicable" = "not_applicable";
if (plan.action === "request_preview_handoff") {
  try {
    previewHandoff = await handoffIntakePreview({ supabaseUrl: url,
      internalSecret: process.env.INTERNAL_CRON_SECRET, leadId: leadRow.id });
  } catch {
    // The factual CRM record is already saved; the preview worker keeps its
    // own gates and can be re-invoked by the owner later.
    previewHandoff = "failed";
    console.warn("INTAKE_PREVIEW_HANDOFF_FAILED");
  }
}

console.log(JSON.stringify({ lead_id: leadRow.id, org_id: leadRow.org_id,
  contact_points: contacts.count ?? 0, evidence_count: evidence.data?.length ?? 0,
  ...applied, preview_handoff: previewHandoff }, null, 2));
