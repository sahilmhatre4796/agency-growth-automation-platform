"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Account = {
  connection_id: string; address: string; sender_name: string; signature: string;
  connection_state: string; verified_at: string | null; scopes: string[];
  send_enabled: boolean; paused: boolean; daily_cap: number; monthly_cap: number;
  cooldown_minutes: number;
  timezone: string; window_start: string; window_end: string;
  sent_today: number; sent_month: number; replies: number; failed_sends: number;
  assigned_campaigns: number; last_sync_at: string | null; last_error_code: string | null;
};
type Connection = { provider: string; state: string; verified_at: string | null };

export function Connections({ demo, orgId, role, controls = false }: {
  demo: boolean; orgId: string; role: string; controls?: boolean;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [others, setOthers] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (demo || !orgId || !supabase || role !== "admin") return;
    const [mail, connections, cooldowns] = await Promise.all([
      supabase.rpc("gmail_account_summary", { p_org: orgId }),
      supabase.from("external_connections").select("provider,state,verified_at").eq("org_id", orgId).neq("provider", "gmail"),
      supabase.from("gmail_account_settings").select("connection_id,cooldown_minutes").eq("org_id", orgId),
    ]);
    if (mail.error || connections.error || cooldowns.error) throw new Error("Connection metadata unavailable");
    const minutes = new Map((cooldowns.data ?? []).map((row) => [row.connection_id, row.cooldown_minutes]));
    setAccounts(((mail.data ?? []) as Account[]).map((row) => ({ ...row, cooldown_minutes: minutes.get(row.connection_id) ?? 10 })));
    setOthers(connections.data ?? []);
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await run(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Account operation failed"); }
    finally { setBusy(false); }
  }
  async function connect(profile: "mail" | "calendar", reconnect?: string) {
    await action(async () => {
      const { data, error } = await supabase!.functions.invoke("google-oauth", {
        body: { org_id: orgId, profile, ...(reconnect ? { reconnect_connection_id: reconnect } : {}) },
      });
      if (error || data?.error) throw new Error(data?.error ?? "Google sandbox OAuth unavailable");
      const destination = new URL(data.authorization_url);
      if (destination.origin !== "https://accounts.google.com") throw new Error("Unexpected OAuth destination");
      window.location.assign(destination.toString());
    });
  }
  async function save() {
    if (!editing) return;
    await action(async () => {
      const { error } = await supabase!.rpc("configure_gmail_account", {
        p_org: orgId, p_connection: editing.connection_id, p_sender_name: editing.sender_name,
        p_signature: editing.signature, p_timezone: editing.timezone,
        p_daily_cap: Number(editing.daily_cap), p_monthly_cap: Number(editing.monthly_cap),
        p_window_start: editing.window_start, p_window_end: editing.window_end,
        p_enabled: editing.send_enabled, p_paused: editing.paused,
      });
      if (error) throw new Error("Settings rejected. Check account state, limits and time zone.");
      setEditing(null); setNotice("Account settings saved. Organization approval still gates live sending.");
    });
  }
  async function pause(account: Account, paused: boolean) {
    await action(async () => {
      const { error } = await supabase!.rpc("pause_gmail_account", {
        p_org: orgId, p_connection: account.connection_id, p_paused: paused,
      });
      if (error) throw new Error("Could not update account pause state");
    });
  }
  async function saveCooldown() {
    if (!editing) return;
    await action(async () => {
      const { error } = await supabase!.rpc("configure_gmail_cooldown", {
        p_org: orgId, p_connection: editing.connection_id, p_minutes: Number(editing.cooldown_minutes),
      });
      if (error) throw new Error("Cooldown must be between 10 and 1440 minutes.");
      setEditing(null); setNotice("Account cooldown saved. Sending remains separately gated.");
    });
  }
  async function disconnect(account: Account) {
    await action(async () => {
      const { error } = await supabase!.rpc("disconnect_gmail_account", {
        p_org: orgId, p_connection: account.connection_id,
      });
      if (error) throw new Error("Could not disconnect account");
      setNotice("Connection disabled and stored OAuth token removed. Pending sends are held.");
    });
  }
  const active = accounts.filter((a) => a.connection_state === "connected").length;
  return <>
    <div className="integration-row"><span><span className="provider-icon">G</span><span>Gmail accounts<small>{demo ? "Demonstration · no connected accounts" : `${active} connected of 10 allowed`}</small></span></span><span className="status">{active}/10</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {accounts.map((account) => <div className="gmail-account" key={account.connection_id}>
      <div className="integration-row"><span><span className="provider-icon">@</span><span>{account.address}<small>{account.connection_state} · {account.paused ? "paused" : account.send_enabled ? "enabled by account" : "send off"} · {account.last_error_code ?? "no error recorded"}</small></span></span><span className="status">{account.connection_state}</span></div>
      <small>Sender: {account.sender_name} · OAuth verified: {account.verified_at ? new Date(account.verified_at).toLocaleString() : "Never"} · Permissions: {account.scopes.includes("https://www.googleapis.com/auth/gmail.send") ? "send" : "send missing"}, {account.scopes.includes("https://www.googleapis.com/auth/gmail.readonly") ? "read" : "read missing"}</small>
      <small>Sent today {account.sent_today} · this month {account.sent_month} · replies {account.replies} · failed {account.failed_sends} · campaigns {account.assigned_campaigns}</small>
      <small>Last sync: {account.last_sync_at ? new Date(account.last_sync_at).toLocaleString() : "Never"} · Account cap {account.daily_cap}/day, {account.monthly_cap}/month · Minimum cooldown {account.cooldown_minutes} min {account.daily_cap > 0 && account.sent_today >= account.daily_cap * 0.8 ? "· Capacity warning" : ""}</small>
      {controls && <div className="button-row">
        <button className="secondary" disabled={busy} onClick={() => setEditing(account)}>Configure</button>
        <button className="secondary" disabled={busy || account.connection_state !== "connected"} onClick={() => void pause(account, !account.paused)}>{account.paused ? "Resume account" : "Pause account"}</button>
        <button className="secondary" disabled={busy} onClick={() => void connect("mail", account.connection_id)}>Reconnect</button>
        <button className="secondary" disabled={busy || account.connection_state === "disconnected"} onClick={() => void disconnect(account)}>Disconnect</button>
      </div>}
    </div>)}
    {controls && editing && <div className="panel gmail-account-editor">
      <h3>Configure {editing.address}</h3>
      <label>Sender name<input value={editing.sender_name} maxLength={120} onChange={(e) => setEditing({ ...editing, sender_name: e.target.value })}/></label>
      <label>Signature<textarea value={editing.signature} maxLength={1000} onChange={(e) => setEditing({ ...editing, signature: e.target.value })}/></label>
      <label>Time zone<input value={editing.timezone} onChange={(e) => setEditing({ ...editing, timezone: e.target.value })}/></label>
      <label>Send window start<input type="time" value={editing.window_start.slice(0,5)} onChange={(e) => setEditing({ ...editing, window_start: e.target.value })}/></label>
      <label>Send window end<input type="time" value={editing.window_end.slice(0,5)} onChange={(e) => setEditing({ ...editing, window_end: e.target.value })}/></label>
      <label>Daily cap<input type="number" min="0" max="500" value={editing.daily_cap} onChange={(e) => setEditing({ ...editing, daily_cap: Number(e.target.value) })}/></label>
      <label>Monthly cap<input type="number" min="0" max="10000" value={editing.monthly_cap} onChange={(e) => setEditing({ ...editing, monthly_cap: Number(e.target.value) })}/></label>
      <label>Minimum cooldown (minutes)<input type="number" min="10" max="1440" value={editing.cooldown_minutes} onChange={(e) => setEditing({ ...editing, cooldown_minutes: Number(e.target.value) })}/></label>
      <label className="checkbox"><input type="checkbox" checked={editing.send_enabled} onChange={(e) => setEditing({ ...editing, send_enabled: e.target.checked })}/>Allow this account for approved campaigns</label>
      <label className="checkbox"><input type="checkbox" checked={editing.paused} onChange={(e) => setEditing({ ...editing, paused: e.target.checked })}/>Paused</label>
      <div className="button-row"><button className="primary" disabled={busy} onClick={() => void save()}>Save account</button><button className="secondary" disabled={busy || editing.cooldown_minutes < 10 || editing.cooldown_minutes > 1440} onClick={() => void saveCooldown()}>Save cooldown</button><button className="secondary" onClick={() => setEditing(null)}>Cancel</button></div>
    </div>}
    {(["calendar", "whatsapp"] as const).map((provider) => {
      const record = others.find((row) => row.provider === provider);
      return <div className="integration-row" key={provider}><span><span className="provider-icon">{provider === "calendar" ? "C" : "W"}</span><span>{provider === "calendar" ? "Google Calendar" : "WhatsApp"}<small>{record?.verified_at ? `Read verified ${new Date(record.verified_at).toLocaleDateString()}` : "Not verified"}</small></span></span><span className="status">{record?.state ?? "Not connected"}</span></div>;
    })}
    {controls && <><p className="muted">Google OAuth is limited to configured sandbox accounts. Account configuration does not approve live email or start background sync.</p><div className="button-row"><button className="secondary" disabled={demo || role !== "admin" || busy || active >= 10} onClick={() => void connect("mail")}>Connect Gmail account</button><button className="secondary" disabled={demo || role !== "admin" || busy} onClick={() => void connect("calendar")}>Connect Calendar test account</button></div><p className="muted">WhatsApp setup awaits provider and number approvals.</p></>}
  </>;
}
