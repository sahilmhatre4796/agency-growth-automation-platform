import { discoverAuditedOfficialContacts } from "./vibe-contact-discovery.ts";

type LeadRow = { business_name: string; website_url: string | null; country: string | null };

// Structural slice of the Supabase client this worker uses, so the
// enrichment gate can be exercised without a live client.
export type AuditContactDb = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          maybeSingle(): PromiseLike<{ data: LeadRow | null; error: { message: string } | null }>;
        };
      };
    };
  };
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
};

// The saved audit stays factual on its own. Writing sourced contact
// observations is a separate, opt-in step so a routine audit run never
// mutates the contact store unless the operator enabled it explicitly.
export async function enrichAuditedOfficialContacts(input: {
  db: AuditContactDb;
  env: Record<string, string | undefined>;
  job: { org_id: string; lead_id: string; official_url: string };
  audited: { url: string; public_page_text: string; observed_at: string } | null;
  outcome: string;
}): Promise<void> {
  if (input.env.ENABLE_AUDIT_CONTACT_ENRICHMENT !== "true" ||
    input.outcome !== "ok" || !input.audited?.public_page_text) return;
  try {
    const { data: lead, error } = await input.db.from("leads")
      .select("business_name,website_url,country")
      .eq("org_id", input.job.org_id).eq("id", input.job.lead_id).maybeSingle();
    if (error) throw new Error("CONTACT_LEAD_UNAVAILABLE");
    if (lead && lead.website_url === input.job.official_url) {
      const observations = discoverAuditedOfficialContacts({
        lead_id: input.job.lead_id, business_name: lead.business_name,
        official_url: input.job.official_url, audited_url: input.audited.url,
        page_text: input.audited.public_page_text, observed_at: input.audited.observed_at,
        country: lead.country,
      });
      if (observations.length) {
        const { error: contactError } = await input.db.rpc("record_vibe_contact_observations", {
          p_org: input.job.org_id, p_lead: input.job.lead_id, p_provider: "official_website",
          p_observations: observations,
        });
        if (contactError) throw new Error("OFFICIAL_CONTACT_PERSIST_FAILED");
      }
    }
  } catch {
    // Audit success remains factual; contact enrichment stays pending.
    console.warn("OFFICIAL_CONTACT_ENRICHMENT_REVIEW_REQUIRED");
  }
}
