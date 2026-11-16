"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Command,
  FileText,
  LayoutDashboard,
  Link2,
  Mail,
  Menu,
  MessageCircle,
  Pause,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { CRM } from "../components/crm";
import { Email } from "../components/email";
import { EmailVerification } from "../components/email-verification";
import { BusinessResearch } from "../components/business-research";
import { VibeProspecting } from "../components/vibe-prospecting";
import { QualificationSettings } from "../components/qualification-settings";
import { QualificationReview } from "../components/qualification-review";
import { Operations } from "../components/operations";
import { WhatsApp } from "../components/whatsapp";
import { Connections } from "../components/connections";
import { crmStore } from "../lib/crm-store";
import { Campaigns } from "../components/campaigns";

const sections = [
  "Overview",
  "Leads",
  "Discover",
  "Campaigns",
  "Vibe Prospecting",
  "Email",
  "Email Verification",
  "Business Research",
  "WhatsApp",
  "LinkedIn Assistant",
  "Calendar",
  "Automation",
  "Analytics",
  "Settings",
] as const;
type Section = (typeof sections)[number];
const icons = [
  LayoutDashboard,
  Users,
  Search,
  Target,
  Sparkles,
  Mail,
  ShieldCheck,
  Search,
  MessageCircle,
  Link2,
  CalendarDays,
  Workflow,
  FileText,
  Settings,
];
type Lead = {
  id: string;
  business_name: string;
  source_type: string;
  status: string;
  is_demo: boolean;
  website_url?: string | null;
};
const fixtures: Lead[] = [
  {
    id: "demo-1",
    business_name: "Example Interiors",
    source_type: "manual",
    status: "new",
    is_demo: true,
    website_url: "https://example.com",
  },
  {
    id: "demo-2",
    business_name: "Sample Artisan Shop",
    source_type: "inbound",
    status: "qualified",
    is_demo: true,
    website_url: "https://example.org",
  },
];

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [demo, setDemo] = useState(() => !supabase);
  const [ready, setReady] = useState(!supabase);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("Overview");
  const [researchLeadId, setResearchLeadId] = useState("");
  const [mobile, setMobile] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState("");
  const [totals, setTotals] = useState<{
    qualified: number;
    won: number;
    meetings_held: number;
    drafts: number;
  } | null>(null);
  const [orgId, setOrgId] = useState("");
  const [workspaceUserId, setWorkspaceUserId] = useState("");
  const [workspaceState, setWorkspaceState] = useState<"loading" | "ready" | "membership-required" | "unavailable">("loading");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    // Try to restore a Supabase session with a hard timeout so an unreachable
    // Supabase (DNS failure, network down) does not leave the workspace stuck.
    // On any failure or absent session, fall back to the demonstration
    // workspace so the application remains usable without credentials.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!alive) return;
        clearTimeout(timeoutId);
        setSession(data.session);
        setReady(true);
        if (error || !data.session) {
          // No usable session: Supabase is unreachable or the user is not
          // signed in. Fall back to the demonstration workspace.
          setDemo(true);
          if (error) setError("Supabase is unreachable. Running in demonstration mode.");
        }
      })
      .catch(() => {
        if (!alive) return;
        clearTimeout(timeoutId);
        setDemo(true);
        setReady(true);
        setError("Supabase is unreachable. Running in demonstration mode.");
      });

    const { data } = supabase.auth.onAuthStateChange((_event, value) => {
      setLeads([]);
      setRole("");
      setOrgId("");
      setTotals(null);
      setWorkspaceUserId("");
      setWorkspaceState("loading");
      setSession(value);
    });
    return () => {
      alive = false;
      clearTimeout(timeoutId);
      data.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!session || !supabase) return;
    const client = supabase;
    const userId = session.user.id;
    let alive = true;
    async function loadWorkspace() {
      try {
        const membership = await client.from("memberships")
          .select("role,org_id").eq("user_id", userId).limit(2);
        if (!alive) return;
        if (membership.error) throw new Error("MEMBERSHIP_UNAVAILABLE");
        if (membership.data?.length !== 1) {
          setWorkspaceState("membership-required");
          return;
        }
        const member = membership.data[0];
        const [rows, metric] = await Promise.all([
          client.from("leads")
            .select("id,business_name,source_type,status,is_demo,website_url")
            .eq("org_id", member.org_id).eq("is_demo", false)
            .order("updated_at", { ascending: false }).limit(1000),
          client.rpc("workspace_metrics", { p_org: member.org_id }),
        ]);
        if (!alive) return;
        if (rows.error || metric.error) throw new Error("WORKSPACE_UNAVAILABLE");
        setLeads(rows.data ?? []);
        setTotals(metric.data);
        setRole(member.role);
        setOrgId(member.org_id);
        setWorkspaceUserId(userId);
        setWorkspaceState("ready");
        setError("");
      } catch {
        if (alive) setWorkspaceState("unavailable");
      }
    }
    void loadWorkspace();
    return () => { alive = false; };
  }, [session]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    if (!supabase) {
      setError(
        "Supabase is not configured. Use the isolated demonstration workspace.",
      );
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setLoading(false);
    if (error)
      setError("Sign-in failed. Check your credentials or connection.");
  }
  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!supabase) return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/onboard/`,
    });
    setLoading(false);
    setNotice(error
      ? "Unable to request a reset now. Please try again later."
      : "If this account exists, a password link will arrive at its email address.");
  }
  const shown = demo
    ? leads.length
      ? leads
      : fixtures
    : leads.filter((l) => !l.is_demo);
  const researchingCount = shown.filter((lead) => lead.status === "researching").length;
  function navigate(value: Section) {
    setSection(value);
    setMobile(false);
    setNotice("");
  }
  if (!ready)
    return (
      <main className="login">
        <p role="status">Restoring your workspace…</p>
      </main>
    );
  if (!session && !demo)
    return (
      <main className="login">
        <div className="login-brand">
          <Brand />
          <span className="eyebrow">THE WORKSPACE FOR WHAT’S NEXT</span>
          <h1>
            Better evidence.
            <br />
            Meaningful conversations.
          </h1>
          <p>
            A considered approach to growing ChainCraft Studio.
            <br />
            Research, relationships, and results — in one place.
          </p>
          <div className="login-note">
            <ShieldCheck size={20} /> Private by design. Human decisions at
            every step.
          </div>
        </div>
        <section className="login-card">
          <span className="eyebrow">CHAINCRAFT STUDIO</span>
          <h2>Welcome to your command center.</h2>
          <p>Sign in to your private sales workspace.</p>
          <form onSubmit={login}>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@your-business.com"
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              minLength={8}
              required
              autoComplete="current-password"
            />
            <button className="primary" disabled={loading || !supabase}>
              {loading ? "Signing in…" : "Sign in"}
              <ArrowUpRight size={16} />
            </button>
          </form>
          <details>
            <summary>Forgot your password?</summary>
            <form onSubmit={requestPasswordReset}>
              <label htmlFor="reset-email">Account email</label>
              <input id="reset-email" name="email" type="email" required autoComplete="email" />
              <button className="secondary" disabled={loading || !supabase}>Send password link</button>
            </form>
          </details>
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="divider" />
          <button
            className="secondary"
            onClick={() => {
              setDemo(true);
              void crmStore(true, "").list().then(setLeads);
              setError("");
            }}
          >
            Explore demonstration workspace <ChevronRight size={16} />
          </button>
          <small>
            {supabase
              ? "Use an administrator-provisioned account."
              : "Local setup required for sign-in. Demo uses fictional records only."}
          </small>
        </section>
      </main>
    );
  if (session && !demo && (workspaceState !== "ready" || workspaceUserId !== session.user.id))
    return (
      <main className="login">
        <section className="login-card">
          <Brand />
          <h1>Private workspace</h1>
          {workspaceState === "loading" || workspaceUserId !== session.user.id && workspaceState === "ready"
            ? <p role="status">Loading your organization…</p>
            : <p role="alert">{workspaceState === "membership-required"
              ? "This account has no single assigned organization. Ask the staging administrator to provision its membership."
              : "Workspace data is unavailable. Check the staging database and your access before continuing."}</p>}
          <button className="secondary" onClick={() => void supabase?.auth.signOut()}>Sign out</button>
        </section>
      </main>
    );
  return (
    <div className="workspace">
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <Brand />
        <div className="workspace-label">
          <span className="avatar">CC</span>
          <div>
            ChainCraft Studio<small>Sales workspace</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {sections.map((item, i) => {
            const Icon = icons[i];
            return (
              <button
                key={item}
                aria-current={section === item ? "page" : undefined}
                className={section === item ? "nav-item active" : "nav-item"}
                onClick={() => navigate(item)}
              >
                <Icon size={18} />
                {item}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="optional">
            <Command size={17} />
            <span>
              AI Calling <small>Optional · Not enabled</small>
            </span>
            <span className="off">OFF</span>
          </div>
          <div className="help">
            <CircleHelp size={18} />
            <span>
              Evidence first. Always.<small>Every action, accounted for.</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="menu"
              aria-label="Toggle navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            Workspace <ChevronRight size={14} />
            <strong>{section}</strong>
          </div>
          <div className="top-actions">
            <span className="environment">
              {demo ? "DEMONSTRATION" : "PRIVATE WORKSPACE"}
            </span>
            <button
              className="icon-button"
              aria-label="Open notifications"
              onClick={() => {
                setSection("Automation");
                setNotice("No notifications have been recorded.");
              }}
            >
              <Bell size={19} />
            </button>
            <button
              className="avatar signout"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await supabase?.auth.signOut();
                setDemo(false);
                setLeads([]);
                setRole("");
                setOrgId("");
                setTotals(null);
                setWorkspaceUserId("");
                setWorkspaceState("loading");
              }}
            >
              CC
            </button>
          </div>
        </header>
        <main className="content">
          <div className="safety-banner">
            <span>
              <ShieldCheck size={16} />
              {demo
                ? "Demonstration workspace · Fictional records, no live activity"
                : "Protected workspace · External operations disabled"}
            </span>
            <span>
              All outbound paused <Pause size={13} />
            </span>
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">YOUR SALES, WITH INTENTION</span>
              <h1>
                {section === "Overview"
                  ? "A clearer view of what matters."
                  : section}
              </h1>
              <p>
                {section === "Overview"
                  ? "From first signal to lasting relationship. Here’s your workspace at a glance."
                  : "Evidence-led work, with a human in control."}
              </p>
            </div>
            <button
              className="secondary"
              onClick={() =>
                navigate(section === "Leads" ? "Overview" : "Leads")
              }
            >
              {section === "Leads" ? "Back to overview" : "View leads"}
              <ArrowUpRight size={16} />
            </button>
          </div>
          {loading ? (
            <section className="panel" role="status">
              Loading workspace data…
            </section>
          ) : section === "Overview" ? (
            <>
              <div className="metrics">
                {[
                  {
                    label: "Qualified opportunities",
                    value: demo
                      ? shown.filter((l) => l.status === "qualified").length
                      : (totals?.qualified ?? "—"),
                    icon: Sparkles,
                    note: "Evidence for your next conversation",
                  },
                  {
                    label: "Meetings held",
                    value: demo ? 0 : (totals?.meetings_held ?? "—"),
                    icon: CalendarDays,
                    note: demo
                      ? "No demo meetings recorded"
                      : "From completed meeting records",
                  },
                  {
                    label: "Won deals",
                    value: demo
                      ? shown.filter((l) => l.status === "won").length
                      : (totals?.won ?? "—"),
                    icon: Check,
                    note: "Confirmed outcomes only",
                  },
                ].map((m) => (
                  <article className="metric" key={m.label}>
                    <div>
                      {m.label}
                      <m.icon size={18} />
                    </div>
                    <strong>{m.value.toString().padStart(2, "0")}</strong>
                    <small>{m.note}</small>
                  </article>
                ))}
              </div>
              <div className="overview-grid">
                <section className="panel opportunities">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">THE NEXT CONVERSATION</span>
                      <h2>Your opportunity pipeline</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("Leads")}
                    >
                      All leads <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="pipeline">
                    {[
                      "new",
                      "researching",
                      "qualified",
                      "contacted",
                      "won",
                    ].map((stage) => (
                      <div key={stage}>
                        <span>{stage.replace("_", " ")}</span>
                        <strong>
                          {shown.filter((l) => l.status === stage).length}
                        </strong>
                        <div className="pipeline-track">
                          <i
                            style={{
                              width: `${shown.length ? (shown.filter((l) => l.status === stage).length / shown.length) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="table-caption">
                    <h3>Recently added</h3>
                    <span>
                      {demo ? "Fictional fixtures" : "Stored lead records"}
                    </span>
                  </div>
                  <LeadTable leads={shown.slice(0, 5)} />
                </section>
                <section className="panel focus">
                  <span className="eyebrow">STORED WORKFLOW STATE</span>
                  <div className="focus-icon">
                    <Sparkles size={28} />
                  </div>
                  <h2>Lead-to-draft snapshot</h2>
                  <p>
                    {researchingCount} {researchingCount === 1 ? "lead" : "leads"} in research
                    {demo ? " (fictional records)" : " (latest 1,000 loaded)"}.
                  </p>
                  <div className="checkline">
                    <Check size={15} /> {demo ? shown.filter((lead) => lead.status === "qualified").length : (totals?.qualified ?? "—")} qualified leads
                  </div>
                  <div className="checkline">
                    <FileText size={15} /> {demo ? "—" : (totals?.drafts ?? "—")} stored drafts
                  </div>
                  <div className="checkline">
                    <Pause size={15} /> Live sending disabled
                  </div>
                  <p className="muted">Research and qualification do not establish contact permission. Drafts include every review state; these counts do not indicate send readiness.</p>
                  <button
                    className="primary"
                    onClick={() => navigate("Leads")}
                  >
                    Review CRM leads <ArrowUpRight size={16} />
                  </button>
                </section>
              </div>
              <div className="bottom-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Integration health</h2>
                    <span className="muted">Not verified live</span>
                  </div>
                  <Connections demo={demo} orgId={orgId} role={role} />
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Activity & attention</h2>
                    <Workflow size={18} />
                  </div>
                  <div className="empty">
                    <span className="empty-icon">
                      <Workflow size={24} />
                    </span>
                    <h3>A quiet, considered workspace.</h3>
                    <p>
                      {demo
                        ? "No demo automation activity recorded."
                        : "View Automation for stored jobs and notifications."}
                      <br />
                      Provider connections require configuration and
                      verification.
                    </p>
                  </div>
                </section>
              </div>
            </>
          ) : section === "Leads" ? (
            <CRM
              demo={demo}
              orgId={orgId}
              role={role}
              onChange={() => {
                void crmStore(demo, orgId)
                  .list()
                  .then(setLeads)
                  .catch(() =>
                    setError("Unable to refresh dashboard records."),
                  );
                if (!demo && supabase)
                  void supabase
                    .rpc("workspace_metrics", { p_org: orgId })
                    .then(({ data, error }) => {
                      if (!error) setTotals(data);
                    });
              }}
            />
          ) : section === "Email" ? (
            <Email demo={demo} orgId={orgId} role={role} />
          ) : section === "Vibe Prospecting" ? (
            <VibeProspecting demo={demo} orgId={orgId} role={role} onOpenCRM={() => navigate("Leads")}
              onOpenResearch={(leadId) => { setResearchLeadId(leadId); navigate("Business Research"); }} onOpenVerification={() => navigate("Email Verification")} />
          ) : section === "Email Verification" ? (
            <EmailVerification demo={demo} orgId={orgId} role={role} />
          ) : section === "Business Research" ? (
            <BusinessResearch demo={demo} orgId={orgId} role={role} initialLeadId={researchLeadId} onOpenEmail={() => navigate("Email")} />
          ) : section === "Discover" ? (
            <><QualificationReview demo={demo} orgId={orgId} role={role} /><Operations mode="Discover" demo={demo} orgId={orgId} role={role} /></>
          ) : section === "Campaigns" ? (
            <Campaigns demo={demo} orgId={orgId} role={role} />
          ) : section === "Analytics" ||
            section === "Automation" ||
            section === "LinkedIn Assistant" ||
            section === "Calendar" ? (
            <Operations mode={section} demo={demo} orgId={orgId} role={role} />
          ) : section === "Settings" ? (
            <><QualificationSettings demo={demo} orgId={orgId} role={role} /><section className="panel">
              <h2>Workspace safeguards</h2>
              <Connections demo={demo} orgId={orgId} role={role} controls />
              <div className="setting-row">
                <span>Access role</span>
                <strong>
                  {demo ? "Demo viewer" : role || "No organization membership"}
                </strong>
              </div>
              {[
                "Live email",
                "Live WhatsApp",
                "Billable AI",
                "AI Calling",
                "Inbound voice",
                "Call recording",
              ].map((item) => (
                <div className="setting-row" key={item}>
                  <span>{item}</span>
                  <span className="status">Disabled</span>
                </div>
              ))}
              <p className="muted">
                Enablement is unavailable until server policy and provider
                verification gates pass.
              </p>
            </section></>
          ) : (
            <WhatsApp demo={demo} orgId={orgId} />
          )}
          <footer>
            <span>
              CHAINCRAFT STUDIO <span className="footer-dot">/</span> Thoughtful
              growth, by design.
            </span>
            <span>
              {demo
                ? "Demo data · No external requests"
                : "RLS-scoped data · Live services not verified"}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Link2 size={25} />
      </span>
      <span>
        chaincraft
        <span className="brand-studio">STUDIO / SALES COMMAND CENTER</span>
      </span>
    </div>
  );
}
function LeadTable({ leads }: { leads: Lead[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Business</th>
            <th>Source</th>
            <th>Stage</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>
                <div className="business">
                  <span className="business-icon">{lead.business_name[0]}</span>
                  <div>
                    <strong>{lead.business_name}</strong>
                    <small>{lead.website_url || "Website not recorded"}</small>
                  </div>
                </div>
              </td>
              <td>{lead.source_type}</td>
              <td>
                <span className="stage">
                  {lead.status.replaceAll("_", " ")}
                </span>
              </td>
              <td>
                <span className="muted">
                  {lead.is_demo ? "Demo fixture" : "Unreviewed"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!leads.length && (
        <div className="empty">
          <h3>No leads here yet.</h3>
          <p>Records will appear after a permitted import or manual entry.</p>
        </div>
      )}
    </div>
  );
}
