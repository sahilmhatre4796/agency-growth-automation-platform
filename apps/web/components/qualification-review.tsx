"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { websiteCheckSignal } from "../../../packages/server/website-gap";

type Lead = { id: string; business_name: string; business_category: string | null; city: string | null; website_url: string | null };
type Service = { id: string; name: string; status: string };
type Evidence = { id: string; lead_id: string; claim: string; source_url: string | null; source_type: string; confidence: number; reviewed_by: string | null; rejected_by: string | null; observed_at: string };
type Match = { id: string; lead_id: string; service_id: string; status: string; reason: string; confidence: number; evidence_ids: string[]; assessed_at: string };
type Qualification = { id: string; lead_id: string; primary_service_id: string | null; status: string; score: number; confidence: number; reasons: string[]; evaluated_at: string };
type Website = { lead_id: string; status: string; official_url: string | null; reason: string; observed_at: string };
type WebsiteObservation = { lead_id: string; state: string; reason: string; recorded_url: string | null;
  checked_url: string | null; http_status: number | null; proposed_website_url: string | null;
  proposal_source_url: string | null; observed_at: string };
type AuditJob = { id: string; lead_id: string; state: string; requested_at: string; lease_until: string | null; error_code: string | null };
type AuditObservation = { id: string; lead_id: string; checked_url: string; outcome: string; http_status: number | null; objective: { title?: string | null }; checked_at: string };
type Source = { id: string; lead_id: string; source: string; actual_provider: string; proposed_category: string | null; proposed_website_url: string | null; source_url: string | null; observed_at: string };
type Candidate = { id: string; source: string; actual_provider: string; business_name: string; city: string | null; website_url: string | null; source_url: string; evidence_url: string | null; evidence_quote: string | null; proposed_category: string | null; possible_lead_ids: string[]; reason: string };

export function QualificationReview({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [websiteObservations, setWebsiteObservations] = useState<WebsiteObservation[]>([]);
  const [auditJobs, setAuditJobs] = useState<AuditJob[]>([]);
  const [auditObservations, setAuditObservations] = useState<AuditObservation[]>([]);
  const [auditAsOf, setAuditAsOf] = useState(0);
  const [sources, setSources] = useState<Source[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateTargets, setCandidateTargets] = useState<Record<string, string>>({});
  const [leadId, setLeadId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [matchStatus, setMatchStatus] = useState<"verified_gap" | "research_needed" | "rejected">("research_needed");
  const [reason, setReason] = useState("");
  const [confidence, setConfidence] = useState(0.7);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [evidenceReviewNote, setEvidenceReviewNote] = useState("");
  const [evidenceReviewConfidence, setEvidenceReviewConfidence] = useState(0.7);
  const [officialUrl, setOfficialUrl] = useState("");
  const [officialReason, setOfficialReason] = useState("");
  const [officialEvidenceId, setOfficialEvidenceId] = useState("");
  const [manualIdentityUrl, setManualIdentityUrl] = useState("");
  const [manualIdentityClaim, setManualIdentityClaim] = useState("");
  const [manualIdentityNote, setManualIdentityNote] = useState("");
  const [businessStatementUrl, setBusinessStatementUrl] = useState("");
  const [businessStatementQuote, setBusinessStatementQuote] = useState("");
  const [businessStatementNote, setBusinessStatementNote] = useState("");
  const [categorySourceId, setCategorySourceId] = useState("");
  const [categoryEvidenceId, setCategoryEvidenceId] = useState("");
  const [categoryReason, setCategoryReason] = useState("");
  const [websiteStatus, setWebsiteStatus] = useState("UNKNOWN");
  const [websiteReason, setWebsiteReason] = useState("");
  const [websiteConfidence, setWebsiteConfidence] = useState(0.7);
  const [auditPermission, setAuditPermission] = useState("");
  const [auditHosts, setAuditHosts] = useState("");
  const [auditReviewNote, setAuditReviewNote] = useState("");
  const [auditCloseReason, setAuditCloseReason] = useState("");
  const [check1Url, setCheck1Url] = useState("");
  const [check1At, setCheck1At] = useState("");
  const [check1Outcome, setCheck1Outcome] = useState("ok");
  const [check2Url, setCheck2Url] = useState("");
  const [check2At, setCheck2At] = useState("");
  const [check2Outcome, setCheck2Outcome] = useState("ok");
  const [redirectChecked, setRedirectChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    if (!supabase || demo || !orgId || role !== "admin") return;
    const [businesses, catalog, facts, serviceMatches, qualified, websiteChecks, machineChecks, provenance, ambiguous, audits, observations] = await Promise.all([
      supabase.from("leads").select("id,business_name,business_category,city,website_url").eq("org_id", orgId).eq("is_demo", false).order("updated_at", { ascending: false }).limit(500),
      supabase.from("service_catalog").select("id,name,status").eq("org_id", orgId).order("service_key"),
      supabase.from("lead_evidence").select("id,lead_id,claim,source_url,source_type,confidence,reviewed_by,rejected_by,observed_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(1000),
      supabase.from("lead_service_matches").select("id,lead_id,service_id,status,reason,confidence,evidence_ids,assessed_at").eq("org_id", orgId).order("assessed_at", { ascending: false }).limit(500),
      supabase.from("lead_qualifications").select("id,lead_id,primary_service_id,status,score,confidence,reasons,evaluated_at").eq("org_id", orgId).order("evaluated_at", { ascending: false }).limit(500),
      supabase.from("lead_website_assessments").select("lead_id,status,official_url,reason,observed_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(500),
      supabase.from("lead_website_observations").select("lead_id,state,reason,recorded_url,checked_url,http_status,proposed_website_url,proposal_source_url,observed_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(500),
      supabase.from("lead_discovery_sources").select("id,lead_id,source,actual_provider,proposed_category,proposed_website_url,source_url,observed_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(500),
      supabase.from("discovery_candidates").select("id,source,actual_provider,business_name,city,website_url,source_url,evidence_url,evidence_quote,proposed_category,possible_lead_ids,reason").eq("org_id", orgId).eq("state", "review_needed").order("created_at", { ascending: false }).limit(100),
      supabase.from("website_audit_jobs").select("id,lead_id,state,requested_at,lease_until,error_code").eq("org_id", orgId).order("requested_at", { ascending: false }).limit(100),
      supabase.from("website_audit_observations").select("id,lead_id,checked_url,outcome,http_status,objective,checked_at").eq("org_id", orgId).order("checked_at", { ascending: false }).limit(100),
    ]);
    if ([businesses, catalog, facts, serviceMatches, qualified, websiteChecks, machineChecks, provenance, ambiguous, audits, observations].some((result) => result.error)) throw new Error("Qualification records could not be loaded.");
    setLeads((businesses.data ?? []) as Lead[]); setServices((catalog.data ?? []) as Service[]);
    setEvidence((facts.data ?? []) as Evidence[]); setMatches((serviceMatches.data ?? []) as Match[]);
    setQualifications((qualified.data ?? []) as Qualification[]); setWebsites((websiteChecks.data ?? []) as Website[]);
    setWebsiteObservations((machineChecks.data ?? []) as WebsiteObservation[]);
    setSources((provenance.data ?? []) as Source[]);
    setCandidates((ambiguous.data ?? []) as Candidate[]);
    setAuditJobs((audits.data ?? []) as AuditJob[]);
    setAuditObservations((observations.data ?? []) as AuditObservation[]);
    setAuditAsOf(Date.now());
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  const lead = leads.find((item) => item.id === leadId);
  const latest = qualifications.find((item) => item.lead_id === leadId);
  const website = websites.find((item) => item.lead_id === leadId);
  const machineWebsite = websiteObservations.find((item) => item.lead_id === leadId);
  const auditSignal = websiteCheckSignal(auditObservations.filter((item) => item.lead_id === leadId), lead?.website_url ?? null, auditAsOf);
  const eligibleEvidence = evidence.filter((item) => item.lead_id === leadId && item.reviewed_by && item.source_url && item.confidence >= 0.7);
  const pendingDiscoveryEvidence = evidence.filter((item) => item.lead_id === leadId &&
    ["serper", "harvey", "serper_business_fact", "tavily_business_fact", "serper_competitor", "tavily_competitor", "serper_website", "tavily_website"].includes(item.source_type) &&
    !item.reviewed_by && !item.rejected_by);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be saved."); }
    finally { setBusy(false); }
  }
  async function recordMatch() {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("record_service_match", {
        p_org: orgId, p_lead: leadId, p_service: serviceId, p_status: matchStatus,
        p_reason: reason.trim(), p_evidence_ids: selectedEvidence, p_confidence: confidence,
      });
      if (rpcError) throw new Error("Service review rejected. Verified gaps need current, reviewed evidence for this business.");
      setNotice("Service match recorded. Run qualification to update the lead outcome.");
      setReason(""); setSelectedEvidence([]);
    });
  }
  async function evaluate() {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("evaluate_lead_qualification", { p_org: orgId, p_lead: leadId });
      if (rpcError) throw new Error("Qualification could not be evaluated. Check catalog approval and targeting.");
      setNotice("Qualification evaluated from stored evidence. This did not draft or send outreach.");
    });
  }
  async function recordWebsite() {
    await run(async () => {
      const checks = [
        check1Url && check1At ? { url: check1Url.trim(), checked_at: new Date(check1At).toISOString(), outcome: check1Outcome, redirect_checked: redirectChecked } : null,
        check2Url && check2At ? { url: check2Url.trim(), checked_at: new Date(check2At).toISOString(), outcome: check2Outcome, redirect_checked: redirectChecked } : null,
      ].filter(Boolean);
      const { error: rpcError } = await supabase!.rpc("record_website_assessment", {
        p_org: orgId, p_lead: leadId, p_status: websiteStatus,
        p_official_url: websiteStatus === "NO_OFFICIAL_WEBSITE_DISCOVERED" || websiteStatus === "UNKNOWN" ? null : lead?.website_url,
        p_checks: checks, p_evidence_ids: selectedEvidence, p_reason: websiteReason.trim(), p_confidence: websiteConfidence,
      });
      if (rpcError) throw new Error("Website review rejected. Confirm the official URL, check dates, source evidence and repeated failures where required.");
      setNotice("Website assessment recorded. Search absence remains an observation, not proof of no website.");
    });
  }
  async function requestAudit() {
    await run(async () => {
      const hosts = auditHosts.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      const { error: rpcError } = await supabase!.rpc("request_website_audit", {
        p_org: orgId, p_lead: leadId,
        p_permission_reference: auditPermission.trim(), p_approved_hosts: hosts,
      });
      if (rpcError) throw new Error("Audit request rejected. Confirm the official URL, permitted public access and approved hosts; check for an existing pending request.");
      setNotice("Audit request queued. The separate pinned Node worker is disabled until an approved environment is configured.");
      setAuditPermission("");
    });
  }
  async function reviewAuditObservation(id: string) {
    await run(async () => {
      const { data, error: rpcError } = await supabase!.rpc("review_website_audit_observation", {
        p_org: orgId, p_observation: id, p_note: auditReviewNote.trim(),
      });
      if (rpcError) throw new Error("Observation review rejected. Only recent completed HTTP checks can become factual evidence.");
      setSelectedEvidence((current) => current.includes(data as string) ? current : [...current, data as string]);
      setAuditReviewNote("");
      setNotice("Objective check saved as reviewed evidence. A separate reasoned assessment is still required for any service recommendation.");
    });
  }
  async function closeExpiredAudit(id: string) {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("close_expired_website_audit_job", {
        p_org: orgId, p_job: id, p_reason: auditCloseReason.trim(),
      });
      if (rpcError) throw new Error("Expired audit could not be closed. Check the lease deadline and review reason.");
      setAuditCloseReason("");
      setNotice("Uncertain audit lease closed after review. A fresh check needs a new owner request.");
    });
  }
  function fillAuditObservation(item: AuditObservation, number: 1 | 2) {
    const date = new Date(item.checked_at);
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    if (number === 1) { setCheck1Url(item.checked_url); setCheck1At(localDate); setCheck1Outcome(item.outcome); }
    else { setCheck2Url(item.checked_url); setCheck2At(localDate); setCheck2Outcome(item.outcome); }
  }
  async function reviewCandidate(id: string, action: "merge" | "discard") {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("resolve_discovery_candidate", {
        p_org: orgId, p_candidate: id, p_action: action, p_lead: action === "merge" ? candidateTargets[id] : null,
      });
      if (rpcError) throw new Error("Discovery review could not be saved. Confirm the target business identity.");
      setNotice(action === "merge" ? "Source linked to the selected CRM business. No contacts or consent were merged." : "Discovery candidate discarded.");
    });
  }
  async function reviewDiscoveryEvidence(id: string, decision: "approve" | "reject") {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("review_discovery_evidence", {
        p_org: orgId, p_evidence: id, p_decision: decision,
        p_confidence: evidenceReviewConfidence, p_note: evidenceReviewNote.trim(),
      });
      if (rpcError) throw new Error("Evidence review was rejected. Check the source, date, confidence and review note.");
      setEvidenceReviewNote("");
      setNotice(decision === "approve" ? "Source fact reviewed. A service gap still needs separate evidence and assessment." : "Unsupported observation rejected.");
    });
  }
  async function confirmOfficialWebsite() {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("confirm_discovered_website", {
        p_org: orgId, p_lead: leadId, p_evidence: officialEvidenceId,
        p_url: officialUrl.trim(), p_reason: officialReason.trim(),
      });
      if (rpcError) throw new Error("Official website confirmation rejected. The reviewed source must name this business and match the proposed site.");
      setCheck1Url(officialUrl.trim()); setCheck2Url(officialUrl.trim());
      setOfficialReason(""); setNotice("Official site confirmed by owner. Record a separate working or problem assessment before suggesting a website service.");
    });
  }
  async function recordManualIdentity() {
    await run(async () => {
      const { data, error: rpcError } = await supabase!.rpc("record_manual_identity_evidence", {
        p_org: orgId, p_lead: leadId, p_url: manualIdentityUrl,
        p_claim: manualIdentityClaim.trim(), p_note: manualIdentityNote.trim(),
      });
      if (rpcError) throw new Error("Identity observation rejected. Use the exact proposed URL and a checked page excerpt naming the business.");
      setOfficialEvidenceId(data as string); setOfficialUrl(manualIdentityUrl);
      setManualIdentityClaim(""); setManualIdentityNote("");
      setNotice("Manual source observation recorded with your review. Confirm the official site separately below.");
    });
  }
  async function recordBusinessStatement() {
    await run(async () => {
      const { data, error: rpcError } = await supabase!.rpc("record_business_website_statement", {
        p_org: orgId, p_lead: leadId, p_source_url: businessStatementUrl.trim(),
        p_quote: businessStatementQuote.trim(), p_review_note: businessStatementNote.trim(),
      });
      if (rpcError) throw new Error("Business statement review rejected. Cite a checked public statement from this business and record how you verified it.");
      setSelectedEvidence((current) => [...current, data as string]);
      setBusinessStatementQuote(""); setBusinessStatementNote("");
      setNotice("Business statement saved and selected as website evidence. Record the separate website assessment before qualification.");
    });
  }
  async function confirmCategory() {
    await run(async () => {
      const { error: rpcError } = await supabase!.rpc("confirm_discovered_category", {
        p_org: orgId, p_lead: leadId, p_source: categorySourceId,
        p_evidence: categoryEvidenceId, p_reason: categoryReason.trim(),
      });
      if (rpcError) throw new Error("Category confirmation rejected. Review a matching source fact for this business.");
      setCategoryReason(""); setNotice("Business category confirmed from reviewed source evidence. Qualification still needs a verified service gap and contact eligibility.");
    });
  }
  return <section className="panel">
    <div className="panel-heading"><h2>Evidence-based qualification</h2><span className="status">No autonomous discovery or outreach</span></div>
    {demo ? <p className="muted">Qualification review is unavailable in demo.</p> : role !== "admin" ? <p className="muted">An organization admin can review service gaps.</p> : <>
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
      <p className="muted">Review source facts in Leads first. A missing public signal does not prove a service is absent. Uncertain opportunities remain research needed.</p>
      <h3>Ambiguous discovery identities</h3>
      {candidates.length ? candidates.map((candidate) => <article key={candidate.id} className="verification-record">
        <strong>{candidate.business_name} · {candidate.city || "Location unknown"} · {candidate.source.toUpperCase()} ({candidate.actual_provider})</strong>
        <p>{candidate.reason}</p>
        <small>{candidate.proposed_category || "Category unconfirmed"} · {candidate.website_url || "Official website unconfirmed"} · <a href={candidate.source_url} target="_blank" rel="noopener noreferrer">Search source</a></small>
        {candidate.evidence_quote && <p>Page excerpt: {candidate.evidence_quote} {candidate.evidence_url && <a href={candidate.evidence_url} target="_blank" rel="noopener noreferrer">Inspect page</a>}</p>}
        <div className="button-row"><label>Existing CRM business<select value={candidateTargets[candidate.id] ?? ""} onChange={(event) => setCandidateTargets({ ...candidateTargets, [candidate.id]: event.target.value })}><option value="">Select after identity review</option>{candidate.possible_lead_ids.map((id) => <option key={id} value={id}>{leads.find((item) => item.id === id)?.business_name ?? id}</option>)}</select></label>
          <button className="secondary" disabled={busy || !candidateTargets[candidate.id]} onClick={() => void reviewCandidate(candidate.id, "merge")}>Link source to business</button>
          <button className="secondary" disabled={busy} onClick={() => void reviewCandidate(candidate.id, "discard")}>Discard candidate</button>
        </div>
      </article>) : <p className="muted">No ambiguous discovery candidates.</p>}
      <label>Business<select value={leadId} onChange={(event) => { setLeadId(event.target.value); setSelectedEvidence([]); setOfficialEvidenceId(""); setOfficialUrl(""); setCategorySourceId(""); setCategoryEvidenceId(""); const selected = leads.find((item) => item.id === event.target.value); setCheck1Url(selected?.website_url ?? ""); setCheck2Url(selected?.website_url ?? ""); try { setAuditHosts(selected?.website_url ? new URL(selected.website_url).hostname : ""); } catch { setAuditHosts(""); } }}><option value="">Select a business</option>{leads.map((item) => <option key={item.id} value={item.id}>{item.business_name}</option>)}</select></label>
      {lead && <>
        <p><strong>{lead.business_name}</strong> · {lead.business_category || "Industry unknown"} · {lead.city || "City unknown"}</p>
        <p>Website: {website ? `${website.status.replaceAll("_", " ")} · ${website.reason}` : "UNKNOWN — no reviewed assessment"}{website?.official_url && <> · <a href={website.official_url} target="_blank" rel="noopener noreferrer">Official URL</a></>}</p>
        {machineWebsite && <p className="muted">Automated observation — owner review required: {machineWebsite.state.replaceAll("_", " ")} · {machineWebsite.reason}
          {machineWebsite.checked_url && <> · <a href={machineWebsite.checked_url} target="_blank" rel="noopener noreferrer">Checked URL</a>{machineWebsite.http_status ? ` (HTTP ${machineWebsite.http_status})` : ""}</>}
          {machineWebsite.proposed_website_url && <> · <a href={machineWebsite.proposed_website_url} target="_blank" rel="noopener noreferrer">Proposed website</a></>}
          {machineWebsite.proposal_source_url && <> · <a href={machineWebsite.proposal_source_url} target="_blank" rel="noopener noreferrer">Discovery source</a></>}
        </p>}
        {auditSignal.signal === "reachable" && <p className="muted">Latest pinned check reached the site. This does not assess its quality or rule out a specific evidenced improvement.</p>}
        {auditSignal.signal === "repeated_server_error_review" && <p className="muted">Two pinned checks at least 24 hours apart returned server errors. Review both observations and rule out temporary or anti-bot responses before recording a website problem.</p>}
        {lead.website_url && <details><summary>Request a permitted public-site check</summary>
          <p className="muted">The site must be confirmed as official. Record where you verified that direct public access is permitted. A separate pinned Node worker checks robots rules and records objective metadata; it is disabled by default. Results require your review and do not automatically prove a service gap.</p>
          <label>Permission/source reference<input value={auditPermission} onChange={(event) => setAuditPermission(event.target.value)} minLength={15} maxLength={500} placeholder="Public access policy or documented owner permission"/></label>
          <label>Approved redirect hosts (comma-separated)<input value={auditHosts} onChange={(event) => setAuditHosts(event.target.value)} placeholder="business.example.org, www.business.example.org"/></label>
          <button className="secondary" disabled={busy || auditPermission.trim().length < 15 || !auditHosts.trim()} onClick={() => void requestAudit()}>Queue website check</button>
          <label>Reason to close an expired uncertain check<textarea value={auditCloseReason} onChange={(event) => setAuditCloseReason(event.target.value)} minLength={20} maxLength={500} rows={2}/></label>
          {auditJobs.filter((job) => job.lead_id === leadId).slice(0, 3).map((job) => <div key={job.id} className="verification-record">
            <p className="muted">Requested {new Date(job.requested_at).toLocaleString()} · {job.state.replaceAll("_", " ")}{job.error_code && ` · ${job.error_code}`}</p>
            {job.state === "leased" && job.lease_until &&
              <button className="secondary" disabled={busy || auditCloseReason.trim().length < 20} onClick={() => void closeExpiredAudit(job.id)}>Close expired check after review</button>}
          </div>)}
          <label>Review note for an objective check<textarea value={auditReviewNote} onChange={(event) => setAuditReviewNote(event.target.value)} minLength={20} maxLength={500} rows={2} placeholder="What did you verify, and why is this observation relevant?"/></label>
          {auditObservations.filter((item) => item.lead_id === leadId).slice(0, 6).map((item) => <div className="verification-record" key={item.id}>
            <p className="muted">{new Date(item.checked_at).toLocaleString()} · {item.outcome.replaceAll("_", " ")}{item.http_status && ` (${item.http_status})`} · <a href={item.checked_url} target="_blank" rel="noopener noreferrer">Checked URL</a>{item.objective.title && ` · ${item.objective.title}`}</p>
            {item.outcome !== "review_required" && <div className="button-row">
              <button className="secondary" disabled={busy || auditReviewNote.trim().length < 20} onClick={() => void reviewAuditObservation(item.id)}>Review as factual evidence</button>
              <button className="secondary" onClick={() => fillAuditObservation(item, 1)}>Use as check 1</button>
              <button className="secondary" onClick={() => fillAuditObservation(item, 2)}>Use as check 2</button>
            </div>}
          </div>)}
        </details>}
        <p>Discovery: {sources.filter((item) => item.lead_id === leadId).length ? sources.filter((item) => item.lead_id === leadId).map((item) => `${item.source.toUpperCase()} (${item.actual_provider})`).join(" + ") : "No provider source record"}</p>
        <p>Qualification: <strong>{latest?.status.replaceAll("_", " ") ?? "Not evaluated"}</strong>{latest && ` · score ${latest.score} · confidence ${Math.round(latest.confidence * 100)}%`}</p>
        {latest?.reasons.map((item) => <p className="muted" key={item}>{item}</p>)}
        <h3>Public-source facts awaiting review</h3>
        <p className="muted">Open the original page and verify the quote names this business. An excerpt cannot by itself prove the website is official or that a service is missing. Confirm the category in Leads before qualification.</p>
        {pendingDiscoveryEvidence.length ? pendingDiscoveryEvidence.map((item) => <article className="verification-record" key={item.id}>
          <p>{item.claim}</p><small>{item.source_type.toUpperCase()} · {new Date(item.observed_at).toLocaleDateString()} · {item.source_url ? <a href={item.source_url} target="_blank" rel="noopener noreferrer">Inspect source</a> : "No source URL"}</small>
          <label>Review note<textarea value={evidenceReviewNote} onChange={(event) => setEvidenceReviewNote(event.target.value)} maxLength={500} rows={2} placeholder="What did you independently confirm on the source page?" /></label>
          <label>Confidence<input type="number" min="0" max="1" step="0.05" value={evidenceReviewConfidence} onChange={(event) => setEvidenceReviewConfidence(Number(event.target.value))}/></label>
          <div className="button-row"><button className="secondary" disabled={busy || evidenceReviewNote.trim().length < 20} onClick={() => void reviewDiscoveryEvidence(item.id, "approve")}>Approve observed fact</button>
            <button className="secondary" disabled={busy || evidenceReviewNote.trim().length < 20} onClick={() => void reviewDiscoveryEvidence(item.id, "reject")}>Reject observation</button></div>
        </article>) : <p className="muted">No unreviewed discovery facts for this business.</p>}
        <h3>Reviewed evidence</h3>{eligibleEvidence.length ? eligibleEvidence.map((item) => <label key={item.id} className="verification-record"><input type="checkbox" checked={selectedEvidence.includes(item.id)} onChange={(event) => setSelectedEvidence(event.target.checked ? [...selectedEvidence, item.id] : selectedEvidence.filter((id) => id !== item.id))}/>{item.claim}<small>{Math.round(item.confidence * 100)}% · {new Date(item.observed_at).toLocaleDateString()} · <a href={item.source_url!} target="_blank" rel="noopener noreferrer">Source</a></small></label>) : <p className="muted">No reviewed public-source evidence for this business.</p>}
        {!lead.business_category && sources.some((item) => item.lead_id === leadId && item.proposed_category) && <details><summary>Confirm discovered business category</summary>
          <p className="muted">The search target is only a proposed category. Inspect a matching public source before confirming it.</p>
          <label>Proposed category<select value={categorySourceId} onChange={(event) => setCategorySourceId(event.target.value)}><option value="">Select a source</option>{sources.filter((item) => item.lead_id === leadId && item.proposed_category).map((item) => <option key={item.id} value={item.id}>{item.proposed_category} · {item.source.toUpperCase()}</option>)}</select></label>
          <label>Reviewed identity fact<select value={categoryEvidenceId} onChange={(event) => setCategoryEvidenceId(event.target.value)}><option value="">Select a fact</option>{eligibleEvidence.filter((item) => ["serper", "harvey"].includes(item.source_type)).map((item) => <option key={item.id} value={item.id}>{item.claim.slice(0, 90)}</option>)}</select></label>
          <label>Review reason<textarea value={categoryReason} onChange={(event) => setCategoryReason(event.target.value)} minLength={20} maxLength={500} rows={2}/></label>
          <button className="secondary" disabled={busy || !categorySourceId || !categoryEvidenceId || categoryReason.trim().length < 20} onClick={() => void confirmCategory()}>Confirm category</button>
        </details>}
        {!lead.website_url && <details><summary>Confirm a discovered official website</summary>
          <p className="muted">Inspect the page independently. Select evidence that names this business and confirm that the page is its own site. This does not establish whether the site works well.</p>
          {sources.filter((item) => item.lead_id === leadId && item.proposed_website_url).map((item) => <p key={item.id} className="muted">{item.actual_provider} proposed <a href={item.proposed_website_url!} target="_blank" rel="noopener noreferrer">{item.proposed_website_url}</a> · unconfirmed listing field; first obtain reviewed identity evidence from that site.</p>)}
          {sources.some((item) => item.lead_id === leadId && item.proposed_website_url) && <div className="verification-record">
            <strong>Record a checked on-site identity observation</strong>
            <label>Proposed site<select value={manualIdentityUrl} onChange={(event) => setManualIdentityUrl(event.target.value)}><option value="">Select a proposed site</option>{sources.filter((item) => item.lead_id === leadId && item.proposed_website_url).map((item) => <option key={item.id} value={item.proposed_website_url!}>{item.proposed_website_url}</option>)}</select></label>
            <label>Exact on-site observation naming the business<textarea value={manualIdentityClaim} onChange={(event) => setManualIdentityClaim(event.target.value)} minLength={25} maxLength={300} rows={2}/></label>
            <label>How you checked identity<textarea value={manualIdentityNote} onChange={(event) => setManualIdentityNote(event.target.value)} minLength={20} maxLength={500} rows={2}/></label>
            <button className="secondary" disabled={busy || !manualIdentityUrl || manualIdentityClaim.trim().length < 25 || manualIdentityNote.trim().length < 20} onClick={() => void recordManualIdentity()}>Save checked identity observation</button>
          </div>}
          <label>Reviewed source<select value={officialEvidenceId} onChange={(event) => { setOfficialEvidenceId(event.target.value); setOfficialUrl(eligibleEvidence.find((item) => item.id === event.target.value)?.source_url ?? ""); }}><option value="">Select an identity source</option>{eligibleEvidence.filter((item) => ["serper", "harvey", "serper_website", "tavily_website", "manual_identity"].includes(item.source_type)).map((item) => <option key={item.id} value={item.id}>{item.claim.slice(0, 90)}</option>)}</select></label>
          <label>Official website URL<input type="url" value={officialUrl} onChange={(event) => setOfficialUrl(event.target.value)} placeholder="https://business.example.org/"/></label>
          <label>Identity review reason<textarea value={officialReason} onChange={(event) => setOfficialReason(event.target.value)} minLength={20} maxLength={500} rows={2}/></label>
          <button className="secondary" disabled={busy || !officialEvidenceId || !officialUrl || officialReason.trim().length < 20} onClick={() => void confirmOfficialWebsite()}>Confirm official site</button>
        </details>}
        <details><summary>Record a manual website assessment</summary>
          <p className="muted">Use observations you personally checked. Broken means two confirmed failures at least 24 hours apart, with redirects checked. Anti-bot or temporary network errors do not establish a broken site.</p>
          {websiteStatus === "NO_OFFICIAL_WEBSITE_DISCOVERED" && <div className="verification-record">
            <strong>Positive evidence required for a new-website offer</strong>
            <p className="muted">Two search misses cannot confirm that the business lacks a site. Record an explicit public statement from the business, then select it under Reviewed evidence above. Without it, qualification stays research needed.</p>
            <label>Public statement URL<input type="url" value={businessStatementUrl} onChange={(event) => setBusinessStatementUrl(event.target.value)} maxLength={500}/></label>
            <label>Exact business statement about its website<textarea value={businessStatementQuote} onChange={(event) => setBusinessStatementQuote(event.target.value)} minLength={25} maxLength={300} rows={2}/></label>
            <label>How you confirmed the statement belongs to this business<textarea value={businessStatementNote} onChange={(event) => setBusinessStatementNote(event.target.value)} minLength={20} maxLength={500} rows={2}/></label>
            <button className="secondary" disabled={busy || !businessStatementUrl || businessStatementQuote.trim().length < 25 || businessStatementNote.trim().length < 20} onClick={() => void recordBusinessStatement()}>Save reviewed business statement</button>
          </div>}
          <div className="research-controls">
            <label>Website status<select value={websiteStatus} onChange={(event) => setWebsiteStatus(event.target.value)}><option value="UNKNOWN">Unknown</option><option value="NO_OFFICIAL_WEBSITE_DISCOVERED">No official website discovered</option><option value="WORKING">Working</option><option value="PERSISTENTLY_BROKEN">Persistently broken</option><option value="VERIFIED_TECHNICAL_PROBLEM">Verified technical problem</option></select></label>
            <label>Reason<textarea value={websiteReason} onChange={(event) => setWebsiteReason(event.target.value)} rows={3} maxLength={1000}/></label>
            <label>Confidence<input type="number" min="0" max="1" step="0.05" value={websiteConfidence} onChange={(event) => setWebsiteConfidence(Number(event.target.value))}/></label>
            <label><input type="checkbox" checked={redirectChecked} onChange={(event) => setRedirectChecked(event.target.checked)}/> I checked redirects for both observations</label>
            {[1, 2].map((number) => <div key={number} className="verification-record">
              <strong>Check {number}</strong>
              <label>Checked URL or search source<input type="url" value={number === 1 ? check1Url : check2Url} onChange={(event) => number === 1 ? setCheck1Url(event.target.value) : setCheck2Url(event.target.value)}/></label>
              <label>Observed at<input type="datetime-local" value={number === 1 ? check1At : check2At} onChange={(event) => number === 1 ? setCheck1At(event.target.value) : setCheck2At(event.target.value)}/></label>
              <label>Outcome<select value={number === 1 ? check1Outcome : check2Outcome} onChange={(event) => number === 1 ? setCheck1Outcome(event.target.value) : setCheck2Outcome(event.target.value)}><option value="ok">Working</option><option value="not_found">No official result found</option><option value="http_5xx">Server error</option><option value="dns_failure">DNS failure</option><option value="tls_failure">TLS failure</option><option value="connection_failure">Connection failure</option><option value="verified_issue">Verified technical issue</option></select></label>
            </div>)}
            <button className="secondary" disabled={busy || websiteReason.trim().length < 15 || (websiteStatus === "PERSISTENTLY_BROKEN" && !redirectChecked)} onClick={() => void recordWebsite()}>Save reviewed website status</button>
          </div>
        </details>
        <div className="research-controls">
          <label>Service<select value={serviceId} onChange={(event) => setServiceId(event.target.value)}><option value="">Select a service</option>{services.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
          <label>Assessment<select value={matchStatus} onChange={(event) => setMatchStatus(event.target.value as typeof matchStatus)}><option value="research_needed">Research needed</option><option value="verified_gap">Verified gap</option><option value="rejected">Rejected</option></select></label>
          <label>Why this service fits or fails<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000}/></label>
          <label>Evidence confidence<input type="number" min="0" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(Number(event.target.value))}/></label>
          <button className="secondary" disabled={busy || !serviceId || reason.trim().length < 10 || (matchStatus === "verified_gap" && selectedEvidence.length === 0)} onClick={() => void recordMatch()}>Record service assessment</button>
          <button className="primary" disabled={busy} onClick={() => void evaluate()}>Evaluate qualification</button>
        </div>
        <h3>Service decision history</h3>{matches.filter((item) => item.lead_id === leadId).map((item) => <p key={item.id} className="muted">{services.find((service) => service.id === item.service_id)?.name ?? "Service"} · {item.status.replaceAll("_", " ")} · {item.reason} · {new Date(item.assessed_at).toLocaleDateString()}</p>)}
      </>}
    </>}
  </section>;
}
