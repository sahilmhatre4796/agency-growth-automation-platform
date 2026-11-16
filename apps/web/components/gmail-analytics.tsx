"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Account = { connection_id: string; address: string; sent_today: number; sent_month: number; replies: number; failed_sends: number; daily_cap: number; last_error_code: string | null };
type Campaign = { id: string; name: string; state: string; accepted: number; pending: number };
type Analytics = { provider_accepted: number; failed_attempts: number; replies: number; positive_responses: number; meeting_requests: number; qualified_linked_leads: number; confirmed_linked_appointments: number; campaigns: Campaign[] };
type Dispatch = { configured_daily_cap: number; absolute_daily_ceiling: number; reporting_timezone: string;
  sent_today: number; attempt_reservations_today: number; inflight: number; remaining_capacity: number;
  queued: number; held_or_uncertain: number; outbound_paused: boolean;
  accounts: Array<{ connection_id: string; paused: boolean; send_enabled: boolean; cooldown_until: string | null }> };
type Backlog = { approved_backlog: number; next_day_queued: number; future_queued: number };

export function GmailAnalytics({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [totals, setTotals] = useState<Analytics | null>(null);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [backlog, setBacklog] = useState<Backlog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo || role !== "admin" || !supabase || !orgId) return;
    let alive = true;
    void Promise.all([
      supabase.rpc("gmail_account_summary", { p_org: orgId }),
      supabase.rpc("gmail_analytics", { p_org: orgId }),
      supabase.rpc("gmail_dispatch_summary", { p_org: orgId }),
      supabase.rpc("gmail_backlog_summary", { p_org: orgId }),
    ]).then(([a, t, d, b]) => {
      if (!alive) return;
      if (a.error || t.error || d.error || b.error) { setError("Gmail analytics unavailable"); return; }
      setAccounts((a.data ?? []) as Account[]); setTotals(t.data as Analytics); setDispatch(d.data as Dispatch);
      setBacklog(b.data as Backlog);
    });
    return () => { alive = false; };
  }, [demo, orgId, role]);
  return <section className="panel">
    <div className="panel-heading"><h2>Gmail activity</h2><span className="status">Stored provider records</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {demo && <p>No Gmail activity exists in the demonstration workspace.</p>}
    {!demo && role !== "admin" && <p>Administrator access is required for mailbox analytics.</p>}
    {dispatch && <>
      <p>Dispatch is {dispatch.outbound_paused ? "paused" : "subject to account and recipient checks"}. Reporting day: {dispatch.reporting_timezone}. The 500-email ceiling is a maximum, never a target.</p>
      <div className="metrics">
        {([
          ["Provider accepted today", dispatch.sent_today], ["Attempt reservations today", dispatch.attempt_reservations_today],
          ["In flight", dispatch.inflight], ["Remaining configured capacity", dispatch.remaining_capacity],
          ["Queued", dispatch.queued], ["Held or uncertain", dispatch.held_or_uncertain],
          ["Approved drafts awaiting scheduling", backlog?.approved_backlog ?? 0],
          ["Queued for next day", backlog?.next_day_queued ?? 0],
        ] as const).map(([label, value]) => <article className="metric" key={label}><div>{label}</div><strong>{value}</strong><small>Stored records</small></article>)}
      </div>
    </>}
    {totals && <>
      <div className="metrics">
        {([
          ["Provider accepted", totals.provider_accepted], ["Failed or uncertain", totals.failed_attempts],
          ["Replies", totals.replies], ["Positive responses", totals.positive_responses],
          ["Meeting requests", totals.meeting_requests], ["Qualified linked leads", totals.qualified_linked_leads],
          ["Confirmed linked appointments", totals.confirmed_linked_appointments],
        ] as const).map(([label, value]) => <article className="metric" key={label}><div>{label}</div><strong>{value}</strong><small>Stored records</small></article>)}
      </div>
      <h3>By account</h3>
      {accounts.map((a) => { const schedule = dispatch?.accounts.find((item) => item.connection_id === a.connection_id); return <div className="setting-row" key={a.connection_id}><span>{a.address}<small>Today {a.sent_today} · month {a.sent_month} · replies {a.replies} · failed {a.failed_sends} · {a.daily_cap ? `${Math.round(a.sent_today / a.daily_cap * 100)}% of daily cap` : "zero cap"} · {schedule?.paused || !schedule?.send_enabled ? "Sending off" : schedule?.cooldown_until && new Date(schedule.cooldown_until)>new Date() ? `Cooldown until ${new Date(schedule.cooldown_until).toLocaleTimeString()}` : "Cooldown clear"}</small></span><strong>{a.last_error_code ?? (a.daily_cap && a.sent_today >= a.daily_cap * 0.8 ? "Capacity warning" : "No error")}</strong></div>; })}
      <h3>By campaign</h3>
      {totals.campaigns.map((c) => <div className="setting-row" key={c.id}><span>{c.name}<small>{c.state}</small></span><strong>{c.accepted} accepted · {c.pending} pending</strong></div>)}
      <p className="muted">Provider acceptance is not proof of delivery. Opens are not tracked. Linked lead and appointment counts do not establish email attribution.</p>
    </>}
  </section>;
}
