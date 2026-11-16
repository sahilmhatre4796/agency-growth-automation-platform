"use client";
import { useEffect, useMemo, useState } from "react";
import { Pause, Copy, Download, Link2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { crmStore, type RecordLead } from "../lib/crm-store";
import { GmailAnalytics } from "./gmail-analytics";
type Metrics = {
  total_leads: number;
  new_leads: number;
  qualified: number;
  won: number;
  revenue_paise: number;
  meetings_held: number;
  drafts: number;
  confirmed_outbound_events: number;
};
type Job = {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
};
type Notification = {
  id: string;
  title: string;
  kind: string;
  acknowledged_at: string | null;
  created_at: string;
};
export function Operations({
  mode,
  demo,
  orgId,
  role,
}: {
  mode:
    "Analytics" | "Automation" | "LinkedIn Assistant" | "Calendar" | "Discover";
  demo: boolean;
  orgId: string;
  role: string;
}) {
  const store = useMemo(() => crmStore(demo, orgId), [demo, orgId]);
  const [leads, setLeads] = useState<RecordLead[]>([]),
    [metrics, setMetrics] = useState<Metrics | null>(null),
    [jobs, setJobs] = useState<Job[]>([]),
    [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [leadId, setLeadId] = useState(""),
    [copy, setCopy] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const rows = await store.list();
        if (!alive) return;
        setLeads(rows);
        if (demo) {
          setMetrics({
            total_leads: rows.length,
            new_leads: rows.filter((l) => l.status === "new").length,
            qualified: rows.filter((l) => l.status === "qualified").length,
            won: rows.filter((l) => l.status === "won").length,
            revenue_paise: rows
              .filter((l) => l.status === "won")
              .reduce((sum, l) => sum + (l.deal_value_paise ?? 0), 0),
            meetings_held: 0,
            drafts: JSON.parse(
              localStorage.getItem("chaincraft-synthetic-drafts-v1") ?? "[]",
            ).length,
            confirmed_outbound_events: 0,
          });
        } else {
          if (!supabase) throw new Error();
          const [metric, jobs, alerts] = await Promise.all([
            supabase.rpc("workspace_metrics", { p_org: orgId }),
            supabase
              .from("jobs")
              .select("id,kind,state,attempts,last_error_code")
              .eq("org_id", orgId)
              .order("created_at", { ascending: false })
              .limit(100),
            supabase
              .from("notifications")
              .select("*")
              .eq("org_id", orgId)
              .order("created_at", { ascending: false })
              .limit(100),
          ]);
          if (metric.error || alerts.error || (role === "admin" && jobs.error))
            throw new Error();
          if (alive) {
            setMetrics(metric.data);
            setJobs(jobs.data ?? []);
            setNotifications(alerts.data ?? []);
          }
        }
      } catch {
        if (alive)
          setError(
            "Stored workspace records are unavailable. No activity has been inferred.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [demo, orgId, role, store]);
  async function pause() {
    setBusy(true);
    setError("");
    try {
      if (!demo) {
        const { error } = await supabase!.rpc("pause_outbound", {
          p_org: orgId,
        });
        if (error) throw new Error();
      }
      setNotice(
        demo
          ? "Demo workspace is paused. External operations are unavailable."
          : "Outbound paused in the database. Pending external jobs suppressed.",
      );
    } catch {
      setError(
        "Pause could not be persisted. External operations remain disabled in this build.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function exportCSV() {
    setError("");
    try {
      if (!demo) {
        const { error } = await supabase!.rpc("record_export", {
          p_org: orgId,
          p_count: leads.length,
        });
        if (error) throw new Error("Export audit unavailable");
      }
      const cell = (v: unknown) => {
        let text = String(v ?? "");
        if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      };
      const csv = [
        "business_name,website_url,city,source_type,status,is_demo",
        ...leads.map((l) =>
          [
            l.business_name,
            l.website_url,
            l.city,
            l.source_type,
            l.status,
            demo,
          ]
            .map(cell)
            .join(","),
        ),
      ].join("\r\n");
      const url = URL.createObjectURL(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = demo
        ? "chaincraft-demo-leads.csv"
        : "chaincraft-leads.csv";
      link.click();
      URL.revokeObjectURL(url);
      setNotice(
        "Exported loaded lead records. CSV formula characters escaped.",
      );
    } catch {
      setError("Export could not be audited. No file was generated.");
    }
  }
  if (loading)
    return (
      <section className="panel" role="status">
        Loading stored workspace records…
      </section>
    );
  return (
    <>
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
      {mode === "Analytics" ? (
        <>
          <div className="panel-heading">
            <span className="muted">
              {demo
                ? "Demonstration records only"
                : "Database totals · Demo records excluded"}
            </span>
            <button
              className="secondary"
              disabled={!demo && role !== "admin"}
              onClick={() => void exportCSV()}
            >
              <Download size={15} />
              Export leads
            </button>
          </div>
          <div className="metrics">
            {metrics &&
              Object.entries(metrics).map(([key, value]) => (
                <article className="metric" key={key}>
                  <div>{key.replaceAll("_", " ")}</div>
                  <strong>
                    {key === "revenue_paise"
                      ? new Intl.NumberFormat("en-IN", {
                          style: "currency",
                          currency: "INR",
                          maximumFractionDigits: 0,
                        }).format(value / 100)
                      : value}
                  </strong>
                  <small>From stored {demo ? "demo " : " "}records</small>
                </article>
              ))}
          </div>
          <section className="panel">
            <h2>Lead source distribution</h2>
            {Object.entries(
              leads.reduce<Record<string, number>>((acc, l) => {
                acc[l.source_type] = (acc[l.source_type] ?? 0) + 1;
                return acc;
              }, {}),
            ).map(([source, count]) => (
              <div className="setting-row" key={source}>
                <span>{source}</span>
                <strong>{count}</strong>
              </div>
            ))}
            <p className="muted">
              Source distribution covers the loaded directory, up to 1,000
              leads. No growth, attribution or campaign-conversion claims are
              inferred.
            </p>
          </section>
          <GmailAnalytics demo={demo} orgId={orgId} role={role} />
        </>
      ) : mode === "Automation" ? (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Outbound control</h2>
                <p>
                  All external channels are disabled. Pause is persisted for
                  connected workspaces.
                </p>
              </div>
              <button
                className="primary"
                disabled={busy || (!demo && role !== "admin")}
                onClick={() => void pause()}
              >
                <Pause size={16} />
                Pause outbound
              </button>
            </div>
            <span className="status">
              Email OFF · WhatsApp OFF · Calendar invitations OFF · Calling OFF
            </span>
          </section>
          <div className="bottom-grid">
            <section className="panel">
              <h2>Notifications</h2>
              {notifications.length ? (
                notifications.map((n) => (
                  <div className="evidence" key={n.id}>
                    <h3>{n.title}</h3>
                    <small>{new Date(n.created_at).toLocaleString()}</small>
                    {!n.acknowledged_at ? (
                      <button
                        className="text-button"
                        onClick={async () => {
                          const { error } = await supabase!.rpc(
                            "acknowledge_notification",
                            { p_org: orgId, p_id: n.id },
                          );
                          if (error) {
                            setError("Acknowledgment failed");
                            return;
                          }
                          setNotifications(
                            notifications.map((row) =>
                              row.id === n.id
                                ? {
                                    ...row,
                                    acknowledged_at: new Date().toISOString(),
                                  }
                                : row,
                            ),
                          );
                        }}
                      >
                        Acknowledge
                      </button>
                    ) : (
                      <span className="status">Acknowledged</span>
                    )}
                  </div>
                ))
              ) : (
                <p>No notifications recorded.</p>
              )}
            </section>
            <section className="panel">
              <h2>Durable job history</h2>
              {jobs.length ? (
                jobs.map((j) => (
                  <div className="evidence" key={j.id}>
                    <h3>{j.kind}</h3>
                    <small>
                      {j.state} · {j.attempts} attempts ·{" "}
                      {j.last_error_code || "No error recorded"}
                    </small>
                  </div>
                ))
              ) : (
                <p>No jobs recorded. No live scheduler is configured.</p>
              )}
              <p className="muted">
                Scheduler execution and provider retry controls remain
                unavailable until server integration checks pass.
              </p>
            </section>
          </div>
        </>
      ) : mode === "LinkedIn Assistant" ? (
        <section className="panel crm">
          <div className="panel-heading">
            <h2>
              <Link2 size={18} />
              Manual relationship assistant
            </h2>
            <span className="status">No platform automation</span>
          </div>
          <p>
            You conduct research and send messages manually in LinkedIn. Record
            only details you are permitted to keep.
          </p>
          <label>
            CRM business
            <select
              aria-label="LinkedIn business"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
            >
              <option value="">Select business</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.business_name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={!leadId}
            onClick={() =>
              setCopy(
                "Hello, I’m from ChainCraft Studio. We work on websites and e-commerce. Would you be open to a conversation about whether we could help? No worries if this is not relevant.",
              )
            }
          >
            Prepare suggested copy
          </button>
          <label htmlFor="linkedin-copy">
            Editable message / research notes
          </label>
          <textarea
            id="linkedin-copy"
            value={copy}
            onChange={(e) => setCopy(e.target.value)}
            rows={6}
            maxLength={5000}
          />
          <div className="button-row">
            <button
              className="secondary"
              disabled={!copy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(copy);
                  setNotice("Copied. Send manually only where permitted.");
                } catch {
                  setError(
                    "Clipboard unavailable. Select and copy the text manually.",
                  );
                }
              }}
            >
              <Copy size={15} />
              Copy
            </button>
            <button
              className="primary"
              disabled={!leadId || !copy || busy || (!demo && role !== "admin")}
              onClick={async () => {
                setBusy(true);
                try {
                  await store.note(
                    leadId,
                    "LinkedIn manual research / draft (not sent by this app):\n" +
                      copy,
                  );
                  setNotice("Saved to the CRM timeline. No message was sent.");
                } catch {
                  setError("CRM note could not be saved");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save to CRM
            </button>
            <button
              className="secondary"
              disabled={!leadId || busy || (!demo && role !== "admin")}
              onClick={async () => {
                try {
                  await store.task(
                    leadId,
                    "Review LinkedIn follow-up manually",
                    new Date(Date.now() + 3 * 86400000).toISOString(),
                  );
                  setNotice("Follow-up reminder saved to this lead’s tasks.");
                } catch {
                  setError("Task could not be saved");
                }
              }}
            >
              Add follow-up reminder
            </button>
          </div>
        </section>
      ) : mode === "Discover" ? (
        <section className="panel">
          <h2>Start with a permitted source.</h2>
          <p>
            Use owned inbound enquiries, referrals or an approved CSV export.
            Add source URLs and review facts in the lead directory.
          </p>
          <div className="setting-row">
            <span>CSV and manual imports</span>
            <span className="status">Available in Leads</span>
          </div>
          <div className="setting-row">
            <span>Pinned website audit worker</span>
            <span className="status">Not deployed</span>
          </div>
          <p className="muted">
            Owner-requested checks have a pinned Node transport and review queue.
            Direct-site access needs verified source permission and an approved
            separate worker environment. No live site has been checked here.
          </p>
        </section>
      ) : (
        <section className="panel">
          <h2>Calendar is not connected.</h2>
          <p>
            Availability and invitation creation require an authorized Google
            test account and provider verification. No available times or
            meetings have been invented.
          </p>
          <span className="status">
            Live invitations disabled · Not Verified
          </span>
        </section>
      )}
    </>
  );
}
