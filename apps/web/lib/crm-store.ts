import { supabase } from "./supabase";
import {
  leadInput,
  identity,
  scoreLead,
  type Evidence,
  type LeadInput,
  type Score,
} from "../../../packages/shared/crm";
export type RecordLead = LeadInput & {
  id: string;
  is_demo: boolean;
  created_at: string;
  deal_value_paise: number | null;
  needs?: string | null;
  public_address?: string | null;
};
export type Note = { id: string; body: string; created_at: string };
export type ContactProfile = { id: string; email: string | null; phone_e164: string | null; contact_name: string | null; role: string | null; source_url: string | null; verified_at: string | null };
export type WebsiteAssessment = { status: string; official_url: string | null; reason: string; observed_at: string };
export type PublicContactPoint = { id: string; kind: "email" | "phone" | "whatsapp"; display_value: string; review_status: "pending" | "approved" | "rejected" };
export type PublicContactSource = { point_id: string; source_url: string; source_provider: string };
export type Task = {
  id: string;
  title: string;
  state: string;
  due_at: string | null;
};
export type Detail = {
  contacts: ContactProfile[];
  websiteAssessment: WebsiteAssessment | null;
  publicContacts: PublicContactPoint[];
  publicContactSources: PublicContactSource[];
  evidence: Evidence[];
  notes: Note[];
  tasks: Task[];
  scores: Score[];
  overrides?: { score: number; reason: string; created_at: string }[];
  activity: { action: string; occurred_at: string }[];
};
type DemoData = { leads: RecordLead[]; details: Record<string, Detail> };
const key = "chaincraft-synthetic-crm-v1";
const emptyDetail = (): Detail => ({
  contacts: [],
  websiteAssessment: null,
  publicContacts: [],
  publicContactSources: [],
  evidence: [],
  notes: [],
  tasks: [],
  scores: [],
  activity: [],
});
function readDemo(): DemoData {
  const raw = localStorage.getItem(key);
  if (raw) return JSON.parse(raw) as DemoData;
  const leads = ["Example Interiors", "Sample Artisan Shop"].map(
    (business_name, i) => ({
      ...leadInput.parse({
        business_name,
        website_url: `https://example.${i ? "org" : "com"}`,
        status: i ? "qualified" : "new",
      }),
      id: `demo-${i + 1}`,
      is_demo: true,
      created_at: new Date().toISOString(),
      deal_value_paise: null,
    }),
  );
  return { leads, details: {} };
}
function saveDemo(data: DemoData) {
  localStorage.setItem(key, JSON.stringify(data));
}
export function crmStore(demo: boolean, orgId: string) {
  const client = () => {
    if (!supabase || !orgId) throw new Error("Workspace is not configured.");
    return supabase;
  };
  const check = (error: unknown) => {
    if (error)
      throw new Error(
        "The operation could not be saved. Check permissions and connection.",
      );
  };
  return {
    async edit(id: string, input: LeadInput) {
      const business = {
        business_name: input.business_name, website_url: input.website_url,
        city: input.city, business_category: input.business_category,
        source_url: input.source_url, source_type: input.source_type,
        status: input.status,
      };
      if (demo) {
        const data = readDemo();
        if (
          data.leads.some((l) => l.id !== id && identity(l) === identity(input))
        )
          throw new Error("Duplicate business: review the existing record.");
        data.leads = data.leads.map((l) =>
          l.id === id ? { ...l, ...business } : l,
        );
        saveDemo(data);
        return;
      }
      const { error } = await client().rpc("edit_lead", {
        p_org: orgId,
        p_lead: id,
        p_input: business,
      });
      check(error);
    },
    async updateContactProfile(leadId: string, contactId: string, name: string, role: string, sourceUrl: string) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[leadId] ?? emptyDetail();
        detail.contacts = detail.contacts.map((contact) => contact.id === contactId
          ? { ...contact, contact_name: name || null, role: role || null, source_url: sourceUrl || null }
          : contact);
        data.details[leadId] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client().rpc("update_contact_profile", {
        p_org: orgId, p_lead: leadId, p_contact: contactId,
        p_name: name, p_role: role, p_source_url: sourceUrl,
      });
      check(error);
    },
    async addReviewedContact(leadId: string, email: string, sourceUrl: string, reviewNote: string) {
      if (demo) {
        const data = readDemo();
        if (data.leads.some((lead) => lead.email.toLowerCase() === email.toLowerCase()) ||
          Object.values(data.details).some((detail) => detail.contacts.some((contact) => contact.email?.toLowerCase() === email.toLowerCase())))
          throw new Error("Contact already exists. Review the existing record.");
        const detail = data.details[leadId] ?? emptyDetail();
        detail.contacts.push({ id: crypto.randomUUID(), email, phone_e164: null, contact_name: null, role: null, source_url: sourceUrl, verified_at: null });
        data.details[leadId] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client().rpc("add_reviewed_contact", {
        p_org: orgId, p_lead: leadId, p_email: email,
        p_source_url: sourceUrl, p_review_note: reviewNote,
      });
      check(error);
    },
    async override(id: string, score: number, reason: string) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.overrides = [
          { score, reason, created_at: new Date().toISOString() },
          ...(detail.overrides ?? []),
        ];
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client()
        .from("lead_score_overrides")
        .insert({ org_id: orgId, lead_id: id, score, reason });
      check(error);
    },
    async list(): Promise<RecordLead[]> {
      if (demo) return readDemo().leads;
      const { data, error } = await client()
        .from("leads")
        // contacts also has a direct lead_id FK; name the tenant-bound FK so
        // PostgREST does not reject this embed as an ambiguous relationship.
        .select("*,contacts!contacts_org_id_lead_id_fkey(email)")
        .eq("org_id", orgId)
        .eq("is_demo", false)
        .order("updated_at", { ascending: false })
        .limit(1000);
      check(error);
      return (data ?? []).map((l) => ({
        ...l,
        email: l.contacts?.find((contact: { email: string | null }) => contact.email)?.email ?? "",
        additional_emails: "", phones: "", identity_claim: "",
        city: l.city ?? "", country: l.country ?? "", state_region: l.state_region ?? "",
        source_observed_at: l.source_observed_at ?? "",
      })) as RecordLead[];
    },
    async import(rows: LeadInput[]) {
      if (demo) {
        const data = readDemo();
        let added = 0;
        for (const row of rows) {
          if (data.leads.some((l) => identity(l) === identity(row))) continue;
          data.leads.unshift({
            ...row,
            id: crypto.randomUUID(),
            is_demo: true,
            created_at: new Date().toISOString(),
            deal_value_paise: null,
          });
          added++;
        }
        saveDemo(data);
        return { added, skipped: rows.length - added, processing_attempted: 0 };
      }
      const { data, error } = await client().rpc("import_leads", {
        p_org: orgId,
        p_rows: rows,
      });
      check(error);
      const result = data as { added: number; skipped: number; created_lead_ids: string[] };
      const createdIds = result.created_lead_ids ?? [];
      let processingAttempted = 0;
      for (let offset = 0; offset < createdIds.length; offset += 10) {
        const { error: workerError } = await client().functions.invoke("research-preview-jobs", {
          body: { lead_ids: createdIds.slice(offset, offset + 10) },
        });
        if (workerError) break; // Intake is durable even if the optional processing pass is unavailable.
        processingAttempted += Math.min(10, createdIds.length - offset);
      }
      return { ...result, processing_attempted: processingAttempted };
    },
    async update(
      id: string,
      patch: Partial<
        Pick<RecordLead, "status" | "business_name" | "deal_value_paise">
      >,
    ) {
      if (demo) {
        const data = readDemo();
        data.leads = data.leads.map((l) =>
          l.id === id ? { ...l, ...patch } : l,
        );
        const detail = data.details[id] ?? emptyDetail();
        detail.activity.unshift({
          action: "lead_updated",
          occurred_at: new Date().toISOString(),
        });
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client()
        .from("leads")
        .update(patch)
        .eq("org_id", orgId)
        .eq("id", id);
      check(error);
    },
    async detail(id: string): Promise<Detail> {
      if (demo) return readDemo().details[id] ?? emptyDetail();
      const results = await Promise.all([
        client()
          .from("contacts")
          .select("id,email,phone_e164,contact_name,role,source_url,verified_at")
          .eq("org_id", orgId)
          .eq("lead_id", id)
          .order("created_at", { ascending: true }),
        client()
          .from("lead_evidence")
          .select("*")
          .eq("org_id", orgId)
          .eq("lead_id", id),
        client()
          .from("lead_notes")
          .select("*")
          .eq("org_id", orgId)
          .eq("lead_id", id),
        client()
          .from("tasks")
          .select("*")
          .eq("org_id", orgId)
          .eq("lead_id", id),
        client()
          .from("lead_scores")
          .select("*")
          .eq("org_id", orgId)
          .eq("lead_id", id)
          .order("created_at", { ascending: false }),
        client()
          .from("audit_events")
          .select("action,occurred_at")
          .eq("org_id", orgId)
          .eq("entity_id", id)
          .order("occurred_at", { ascending: false }),
        client()
          .from("vibe_contact_points")
          .select("id,kind,display_value,review_status")
          .eq("org_id", orgId)
          .eq("lead_id", id),
        client()
          .from("vibe_contact_sources")
          .select("point_id,source_url,source_provider")
          .eq("org_id", orgId)
          .eq("lead_id", id),
        client()
          .from("lead_website_assessments")
          .select("status,official_url,reason,observed_at")
          .eq("org_id", orgId)
          .eq("lead_id", id)
          .order("observed_at", { ascending: false })
          .limit(1),
      ]);
      results.forEach((r) => check(r.error));
      const overrideResult = await client()
        .from("lead_score_overrides")
        .select("score,reason,created_at")
        .eq("org_id", orgId)
        .eq("lead_id", id)
        .order("created_at", { ascending: false });
      check(overrideResult.error);
      return {
        contacts: results[0].data ?? [],
        websiteAssessment: (results[8].data?.[0] ?? null) as WebsiteAssessment | null,
        publicContacts: (results[6].data ?? []) as PublicContactPoint[],
        publicContactSources: (results[7].data ?? []) as PublicContactSource[],
        overrides: overrideResult.data ?? [],
        evidence: (results[1].data ?? []).map((e) => ({
          ...e,
          reviewed: Boolean(e.reviewed_by),
          rejected: Boolean(e.rejected_by),
        })) as Evidence[],
        notes: results[2].data ?? [],
        tasks: results[3].data ?? [],
        scores: results[4].data ?? [],
        activity: results[5].data ?? [],
      } as Detail;
    },
    async addEvidence(id: string, evidence: Omit<Evidence, "id">) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.evidence.unshift({ ...evidence, id: crypto.randomUUID() });
        detail.activity.unshift({
          action: "evidence_added",
          occurred_at: new Date().toISOString(),
        });
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { data } = await client().auth.getUser();
      const { reviewed, ...rest } = evidence;
      const { error } = await client()
        .from("lead_evidence")
        .insert({
          ...rest,
          org_id: orgId,
          lead_id: id,
          source_type: "manual",
          reviewed_by: reviewed ? data.user?.id : null,
        });
      check(error);
    },
    async note(id: string, body: string) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.notes.unshift({
          id: crypto.randomUUID(),
          body,
          created_at: new Date().toISOString(),
        });
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client()
        .from("lead_notes")
        .insert({ org_id: orgId, lead_id: id, body });
      check(error);
    },
    async task(id: string, title: string, due_at: string | null) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.tasks.push({
          id: crypto.randomUUID(),
          title,
          due_at,
          state: "open",
        });
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client()
        .from("tasks")
        .insert({ org_id: orgId, lead_id: id, title, due_at });
      check(error);
    },
    async completeTask(id: string, taskId: string) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.tasks = detail.tasks.map((t) =>
          t.id === taskId ? { ...t, state: "done" } : t,
        );
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client()
        .from("tasks")
        .update({ state: "done" })
        .eq("org_id", orgId)
        .eq("id", taskId);
      check(error);
    },
    async score(id: string) {
      if (demo) {
        const data = readDemo();
        const detail = data.details[id] ?? emptyDetail();
        detail.scores.unshift(scoreLead(detail.evidence));
        data.details[id] = detail;
        saveDemo(data);
        return;
      }
      const { error } = await client().rpc("score_lead", {
        p_org: orgId,
        p_lead: id,
      });
      check(error);
    },
  };
}
