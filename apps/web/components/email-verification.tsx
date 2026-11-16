"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";

type Summary = { total_checked: number; valid: number; invalid: number; unknown: number; risky: number; suppressed: number; pending: number; errors: number; last_checked_at: string | null };
type RecordRow = { id: string; contact_id: string; email_normalized: string; status: string; evidence: Record<string, unknown>; provider: string; checked_at: string; expires_at: string; reviewed_at: string | null };
type Contact = { id: string; lead_id: string; email_normalized: string | null };
type Job = { id: string; contact_id: string; state: string; attempts: number; last_error_code: string | null; created_at: string };
const empty: Summary = { total_checked: 0, valid: 0, invalid: 0, unknown: 0, risky: 0, suppressed: 0, pending: 0, errors: 0, last_checked_at: null };

export function EmailVerification({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [summary, setSummary] = useState<Summary>(empty);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [contactId, setContactId] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    if (demo || !supabase || !orgId || role !== "admin") return;
    const [metric, history, people, pending] = await Promise.all([
      supabase.rpc("email_verification_summary", { p_org: orgId }),
      supabase.from("email_verification_records").select("id,contact_id,email_normalized,status,evidence,provider,checked_at,expires_at,reviewed_at").eq("org_id", orgId).order("checked_at", { ascending: false }).limit(200),
      supabase.from("contacts").select("id,lead_id,email_normalized").eq("org_id", orgId).not("email_normalized", "is", null).order("created_at", { ascending: false }).limit(1000),
      supabase.from("email_verification_jobs").select("id,contact_id,state,attempts,last_error_code,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(100),
    ]);
    if (metric.error || history.error || people.error || pending.error) throw new Error("Stored verification data is unavailable");
    setSummary((metric.data ?? empty) as Summary);
    setRecords((history.data ?? []) as RecordRow[]);
    setContacts((people.data ?? []) as Contact[]);
    setJobs((pending.data ?? []) as Job[]);
    setAsOf(Date.now());
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  const latest = useMemo(() => {
    const byContact = new Map<string, RecordRow>();
    for (const record of records) if (!byContact.has(record.contact_id)) byContact.set(record.contact_id, record);
    return byContact;
  }, [records]);
  const activeJobs = new Set(jobs.filter((job) => job.state === "queued" || job.state === "leased").map((job) => job.contact_id));
  const eligibleBulk = contacts.filter((contact) => {
    if (activeJobs.has(contact.id)) return false;
    const record = latest.get(contact.id);
    return !record || Date.parse(record.expires_at) <= asOf;
  }).slice(0, 25);
  async function execute(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Verification operation failed"); }
    finally { setBusy(false); }
  }
  async function request(ids: string[], force: boolean) {
    if (!supabase || !ids.length) return;
    const client = supabase;
    await execute(async () => {
      const { data, error } = await client.functions.invoke("email-verification-request", {
        body: { org_id: orgId, contact_ids: ids, force },
      });
      if (error || data?.error) throw new Error(data?.error ?? "Verification request unavailable");
      const states = (data.results as Array<{ state: string }>).map((item) => item.state);
      setNotice(`${states.filter((state) => state === "queued").length} queued, ${states.filter((state) => state === "cached").length} reused from cache. Live DNS worker stays disabled until configured.`);
    });
  }
  async function review(record: RecordRow) {
    await execute(async () => {
      const { error } = await supabase!.rpc("review_email_verification", { p_org: orgId, p_contact: record.contact_id, p_record: record.id });
      if (error) throw new Error("Review was rejected. Refresh and inspect the latest evidence.");
      setNotice("Risk or unknown result reviewed for this contact and address. Consent and all send policy gates still apply.");
    });
  }
  const shown = records.filter((record) => filter === "all" || record.status === filter);
  return <div className="verification-workspace">
    <div className="safety-banner"><span><ShieldCheck size={16}/> Email checks show what was tested; valid does not guarantee mailbox existence, inbox delivery or consent.</span><span>{demo ? "Demo · no checks" : "Stored results"}</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="verification-metrics">
      {(["total_checked","valid","invalid","unknown","risky","suppressed","pending","errors"] as const).map((key) => <div className="metric" key={key}><div>{key.replaceAll("_", " ")}</div><strong>{summary[key]}</strong></div>)}
    </div>
    <section className="panel">
      <div className="panel-heading"><h2>Email verification</h2><span className="muted">Last checked {summary.last_checked_at ? new Date(summary.last_checked_at).toLocaleString() : "Never"}</span></div>
      {demo ? <p className="muted">The demonstration has no real contacts or verification requests. Sign in to review stored CRM contacts.</p> : role !== "admin" ? <p className="muted">An organization admin can request and review verification.</p> : <>
        <div className="verification-controls">
          <label>CRM contact <select value={contactId} onChange={(event) => setContactId(event.target.value)}><option value="">Select a contact</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.email_normalized} · {contact.id.slice(0,8)}</option>)}</select></label>
          <div className="button-row"><button className="primary" disabled={busy || !contactId || activeJobs.has(contactId)} onClick={() => void request([contactId], false)}>Verify contact</button><button className="secondary" disabled={busy || !contactId || activeJobs.has(contactId)} onClick={() => void request([contactId], true)}>Reverify</button><button className="secondary" disabled={busy || !eligibleBulk.length} onClick={() => void request(eligibleBulk.map((contact) => contact.id), false)}>Verify eligible batch ({eligibleBulk.length})</button><button className="secondary" disabled={busy} onClick={() => void execute(async () => { setNotice("Stored results refreshed."); })}>Refresh</button></div>
        </div>
        <p className="muted">At most 25 contacts per request and 100 new jobs per organization per day. Suppressed contacts are recorded as suppressed without DNS checks. Unknown and risky results require a separate human review.</p>
      </>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Verification history</h2><label>Status <select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All</option>{["valid","invalid","unknown","risky","suppressed"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label></div>
      {shown.length ? <div className="verification-history">{shown.map((record) => <article className="verification-record" key={record.id}>
        <div><strong>{record.email_normalized}</strong><span className="status">{record.status}</span></div>
        <small>CRM contact {record.contact_id} · {new Date(record.checked_at).toLocaleString()} · expires {new Date(record.expires_at).toLocaleString()} · {record.provider}</small>
        <details><summary>Detailed evidence</summary><pre>{JSON.stringify(record.evidence, null, 2)}</pre></details>
        {record.reviewed_at && <small>Reviewed {new Date(record.reviewed_at).toLocaleString()}</small>}
        {role === "admin" && ["risky","unknown"].includes(record.status) && !record.reviewed_at && Date.parse(record.expires_at)>asOf && latest.get(record.contact_id)?.id===record.id && <button className="secondary" disabled={busy} onClick={() => void review(record)}>Mark reviewed</button>}
      </article>)}</div> : <p className="muted">No stored verification results match this filter.</p>}
      {records.length === 200 && <p className="muted">Showing the newest 200 records; summary metrics include all current contacts.</p>}
    </section>
    <section className="panel"><h2>Recent jobs</h2>{jobs.length ? <div className="verification-history">{jobs.map((job) => <div className="verification-record" key={job.id}><strong>{job.state}</strong><small>Contact {job.contact_id} · attempts {job.attempts} · {new Date(job.created_at).toLocaleString()} {job.last_error_code ? `· ${job.last_error_code}` : ""}</small></div>)}</div> : <p className="muted">No verification jobs recorded.</p>}</section>
  </div>;
}
