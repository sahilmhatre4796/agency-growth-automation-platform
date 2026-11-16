"use client";
import { useCallback, useEffect, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";
import { sourceAuthority } from "../../../packages/server/source-authority";

type Contact = { id: string; lead_id: string; email_normalized: string | null };
type Lead = { id: string; business_name: string };
type Evidence = { id: string; kind: string; claim: string; url: string; observed_at: string; confidence: number };
type Report = {
  id: string; lead_id: string; contact_id: string | null; state: string; website: { status: string; url: string | null };
  evidence: Evidence[]; competitors: { name: string; url: string; capability: string; evidence_id: string }[];
  contact_candidates: { email: string; source_url: string; observed_at: string; confidence: number }[];
  opportunity: string; confidence: number; reason: string; provider: string; observed_at: string; expires_at: string;
};
type Job = { id: string; lead_id: string; provider: string; state: string; last_error_code: string | null; created_at: string };
type Draft = { draft_id: string; subjects: string[]; body: string; confidence: number; evidence_ids: string[]; suggested_service: string };
type ResearchPreview = { id: string; lead_id: string; report_id: string | null; service_id: string; subjects: string[]; body: string;
  confidence: number; evidence_ids: string[]; generator: string; basis: string; fact_claim: string | null; created_at: string };
type ReviewedEvidence = { id: string; lead_id: string; claim: string; source_url: string | null;
  observed_at: string; confidence: number; reviewed_by: string | null; rejected_by: string | null };
const opportunityLabels: Record<string, string> = {
  website_presence_review: "Website presence requires owner checks",
  website_improvement_review: "Website improvement requires a specific reviewed gap",
  business_research_only: "No service gap identified in this report",
  appointment_workflow_review: "Potential appointment and booking automation",
  whatsapp_enquiry_workflow_review: "Potential WhatsApp enquiry workflow",
  dealer_ordering_workflow_review: "Potential B2B ordering workflow",
  customer_support_workflow_review: "Potential customer support workflow",
};

export function previewFactMatchesSource(sourceClaim: string, factClaim: string | null) {
  if (!factClaim || factClaim.length > 180) return false;
  const normalized = sourceClaim.replace(/[\r\n“”"]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized === factClaim) return true;
  return factClaim.endsWith(".") &&
    new RegExp(`^${factClaim.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at \\d`).test(normalized);
}

export function BusinessResearch({ demo, orgId, role, initialLeadId, onOpenEmail }: { demo: boolean; orgId: string; role: string; initialLeadId?: string; onOpenEmail: () => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [preferred, setPreferred] = useState<Array<{ lead_id: string; normalized_value: string }>>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [provider, setProvider] = useState("serper");
  const [creditCap, setCreditCap] = useState(0);
  const [creditsReserved, setCreditsReserved] = useState(0);
  const [leadId, setLeadId] = useState(initialLeadId ?? "");
  const [contactId, setContactId] = useState("");
  const [reportId, setReportId] = useState("");
  const [language, setLanguage] = useState<"en" | "hinglish">("en");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previews, setPreviews] = useState<ResearchPreview[]>([]);
  const [reviewedEvidence, setReviewedEvidence] = useState<ReviewedEvidence[]>([]);
  const [services, setServices] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [contactReviewNote, setContactReviewNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    if (demo || !supabase || !orgId || role !== "admin") return;
    const [businesses, people, findings, queued, settings, usage, preferences, researchPreviews, evidence, catalog] = await Promise.all([
      supabase.from("leads").select("id,business_name").eq("org_id", orgId).eq("is_demo", false).order("updated_at", { ascending: false }).limit(500),
      supabase.from("contacts").select("id,lead_id,email_normalized").eq("org_id", orgId).not("email_normalized", "is", null).limit(1000),
      supabase.from("business_research_reports").select("id,lead_id,contact_id,state,website,evidence,competitors,contact_candidates,opportunity,confidence,reason,provider,observed_at,expires_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(100),
      supabase.from("business_research_jobs").select("id,lead_id,provider,state,last_error_code,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(50),
      supabase.from("organizations").select("research_provider,research_monthly_credit_cap").eq("id", orgId).single(),
      supabase.from("research_credit_usage").select("provider,month_start,reserved_credits").eq("org_id", orgId).order("month_start", { ascending: false }).limit(4),
      supabase.from("vibe_contact_points").select("lead_id,normalized_value").eq("org_id", orgId).eq("kind", "email").eq("preferred", true).limit(500),
      supabase.from("research_draft_previews").select("id,lead_id,report_id,service_id,subjects,body,confidence,evidence_ids,generator,basis,fact_claim,created_at")
        .eq("org_id", orgId).order("created_at", { ascending: false }).limit(100),
      supabase.from("lead_evidence").select("id,lead_id,claim,source_url,observed_at,confidence,reviewed_by,rejected_by")
        .eq("org_id", orgId).order("observed_at", { ascending: false }).limit(500),
      supabase.from("service_catalog").select("id,name,status").eq("org_id", orgId).limit(100),
    ]);
    if (businesses.error || people.error || findings.error || queued.error || settings.error || usage.error || preferences.error || researchPreviews.error || evidence.error || catalog.error) throw new Error("Stored research is unavailable.");
    setLeads((businesses.data ?? []) as Lead[]);
    setContacts((people.data ?? []) as Contact[]);
    setPreferred((preferences.data ?? []) as Array<{ lead_id: string; normalized_value: string }>);
    setPreviews((researchPreviews.data ?? []) as ResearchPreview[]);
    setReviewedEvidence((evidence.data ?? []) as ReviewedEvidence[]);
    setServices((catalog.data ?? []) as Array<{ id: string; name: string; status: string }>);
    setReports((findings.data ?? []) as Report[]);
    setJobs((queued.data ?? []) as Job[]);
    setProvider(settings.data.research_provider);
    setCreditCap(settings.data.research_monthly_credit_cap);
    const thisMonth = new Date().toISOString().slice(0, 7);
    setCreditsReserved(usage.data?.find((row) => row.provider === settings.data.research_provider && row.month_start.startsWith(thisMonth))?.reserved_credits ?? 0);
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  const report = reports.find((item) => item.id === reportId) ?? null;
  const preferredAddress = preferred.find((item) => item.lead_id === leadId)?.normalized_value;
  const availableContacts = contacts.filter((item) => item.lead_id === leadId)
    .sort((a, b) => Number(b.email_normalized === preferredAddress) - Number(a.email_normalized === preferredAddress));
  const availableReports = reports.filter((item) => item.lead_id === leadId && (!item.contact_id || item.contact_id === contactId));
  async function execute(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed."); }
    finally { setBusy(false); }
  }
  async function requestResearch() {
    await execute(async () => {
      const { data, error } = await supabase!.functions.invoke("business-research-request", {
        body: { org_id: orgId, lead_id: leadId, ...(contactId ? { contact_id: contactId } : {}), force: false },
      });
      if (error || data?.error) throw new Error(data?.error ?? "Research request blocked. Check verification, consent, and configuration.");
      setNotice(data.data?.state === "cached" ? "Fresh stored research reused." : "Research job recorded. The research worker is disabled until securely configured.");
      if (data.data?.report_id) setReportId(data.data.report_id);
    });
  }
  async function generate() {
    if (!report || !contactId) return;
    await execute(async () => {
      const { data, error } = await supabase!.functions.invoke("personalized-draft", {
        body: { org_id: orgId, report_id: report.id, contact_id: contactId, language },
      });
      if (error || data?.error) throw new Error(data?.error ?? "Personalization is disabled or the report needs review.");
      setDraft(data as Draft);
      setNotice("Draft saved for editing and human approval in Email. No message was sent.");
    });
  }
  async function approveCandidate(email: string) {
    if (!report) return;
    await execute(async () => {
      const { data, error } = await supabase!.rpc("approve_public_contact_candidate", {
        p_org: orgId, p_report: report.id, p_email: email, p_note: contactReviewNote,
      });
      if (error) throw new Error(error.message);
      if (!report.contact_id) setContactId(data as string);
      setContactReviewNote("");
      setNotice("Public address added for verification and consent review. Outreach remains blocked.");
    });
  }
  return <div className="research-workspace">
    <div className="safety-banner"><span><ShieldCheck size={16}/> Public-source research requires verified evidence and email eligibility. Every draft needs human approval.</span><span>{demo ? "Demo · no research" : "Stored findings"}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="panel">
      <div className="panel-heading"><h2><Search size={18}/> Business research</h2><button className="secondary" disabled={busy || demo || role !== "admin"} onClick={() => void execute(async () => { setNotice("Stored research refreshed."); })}>Refresh</button></div>
      {demo ? <p className="muted">Research requests are unavailable in the isolated demonstration.</p> : role !== "admin" ? <p className="muted">An organization admin can request and review research.</p> : <>
        <p className="muted">Provider: {provider === "serper" ? "Serper (preferred)" : "Tavily (optional)"} · Monthly credit cap: {creditCap} · Conservative reservations this month: {creditsReserved}. New requests stop when the cap cannot cover an attempt.</p>
        <div className="research-controls">
          <label>Business<select value={leadId} onChange={(event) => { setLeadId(event.target.value); setContactId(""); setReportId(""); setDraft(null); }}><option value="">Select a business</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.business_name}</option>)}</select></label>
          <label>Contact for later drafting (optional)<select value={contactId} onChange={(event) => { setContactId(event.target.value); setReportId(""); setDraft(null); }}><option value="">Research business before finding a contact</option>{availableContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.email_normalized}{contact.email_normalized === preferredAddress ? " · preferred by owner" : ""}</option>)}</select></label>
          <button className="primary" disabled={busy || !leadId} onClick={() => void requestResearch()}>Request research</button>
        </div>
        <p className="muted">Business-only research can begin before contact discovery. It still needs an approved budget and enabled worker. Contact verification, consent and suppression checks remain mandatory before drafting or sending.</p>
      </>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Evidence and opportunity</h2><span className="status">{report?.state ?? "No report selected"}</span></div>
      <label>Stored report<select value={reportId} onChange={(event) => { setReportId(event.target.value); setDraft(null); }}><option value="">Select a report</option>{availableReports.map((item) => <option key={item.id} value={item.id}>{new Date(item.observed_at).toLocaleString()} · {item.state}</option>)}</select></label>
      {report && <>
        <p>Research provider: {report.provider} · Research confidence: {Math.round(report.confidence * 100)}% · Opportunity: {opportunityLabels[report.opportunity] ?? "Owner review required"}</p>
        <p className="muted">{report.reason} · Expires {new Date(report.expires_at).toLocaleString()}</p>
        <p>Readable supplied website: {report.website.status === "verified" && report.website.url ? <><a href={report.website.url} target="_blank" rel="noopener noreferrer">{report.website.url}</a> · confirm official identity separately</> : "Not verified; absence was not established"}</p>
        <div className="research-evidence">{report.evidence.map((item) => <article key={item.id} className="verification-record"><strong>{item.kind.replaceAll("_", " ")} · {Math.round(item.confidence * 100)}%</strong><p>{item.claim}</p><a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a><small>Observed {new Date(item.observed_at).toLocaleString()}</small></article>)}</div>
        <h3>Comparable businesses</h3>{report.competitors.length ? report.competitors.map((item) => <p key={item.evidence_id}>{item.name} · observed capability: {item.capability} · <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a></p>) : <p className="muted">No comparable business verified.</p>}
        <h3>Public contact candidates</h3>
        {(report.contact_candidates ?? []).length ? <>
          <p className="muted">These addresses appeared on the readable site. Review the linked website evidence first. Adding one to CRM does not verify its inbox, grant consent, or permit sending.</p>
          <label>Why this address belongs to the business<input value={contactReviewNote} onChange={(event) => setContactReviewNote(event.target.value)} maxLength={500} placeholder="Record your source and identity review (20–500 characters)" /></label>
          {report.contact_candidates.map((candidate) => <div className="verification-record" key={candidate.email}>
            <strong>{candidate.email}</strong> · {Math.round(candidate.confidence * 100)}% extraction confidence<br />
            <a href={candidate.source_url} target="_blank" rel="noopener noreferrer">Source page</a> · observed {new Date(candidate.observed_at).toLocaleString()}
            <button className="secondary" disabled={busy || demo || role !== "admin" || contactReviewNote.trim().length < 20 || !!contacts.find((item) => item.lead_id === report.lead_id && item.email_normalized === candidate.email)} onClick={() => void approveCandidate(candidate.email)}>Add reviewed address to CRM</button>
          </div>)}
        </> : <p className="muted">No same-domain address was found on the readable page.</p>}
        <label>Draft language<select value={language} onChange={(event) => setLanguage(event.target.value as "en" | "hinglish")}><option value="en">English</option><option value="hinglish">Hinglish</option></select></label>
        <button className="primary" disabled={busy || role !== "admin" || !contactId || report.state !== "ready"} onClick={() => void generate()}>{draft ? "Regenerate reviewed-source draft" : "Generate reviewed-source draft"}</button>
        <p className="muted">AI selection runs only after secure server configuration and an approved free-tier budget. Generation saves a draft; open Email to edit, inspect the sender, and approve it.</p>
      </>}
      {draft && <div className="verification-record"><h3>Draft preview · {Math.round(draft.confidence * 100)}% confidence</h3><p>Suggested service: {draft.suggested_service}</p><p>Subject options: {draft.subjects.join(" / ")}</p><pre className="research-draft">{draft.body}</pre><small>Evidence IDs: {draft.evidence_ids.join(", ")}</small><button className="secondary" onClick={onOpenEmail}>Edit and approve in Email</button><p className="muted">Regenerate here or open Email and select this draft to edit, inspect the sender, and approve.</p></div>}
      {leadId && previews.filter((item) => item.lead_id === leadId).map((item) => {
        const sources = item.evidence_ids.map((id) => reviewedEvidence.find((evidence) => evidence.id === id && evidence.lead_id === item.lead_id));
        const sourceHosts = sources.map((source) => { try { return sourceAuthority(source?.source_url ?? ""); } catch { return null; } });
        const evidenceCurrent = (item.basis !== "potential_use_case" ||
          (sourceHosts.every(Boolean) && new Set(sourceHosts).size >= 2)) &&
          sources.every((source, index) => source && !source.rejected_by &&
          (item.basis === "potential_use_case" ? (index !== 0 || previewFactMatchesSource(source.claim, item.fact_claim)) &&
            Number(source.confidence) >= 0.8 && source.source_url?.startsWith("https://") :
            source.reviewed_by && Number(source.confidence) >= 0.7) &&
          Date.parse(source.observed_at) > Date.now() - 30 * 86400000 &&
          Date.parse(source.observed_at) <= Date.now());
        return <div className="verification-record" key={item.id}>
          <h3>RESEARCH PREVIEW — NOT APPROVED FOR SENDING</h3>
          <p>{item.generator === "groq_selected_template" ? "Groq-selected grounded copy" : "Grounded template"} · {Math.round(item.confidence * 100)}% evidence confidence · {item.basis === "potential_use_case" ? "Potential use case, no service gap confirmed" : "Reviewed gap"} · Owner review required</p>
          <p>Suggested service: {services.find((service) => service.id === item.service_id)?.name ?? "Service review required"} · Catalog status: {services.find((service) => service.id === item.service_id)?.status ?? "unknown"}</p>
          {evidenceCurrent ? <><p>Subject options: {item.subjects.join(" / ")}</p>
            <pre className="research-draft">{item.body}</pre></> :
            <p role="status">Source evidence changed or expired. Review it again before using this preview.</p>}
          {item.evidence_ids.map((id) => { const source = reviewedEvidence.find((evidence) => evidence.id === id && evidence.lead_id === item.lead_id);
            return <p key={id}>{source?.claim ?? "Evidence not currently available"} · {source?.source_url?.startsWith("https://") ?
              <a href={source.source_url} target="_blank" rel="noopener noreferrer">Public source</a> : "Source URL unavailable"}</p>;
          })}
          <small>Created {new Date(item.created_at).toLocaleString()}</small>
          <p className="muted">Internal research copy only. This record has no sender, approval, scheduling, or send action.</p>
        </div>; })}
    </section>
    <section className="panel"><h2>Recent research jobs</h2>{jobs.length ? jobs.map((job) => <p key={job.id}>{leads.find((lead) => lead.id === job.lead_id)?.business_name ?? "Business"} · {job.provider} · {job.state} · {new Date(job.created_at).toLocaleString()} {job.last_error_code ? `· ${job.last_error_code}` : ""}</p>) : <p className="muted">No research jobs yet.</p>}</section>
  </div>;
}
