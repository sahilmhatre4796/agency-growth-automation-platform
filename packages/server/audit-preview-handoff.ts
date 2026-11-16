// A completed one-job pinned audit can hand its exact lead back to the
// existing preview worker. This is not a scheduler and cannot send outreach.
export async function handoffCompletedWebsiteAudit(input: {
  supabaseUrl: string;
  internalSecret: string | undefined;
  leadId: string;
}, fetcher: typeof fetch = fetch): Promise<"submitted" | "not_configured"> {
  if (!input.internalSecret || input.internalSecret.length < 32) return "not_configured";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.leadId))
    throw new Error("INVALID_AUDIT_LEAD");
  const base = new URL(input.supabaseUrl);
  if (base.protocol !== "https:") throw new Error("INVALID_SUPABASE_URL");
  const response = await fetcher(new URL("/functions/v1/research-preview-jobs", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cron-Signature": input.internalSecret,
      "X-Audit-Handoff": "1" },
    body: JSON.stringify({ lead_ids: [input.leadId] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("AUDIT_PREVIEW_HANDOFF_FAILED");
  return "submitted";
}
