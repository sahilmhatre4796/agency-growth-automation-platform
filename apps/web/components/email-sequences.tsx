"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Sent = { id: string; lead_id: string; contact_id: string; subject: string; sender_connection_id: string; provider_thread_id: string; updated_at: string };
type Draft = { id: string; lead_id: string; contact_id: string; subject: string; state: string };
type Enrollment = { id: string; state: string; contact_id: string; followups_sent: number; next_run_at: string | null };
type Step = { enrollment_id: string; step_number: number; draft_id: string; due_at: string; outbox_id: string | null };
export function EmailSequences({ orgId }: { orgId: string }) {
  const [sent, setSent] = useState<Sent[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [originalId, setOriginalId] = useState("");
  const [firstId, setFirstId] = useState("");
  const [firstAt, setFirstAt] = useState("");
  const [waitDays, setWaitDays] = useState<1 | 2>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    if (!supabase || !orgId) return;
    const [messages, content, current, planned, organization] = await Promise.all([
      supabase.from("email_outbox").select("id,lead_id,contact_id,subject,sender_connection_id,provider_thread_id,updated_at").eq("org_id", orgId).eq("state", "sent").order("updated_at", { ascending: false }).limit(100),
      supabase.from("outbound_drafts").select("id,lead_id,contact_id,subject,state").eq("org_id", orgId).eq("channel", "email").eq("state", "approved").order("updated_at", { ascending: false }).limit(200),
      supabase.from("sequence_enrollments").select("id,state,contact_id,followups_sent,next_run_at").eq("org_id", orgId).order("next_run_at", { ascending: true }).limit(100),
      supabase.from("email_sequence_steps").select("enrollment_id,step_number,draft_id,due_at,outbox_id").eq("org_id", orgId).limit(200),
      supabase.from("organizations").select("followup_wait_business_days").eq("id", orgId).single(),
    ]);
    if (messages.error || content.error || current.error || planned.error || organization.error) throw new Error("Stored sequence data is unavailable.");
    setSent((messages.data ?? []) as Sent[]);
    setDrafts((content.data ?? []) as Draft[]);
    setEnrollments((current.data ?? []) as Enrollment[]);
    setSteps((planned.data ?? []) as Step[]);
    setWaitDays(organization.data.followup_wait_business_days as 1 | 2);
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  const original = sent.find((item) => item.id === originalId);
  const eligible = drafts.filter((item) => item.lead_id === original?.lead_id && item.contact_id === original?.contact_id);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sequence operation failed."); }
    finally { setBusy(false); }
  }
  async function create() {
    await run(async () => {
      const { error } = await supabase!.rpc("create_email_sequence", {
        p_org: orgId, p_first_outbox: originalId, p_step1_draft: firstId,
        p_step1_at: new Date(firstAt).toISOString(),
        p_step2_draft: null, p_step2_at: null,
      });
      if (error) throw new Error("Plan rejected. Use one approved draft, the original sender and thread, a valid send window, and the full business-day wait.");
      setNotice("Sequence plan saved paused. No follow-up was queued.");
    });
  }
  async function changeWaitDays(days: 1 | 2) {
    await run(async () => {
      const { error } = await supabase!.rpc("set_followup_wait_days", { p_org: orgId, p_days: days });
      if (error) throw new Error("Follow-up wait could not be changed.");
      setNotice(`Follow-up wait set to ${days} business day${days === 1 ? "" : "s"}. Existing plans need separate review.`);
    });
  }
  async function change(id: string, state: "active" | "paused" | "cancelled") {
    await run(async () => {
      const { error } = await supabase!.rpc("set_email_sequence_state", { p_org: orgId, p_enrollment: id, p_state: state });
      if (error) throw new Error("Sequence state change blocked. Review the inbox, approvals, account settings and live-email policy.");
      setNotice(`Sequence ${state}. Worker execution still requires its separate server flag and schedule.`);
    });
  }
  return <section className="panel">
    <div className="panel-heading"><h2>Human-reviewed follow-up plans</h2><span className="status">Worker off by default</span></div>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <p className="muted">Only an existing sent Gmail conversation can anchor one approved follow-up. The original sender and thread stay fixed. New plans start paused; the worker remains off.</p>
    <div className="research-controls">
      <label>Required wait<select value={waitDays} disabled={busy} onChange={(event) => void changeWaitDays(Number(event.target.value) as 1 | 2)}><option value={2}>2 business days (default)</option><option value={1}>1 business day</option></select></label>
      <label>Sent conversation<select value={originalId} onChange={(event) => { setOriginalId(event.target.value); setFirstId(""); }}><option value="">Select a sent message</option>{sent.map((item) => <option key={item.id} value={item.id}>{item.subject} · {new Date(item.updated_at).toLocaleDateString()} · {item.id.slice(0, 8)}</option>)}</select></label>
      <label>Approved follow-up<select value={firstId} onChange={(event) => setFirstId(event.target.value)}><option value="">Select a draft</option>{eligible.map((item) => <option key={item.id} value={item.id}>{item.subject} · {item.id.slice(0, 8)}</option>)}</select></label>
      <label>Due time (after {waitDays} business day{waitDays === 1 ? "" : "s"})<input type="datetime-local" value={firstAt} onChange={(event) => setFirstAt(event.target.value)}/></label>
      <button className="primary" disabled={busy || !originalId || !firstId || !firstAt} onClick={() => void create()}>Save paused plan</button>
    </div>
    <h3>Existing plans</h3>{enrollments.length ? enrollments.map((item) => <article key={item.id} className="verification-record"><strong>{item.state} · {item.followups_sent} sent</strong><small>Contact {item.contact_id} · next {item.next_run_at ? new Date(item.next_run_at).toLocaleString() : "none"}</small><p>{steps.filter((step) => step.enrollment_id === item.id).sort((a,b) => a.step_number-b.step_number).map((step) => `Step ${step.step_number}: ${new Date(step.due_at).toLocaleString()}${step.outbox_id ? " · queued" : " · pending"}`).join(" / ")}</p><div className="button-row">{item.state === "paused" && <button className="secondary" disabled={busy} onClick={() => void change(item.id, "active")}>Activate after review</button>}{item.state === "active" && <button className="secondary" disabled={busy} onClick={() => void change(item.id, "paused")}>Pause</button>}{["active","paused"].includes(item.state) && <button className="secondary" disabled={busy} onClick={() => void change(item.id, "cancelled")}>Cancel</button>}</div></article>) : <p className="muted">No follow-up plans saved.</p>}
  </section>;
}
