import { createClient } from "@supabase/supabase-js";
import { auditWebsite } from "../packages/server/audit.ts";
import { NodePinnedAuditTransport } from "../packages/server/node-audit-transport.ts";
import { failedWebsiteAudit, storedWebsiteAudit } from "../packages/server/website-audit-result.ts";
import { enrichAuditedOfficialContacts, type AuditContactDb } from "../packages/server/audit-contact-enrichment.ts";
import { handoffCompletedWebsiteAudit } from "../packages/server/audit-preview-handoff.ts";

// Run as a one-job invocation in an approved Node/Linux worker environment.
// This process never sends email, approves evidence or changes qualification.
if (process.env.ENABLE_WEBSITE_AUDIT !== "true") {
  throw new Error("WEBSITE_AUDIT_DISABLED");
}
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("SUPABASE_WORKER_CONFIG_REQUIRED");

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: leased, error: leaseError } = await db.rpc("lease_website_audit_job");
if (leaseError) throw new Error("AUDIT_LEASE_FAILED");
const job = Array.isArray(leased) ? leased[0] : leased;
if (job) {
  let result;
  let audited: Awaited<ReturnType<typeof auditWebsite>> | null = null;
  try {
    audited = await auditWebsite({
      url: job.official_url as string,
      permissionReference: job.permission_reference as string,
      approvedHosts: job.approved_hosts as string[],
    }, new NodePinnedAuditTransport());
    result = storedWebsiteAudit(audited, job.official_url as string);
  } catch (error) {
    result = failedWebsiteAudit(job.official_url as string, error);
  }
  const { error: finishError } = await db.rpc("finish_website_audit_job", {
    p_job: job.id,
    p_outcome: result.outcome,
    p_checked_url: result.checkedUrl,
    p_http_status: result.httpStatus,
    p_objective: result.objective,
    p_error_code: result.errorCode,
  });
  if (finishError) throw new Error("AUDIT_FINISH_FAILED");
  // Supabase's builder generics exceed TypeScript's instantiation depth when
  // related structurally; AuditContactDb is the narrow shape this call uses.
  await enrichAuditedOfficialContacts({ db: db as unknown as AuditContactDb, env: process.env,
    job: { org_id: job.org_id as string, lead_id: job.lead_id as string,
      official_url: job.official_url as string },
    audited, outcome: result.outcome });
  try {
    const handoff = await handoffCompletedWebsiteAudit({ supabaseUrl: url,
      internalSecret: process.env.INTERNAL_CRON_SECRET, leadId: job.lead_id as string });
    if (handoff === "not_configured") console.warn("AUDIT_PREVIEW_HANDOFF_NOT_CONFIGURED");
  } catch {
    // The factual audit has already been saved. It stays available for a
    // later bounded preview pass; never retry the external website request.
    console.warn("AUDIT_PREVIEW_HANDOFF_FAILED");
  }
}
