"use client";
import { useEffect, useMemo, useState } from "react";
import { Mail, ShieldCheck, Sparkles } from "lucide-react";
import { supabase } from "../lib/supabase";
import { crmStore, type RecordLead } from "../lib/crm-store";
import { GmailCampaigns, type Campaign } from "./gmail-campaigns";
import { GmailInbox } from "./gmail-inbox";
import { EmailSequences } from "./email-sequences";
import {
  eligibleEvidence,
  renderGroundedDraft,
} from "../../../packages/shared/drafting";
type Draft = {
  id: string;
  campaign_id?: string | null;
  lead_id: string;
  subject: string;
  body: string;
  state: string;
  model_id: string;
  language: "en" | "hi" | "hinglish";
  evidence_ids: string[];
};
const demoKey = "chaincraft-synthetic-drafts-v1";
async function hash(subject: string, body: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(subject + "\n" + body),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function Email({
  demo,
  orgId,
  role,
}: {
  demo: boolean;
  orgId: string;
  role: string;
}) {
  const store = useMemo(() => crmStore(demo, orgId), [demo, orgId]);
  const [leads, setLeads] = useState<RecordLead[]>([]),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [leadId, setLeadId] = useState(""),
    [language, setLanguage] = useState<"en" | "hi" | "hinglish">("en");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [liveApproved, setLiveApproved] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [recipientTimezone, setRecipientTimezone] = useState("");
  const [timezoneReason, setTimezoneReason] = useState("");
  const [timezoneReviewed, setTimezoneReviewed] = useState(false);
  const [senderPreview, setSenderPreview] = useState("Select an approved campaign to preview the sender policy.");
  const canWrite = demo || role === "admin";
  const selectedId = selected?.id;
  const selectedCampaignId = selected?.campaign_id;
  const selectedLeadId = selected?.lead_id;
  useEffect(() => {
    if (demo || !supabase || !orgId || !selectedLeadId) return;
    let alive = true;
    supabase.from("leads").select("outreach_timezone,outreach_timezone_reason,outreach_timezone_reviewed_at")
      .eq("org_id", orgId).eq("id", selectedLeadId).single().then(({ data }) => {
        if (!alive) return;
        setRecipientTimezone(data?.outreach_timezone ?? "");
        setTimezoneReason(data?.outreach_timezone_reason ?? "");
        setTimezoneReviewed(Boolean(data?.outreach_timezone_reviewed_at));
      });
    return () => { alive = false; };
  }, [demo, orgId, selectedLeadId]);
  useEffect(() => {
    if (demo || !supabase || !orgId || !selectedId || !selectedCampaignId || !selectedLeadId) return;
    const client = supabase;
    let alive = true;
    Promise.all([
      client.from("email_outbox").select("sender_connection_id,state").eq("org_id", orgId).eq("draft_id", selectedId).maybeSingle(),
      client.from("campaign_sender_policies").select("mode,single_connection_id").eq("org_id", orgId).eq("campaign_id", selectedCampaignId).maybeSingle(),
      client.from("lead_sender_assignments").select("connection_id").eq("org_id", orgId).eq("campaign_id", selectedCampaignId).eq("lead_id", selectedLeadId).maybeSingle(),
      client.rpc("gmail_account_summary", { p_org: orgId }),
    ]).then(([queued, policy, assignment, accounts]) => {
      if (!alive) return;
      if (queued.error || policy.error || assignment.error || accounts.error) { setSenderPreview("Sender information unavailable."); return; }
      const fixed = queued.data?.sender_connection_id ?? (policy.data?.mode === "single" ? policy.data.single_connection_id : policy.data?.mode === "manual" ? assignment.data?.connection_id : null);
      const address = (accounts.data as Array<{ connection_id: string; address: string }> | null)?.find((account) => account.connection_id === fixed)?.address;
      setSenderPreview(fixed ? `${address ?? "Connected account"} · ${queued.data ? "pinned to queued message" : "configured sender; eligibility rechecked on queue"}` :
        policy.data ? `${policy.data.mode.replaceAll("_", " ")} · eligible account selected and pinned when queued` : "Select an approved campaign to preview the sender policy.");
    });
    return () => { alive = false; };
  }, [demo, orgId, selectedId, selectedCampaignId, selectedLeadId]);
  async function load() {
    if (demo) {
      setDrafts(JSON.parse(localStorage.getItem(demoKey) ?? "[]"));
      return;
    }
    if (!supabase || !orgId) throw new Error("Workspace not configured");
    const { data, error } = await supabase
      .from("outbound_drafts")
      .select("*")
      .eq("org_id", orgId)
      .eq("channel", "email")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error("Drafts unavailable");
    setDrafts(data ?? []);
  }
  useEffect(() => {
    let alive = true;
    store
      .list()
      .then((rows) => {
        if (alive) setLeads(rows);
      })
      .catch(() => {
        if (alive) setError("Unable to load leads");
      });
    if (demo) {
      const saved = JSON.parse(localStorage.getItem(demoKey) ?? "[]");
      Promise.resolve().then(() => {
        if (alive) setDrafts(saved);
      });
    } else if (supabase && orgId) {
      supabase.from("organizations").select("email_live_approved,outbound_paused")
        .eq("id", orgId).single().then(({ data }) => {
          if (alive) setLiveApproved(Boolean(data?.email_live_approved && !data?.outbound_paused));
        });
      supabase
        .from("outbound_drafts")
        .select("*")
        .eq("org_id", orgId)
        .eq("channel", "email")
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data, error }) => {
          if (alive) {
            if (error) setError("Drafts unavailable");
            else setDrafts(data ?? []);
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [demo, orgId, store]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  function persist(draft: Draft) {
    const existing = JSON.parse(
      localStorage.getItem(demoKey) ?? "[]",
    ) as Draft[];
    localStorage.setItem(
      demoKey,
      JSON.stringify([draft, ...existing.filter((d) => d.id !== draft.id)]),
    );
  }
  async function generate() {
    await run(async () => {
      if (!leadId) throw new Error("Select a lead first.");
      if (demo) {
        const detail = await store.detail(leadId);
        const evidence = eligibleEvidence(detail.evidence);
        const data = renderGroundedDraft(evidence, {
          evidence_ids: evidence.slice(0, 3).map((e) => e.id),
          language,
        });
        const draft: Draft = {
          id: crypto.randomUUID(),
          lead_id: leadId,
          subject: data.subject,
          body: data.body,
          language,
          state: "needs_review",
          model_id: "fake · no AI request",
          evidence_ids: data.evidence_ids_used,
        };
        persist(draft);
        setSelected(draft);
        setReviewed(false);
        setNotice(
          "Demonstration draft created. No AI API or mail provider was contacted.",
        );
      } else {
        if (!supabase) throw new Error("Not configured");
        const { data, error } = await supabase.functions.invoke(
          "draft-create",
          { body: { org_id: orgId, lead_id: leadId, language } },
        );
        if (error || data?.error)
          throw new Error(
            "AI drafting unavailable. Configure a verified provider and explicit free-tier quota; no message was sent.",
          );
        setNotice("Draft saved for human review. No message was sent.");
      }
    });
  }
  async function save() {
    if (!selected) return;
    await run(async () => {
      if (demo) persist({ ...selected, state: "needs_review" });
      else {
        const { error } = await supabase!.rpc("edit_draft", {
          p_org: orgId,
          p_draft: selected.id,
          p_subject: selected.subject,
          p_body: selected.body,
        });
        if (error)
          throw new Error(
            "Draft cannot be saved. Check permission or draft state.",
          );
      }
      setSelected({ ...selected, state: "needs_review" });
      setReviewed(false);
      setNotice("Saved. Any previous approval is invalidated.");
    });
  }
  async function review(approved: boolean) {
    if (!selected) return;
    await run(async () => {
      if (approved && !reviewed)
        throw new Error("Review all claims against the source evidence first.");
      if (demo) {
        const original = (
          JSON.parse(localStorage.getItem(demoKey) ?? "[]") as Draft[]
        ).find((d) => d.id === selected.id);
        if (
          !original ||
          original.body !== selected.body ||
          original.subject !== selected.subject
        )
          throw new Error("Save edits before reviewing.");
        persist({ ...selected, state: approved ? "approved" : "rejected" });
      } else {
        const { error } = await supabase!.rpc("review_draft", {
          p_org: orgId,
          p_draft: selected.id,
          p_approved: approved,
          p_claims_reviewed: reviewed,
          p_expected_hash: await hash(selected.subject, selected.body),
        });
        if (error)
          throw new Error(
            "Review blocked: save current edits, reload the draft and verify your role.",
          );
      }
      setSelected(null);
      setNotice(
        approved
          ? "Content approved. Live sending remains disabled."
          : "Draft rejected.",
      );
    });
  }
  async function assignCampaign(campaignId: string) {
    if (!selected || !campaignId) return;
    await run(async () => {
      const { error } = await supabase!.rpc("assign_draft_campaign", {
        p_org: orgId, p_draft: selected.id, p_campaign: campaignId,
      });
      if (error) throw new Error("Campaign assignment blocked. Draft may already be queued.");
      setSelected({ ...selected, campaign_id: campaignId, state: "needs_review" });
      setReviewed(false);
      setNotice("Campaign assigned. Review the final message and sender signature again.");
    });
  }
  async function queue() {
    if (!selected || !schedule) return;
    await run(async () => {
      const { data, error } = await supabase!.functions.invoke("gmail-queue", {
        body: { org_id: orgId, draft_id: selected.id, scheduled_at: new Date(schedule).toISOString() },
      });
      if (error || data?.error) throw new Error(data?.error ?? "Queue policy blocked this email");
      setSelected(null);
      setNotice("Approved email queued for its selected sender. Provider acceptance will appear in stored history.");
    });
  }
  async function reviewTimezone() {
    if (!selectedLeadId) return;
    await run(async () => {
      try { new Intl.DateTimeFormat("en", { timeZone: recipientTimezone }).format(new Date()); }
      catch { throw new Error("Enter a valid IANA time zone for the recipient's verified location."); }
      const { error } = await supabase!.rpc("review_lead_outreach_timezone", {
        p_org: orgId, p_lead: selectedLeadId, p_timezone: recipientTimezone, p_reason: timezoneReason,
      });
      if (error) throw new Error("Time zone review was not saved. Check the business location and review note.");
      setTimezoneReviewed(true);
      setNotice("Recipient time zone reviewed. Sending remains subject to every other approval and policy gate.");
    });
  }
  return (
    <>
      <div className="safety-banner">
        <span>
          <ShieldCheck size={16} />
          {liveApproved ? "Live email approval recorded · account and campaign policy still apply" : "Gmail live sending disabled · Connection status in Settings"}
        </span>
        <span>{liveApproved ? "Approval gated" : "Drafts only"}</span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="email-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <Mail size={18} /> Draft workspace
            </h2>
            <span className="status">
              {demo ? "Fake provider" : "AI Not Verified live"}
            </span>
          </div>
          <label>
            Lead
            <select
              aria-label="Draft lead"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
            >
              <option value="">Select a business</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.business_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language
            <select
              aria-label="Draft language"
              value={language}
              onChange={(e) => setLanguage(e.target.value as typeof language)}
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="hinglish">Hinglish</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={!canWrite || busy || !leadId}
            onClick={() => void generate()}
          >
            <Sparkles size={15} />
            {demo ? "Create grounded demo draft" : "Generate draft"}
          </button>
          <p className="muted">
            Only reviewed, recent evidence can be cited. Customer contact
            details never reach the AI selection model. No sending takes place.
          </p>
          <div className="draft-list">
            {drafts.length ? (
              drafts.map((d) => (
                <button
                  key={d.id}
                  className="draft-item"
                  onClick={() => {
                    setSelected(d);
                    setTimezoneReviewed(false);
                    setReviewed(false);
                    setNotice("");
                  }}
                >
                  <span>
                    {d.subject}
                    <small>
                      {leads.find((l) => l.id === d.lead_id)?.business_name ??
                        "Business record"}{" "}
                      · {d.model_id || "Manual"}
                    </small>
                  </span>
                  <span className="status">{d.state}</span>
                </button>
              ))
            ) : (
              <p>No drafts saved yet.</p>
            )}
          </div>
        </section>
        <section className="panel">
          {selected ? (
            <>
              <div className="panel-heading">
                <h2>Review the conversation starter</h2>
                <span className="status">{selected.state}</span>
              </div>
              <label htmlFor="draft-subject">Subject</label>
              {!demo && role === "admin" && <label>Campaign
                <select value={selected.campaign_id ?? ""} onChange={(e) => void assignCampaign(e.target.value)} disabled={busy || selected.state === "queued"}>
                  <option value="">Select an approved-purpose campaign</option>
                  {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name} · {campaign.state}</option>)}
                </select>
              </label>}
              {!demo && <p className="muted">Gmail sender: {selected.campaign_id ? senderPreview : "Select an approved campaign to preview the sender policy."}</p>}
              {!demo && role === "admin" && <div className="gmail-control-grid">
                <label>Recipient IANA time zone<input aria-label="Recipient time zone" placeholder="America/New_York" value={recipientTimezone} onChange={(e) => { setRecipientTimezone(e.target.value); setTimezoneReviewed(false); }}/></label>
                <label>Location evidence / review note<input aria-label="Time zone review reason" value={timezoneReason} onChange={(e) => { setTimezoneReason(e.target.value); setTimezoneReviewed(false); }}/></label>
                <button className="secondary" disabled={busy || !recipientTimezone || timezoneReason.trim().length < 10} onClick={() => void reviewTimezone()}>Review recipient time zone</button>
                <small>{timezoneReviewed ? `Reviewed: ${recipientTimezone}` : "Recipient time zone needs review before dispatch."}</small>
              </div>}
              <input
                id="draft-subject"
                value={selected.subject}
                maxLength={160}
                onChange={(e) => {
                  setSelected({ ...selected, subject: e.target.value });
                  setReviewed(false);
                }}
                disabled={!canWrite}
              />
              <label htmlFor="draft-body">Editable draft</label>
              <textarea
                id="draft-body"
                rows={15}
                value={selected.body}
                maxLength={3000}
                onChange={(e) => {
                  setSelected({ ...selected, body: e.target.value });
                  setReviewed(false);
                }}
                disabled={!canWrite}
              />
              <p className="muted">
                Source evidence IDs:{" "}
                {selected.evidence_ids.join(", ") ||
                  "None — generic introduction only"}
                . Open the lead record to review provenance. Edited factual
                claims require your verification.
              </p>
              {!demo && <p className="muted">Confirm the campaign purpose, sender identity, prior communication and signature in the final copy before approval. A sender-specific signature must be present in the reviewed body.</p>}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I verified every factual claim and reviewed the final copy.
              </label>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy || !canWrite}
                  onClick={() => void save()}
                >
                  Save edits
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !canWrite ||
                    !reviewed ||
                    !["draft", "needs_review"].includes(selected.state)
                  }
                  onClick={() => void review(true)}
                >
                  Approve content
                </button>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !canWrite ||
                    !["draft", "needs_review"].includes(selected.state)
                  }
                  onClick={() => void review(false)}
                >
                  Reject
                </button>
              </div>
              {!demo && selected.state === "approved" && <div className="gmail-control-grid">
                <label>Schedule approved email<input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)}/></label>
                <button className="primary" disabled={busy || !liveApproved || !selected.campaign_id || !schedule || !timezoneReviewed} onClick={() => void queue()}>Queue approved email</button>
                {!liveApproved && <small>Organization live-email approval is required before queueing.</small>}
                <small>The date/time field uses your device time zone. Dispatch waits for the recipient's reviewed local Monday–Friday, 9:00–17:00 window.</small>
              </div>}
              <p className="muted">
                Approval records content only. Consent, account health, quota,
                and campaign policy are checked separately before any future
                send.
              </p>
            </>
          ) : (
            <div className="empty">
              <h2>A considered first impression.</h2>
              <p>
                Select a saved draft to edit and review.
                <br />
                Nothing leaves this workspace automatically.
              </p>
            </div>
          )}
        </section>
      </div>
      {!demo && role === "admin" && <GmailCampaigns orgId={orgId} leads={leads} onCampaigns={setCampaigns}/>}
      {!demo && role === "admin" && <EmailSequences orgId={orgId}/>}
      <GmailInbox demo={demo} orgId={orgId} role={role}/>
    </>
  );
}
