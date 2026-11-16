"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { RecordLead } from "../lib/crm-store";

export type Campaign = { id: string; name: string; purpose: string | null; state: string; daily_send_cap: number };
type Account = { connection_id: string; address: string; connection_state: string; send_enabled: boolean; paused: boolean };
type Mode = "single" | "selected" | "all_enabled" | "manual";

export function GmailCampaigns({ orgId, leads, onCampaigns }: {
  orgId: string; leads: RecordLead[]; onCampaigns?: (campaigns: Campaign[]) => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<Mode>("single");
  const [single, setSingle] = useState("");
  const [pool, setPool] = useState<string[]>([]);
  const [poolCap, setPoolCap] = useState(0);
  const [campaignCap, setCampaignCap] = useState(0);
  const [assignedLead, setAssignedLead] = useState("");
  const [assignedAccount, setAssignedAccount] = useState("");
  const [daily, setDaily] = useState(0);
  const [monthly, setMonthly] = useState(0);
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!supabase || !orgId) return;
    const [c, a, o] = await Promise.all([
      supabase.from("campaigns").select("id,name,purpose,state,daily_send_cap").eq("org_id", orgId).eq("channel", "email").order("created_at", { ascending: false }),
      supabase.rpc("gmail_account_summary", { p_org: orgId }),
      supabase.from("organizations").select("email_daily_cap,email_monthly_cap,email_timezone").eq("id", orgId).single(),
    ]);
    if (c.error || a.error || o.error) throw new Error("Email campaign settings unavailable");
    setCampaigns((c.data ?? []) as Campaign[]);
    onCampaigns?.((c.data ?? []) as Campaign[]);
    setAccounts((a.data ?? []) as Account[]);
    setDaily(o.data.email_daily_cap); setMonthly(o.data.email_monthly_cap); setTimezone(o.data.email_timezone);
  }, [orgId, onCampaigns]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  async function run(work: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(true);
    try { await work(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Campaign update failed"); }
    finally { setBusy(false); }
  }
  async function create() {
    await run(async () => {
      const { data, error } = await supabase!.rpc("create_email_campaign", {
        p_org: orgId, p_name: name, p_purpose: purpose,
      });
      if (error) throw new Error("Campaign name and permission purpose are required");
      setSelected(data as string); setName(""); setPurpose("");
      setNotice("Draft campaign created. Configure senders and review limits before activation.");
    });
  }
  async function choose(id: string) {
    setSelected(id); setError("");
    const current = campaigns.find((campaign) => campaign.id === id);
    setCampaignCap(current?.daily_send_cap ?? 0);
    if (!id) return;
    const [p, a] = await Promise.all([
      supabase!.from("campaign_sender_policies").select("mode,single_connection_id,account_daily_cap").eq("campaign_id", id).maybeSingle(),
      supabase!.from("campaign_sender_accounts").select("connection_id,daily_cap").eq("campaign_id", id),
    ]);
    if (p.error || a.error) { setError("Sender settings unavailable"); return; }
    setMode((p.data?.mode as Mode) ?? "single"); setSingle(p.data?.single_connection_id ?? "");
    setPool((a.data ?? []).map((row) => row.connection_id)); setPoolCap(p.data?.account_daily_cap ?? 0);
  }
  async function savePolicy() {
    await run(async () => {
      const { error } = await supabase!.rpc("configure_campaign_senders", {
        p_org: orgId, p_campaign: selected, p_mode: mode,
        p_single: mode === "single" ? single : null,
        p_pool: mode === "selected" ? pool : [], p_cap: poolCap,
      });
      if (error) throw new Error("Sender policy rejected. Pause an active campaign before changing it.");
      setNotice("Sender policy saved. No message was sent.");
    });
  }
  async function state(next: "active" | "paused") {
    await run(async () => {
      const { error } = await supabase!.rpc("set_email_campaign_state", {
        p_org: orgId, p_campaign: selected, p_state: next, p_daily_cap: campaignCap,
      });
      if (error) throw new Error(next === "active" ? "Activation requires separate organization live-email approval and a nonzero cap." : "Campaign pause failed");
      setNotice(`Campaign ${next}. Pending messages stay assigned to their original sender.`);
    });
  }
  async function saveOrg() {
    await run(async () => {
      const { error } = await supabase!.rpc("configure_email_org_limits", {
        p_org: orgId, p_daily: daily, p_monthly: monthly, p_timezone: timezone,
      });
      if (error) throw new Error("Organization limits rejected");
      setNotice("Organization limits saved. Live approval remains separate.");
    });
  }
  async function assign() {
    await run(async () => {
      const { error } = await supabase!.rpc("assign_lead_sender", {
        p_org: orgId, p_campaign: selected, p_lead: assignedLead, p_connection: assignedAccount,
      });
      if (error) throw new Error("Manual assignment rejected. Save manual sender mode first.");
      setNotice("Lead sender assigned. Existing conversations still keep their original mailbox.");
    });
  }
  const current = campaigns.find((campaign) => campaign.id === selected);
  return <section className="panel">
    <div className="panel-heading"><h2>Email campaigns and sender policy</h2><span className="status">{campaigns.length} stored</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <p className="muted">All accounts start paused with zero sending capacity. Account pools use eligibility and capacity; an existing conversation keeps its sender.</p>
    <div className="gmail-control-grid">
      <label>New campaign<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Campaign name"/></label>
      <label>Permission purpose<input value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} placeholder="Specific authorized purpose"/></label>
      <button className="secondary" disabled={busy || !name.trim() || !purpose.trim()} onClick={() => void create()}>Create draft campaign</button>
    </div>
    <label>Configure campaign<select value={selected} onChange={(e) => void choose(e.target.value)}><option value="">Select campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name} · {campaign.state}</option>)}</select></label>
    {current && <div className="gmail-control-grid">
      <p className="muted">Purpose: {current.purpose || "Not recorded"} · State: {current.state}</p>
      <label>Sender mode<select value={mode} onChange={(e) => setMode(e.target.value as Mode)}><option value="single">Single account</option><option value="selected">Selected accounts</option><option value="all_enabled">All enabled accounts</option><option value="manual">Manual lead assignment</option></select></label>
      {mode === "single" && <label>Sender<select value={single} onChange={(e) => setSingle(e.target.value)}><option value="">Choose account</option>{accounts.filter((a) => a.connection_state === "connected").map((a) => <option key={a.connection_id} value={a.connection_id}>{a.address}</option>)}</select></label>}
      {mode === "selected" && <div>Selected senders{accounts.filter((a) => a.connection_state === "connected").map((a) => <label className="checkbox" key={a.connection_id}><input type="checkbox" checked={pool.includes(a.connection_id)} onChange={(e) => setPool(e.target.checked ? [...pool, a.connection_id] : pool.filter((id) => id !== a.connection_id))}/>{a.address}</label>)}</div>}
      <label>Daily cap per campaign sender<input type="number" min="0" max="500" value={poolCap} onChange={(e) => setPoolCap(Number(e.target.value))}/></label>
      {mode === "manual" && <><p className="muted">Unassigned leads are blocked. Save manual mode before adding assignments.</p><label>Lead<select value={assignedLead} onChange={(e) => setAssignedLead(e.target.value)}><option value="">Choose lead</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.business_name}</option>)}</select></label><label>Sender<select value={assignedAccount} onChange={(e) => setAssignedAccount(e.target.value)}><option value="">Choose account</option>{accounts.filter((a) => a.connection_state === "connected").map((a) => <option key={a.connection_id} value={a.connection_id}>{a.address}</option>)}</select></label><button className="secondary" disabled={busy || !assignedLead || !assignedAccount} onClick={() => void assign()}>Assign lead sender</button></>}
      <button className="secondary" disabled={busy || current.state === "active" || poolCap <= 0 || (mode === "single" && !single) || (mode === "selected" && pool.length === 0)} onClick={() => void savePolicy()}>Save sender policy</button>
      <label>Campaign daily cap<input type="number" min="0" max="500" value={campaignCap} onChange={(e) => setCampaignCap(Number(e.target.value))}/></label>
      <div className="button-row"><button className="secondary" disabled={busy || current.state === "active"} onClick={() => void state("active")}>Activate after approval</button><button className="secondary" disabled={busy || current.state !== "active"} onClick={() => void state("paused")}>Pause campaign</button></div>
    </div>}
    <h3>Organization sending limits</h3>
    <div className="gmail-control-grid"><label>Daily cap<input type="number" min="0" max="500" value={daily} onChange={(e) => setDaily(Number(e.target.value))}/></label><label>Monthly cap<input type="number" min="0" max="10000" value={monthly} onChange={(e) => setMonthly(Number(e.target.value))}/></label><label>Time zone<input value={timezone} onChange={(e) => setTimezone(e.target.value)}/></label><button className="secondary" disabled={busy} onClick={() => void saveOrg()}>Save organization limits</button></div>
  </section>;
}
