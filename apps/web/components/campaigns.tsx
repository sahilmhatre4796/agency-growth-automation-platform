"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, ChevronRight, Pause, Play, Plus, Rocket,
  ShieldCheck, Trash2, X,
} from "lucide-react";
import { supabase } from "../lib/supabase";

type Targeting = {
  target_industries: string[]; target_cities: string[]; target_countries: string[];
  max_new_prospects: number; serper_discovery_enabled: boolean;
};
const EMPTY_TARGETING: Targeting = {
  target_industries: [], target_cities: [], target_countries: [],
  max_new_prospects: 0, serper_discovery_enabled: false,
};
type Campaign = {
  id: string; state: string; provider: string; target_industry: string; target_city: string;
  target_country: string; target_count: number; website_percent: number; max_credits: number;
  credits_reserved: number; next_page: number; pages_completed: number; observations_count: number;
  new_businesses_count: number; last_error_code: string | null; created_at: string;
  auto_continue: boolean; auto_stop_reason: string | null; batch_key: string | null;
};
type RunDiag = {
  campaign_id: string | null; state: string; observations_count: number | null;
  last_diagnostics: {
    raw_results: number; name_rejected: number; education_rejected: number;
    unsafe_url_rejected: number; snippet_rejected: number; identity_rejected: number;
    duplicate_rejected: number; accepted: number;
  } | null;
};
const COUNTRIES = ["India", "United States", "United Kingdom", "United Arab Emirates", "Singapore",
  "Australia", "Canada", "Germany", "France", "Netherlands", "Belgium", "Switzerland",
  "Italy", "Spain", "Portugal", "Japan", "South Korea", "Malaysia", "Thailand", "Vietnam", "Indonesia",
  "Sri Lanka", "Bangladesh", "Pakistan", "Nepal", "South Africa", "Nigeria", "Kenya", "Brazil", "Mexico"];

export function Campaigns({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [targeting, setTargeting] = useState<Targeting>(EMPTY_TARGETING);
  const [cap, setCap] = useState<number | null>(null);
  const [usedCredits, setUsedCredits] = useState<number | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [diags, setDiags] = useState<RunDiag[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("Surat jewellery campaign");
  const [industries, setIndustries] = useState<string[]>([]);
  const [customIndustry, setCustomIndustry] = useState("");
  const [cities, setCities] = useState("Surat");
  const [country, setCountry] = useState("India");
  const [count, setCount] = useState(3);
  const [maxCredits, setMaxCredits] = useState(1);
  const [websitePercent, setWebsitePercent] = useState(70);
  const isAdmin = demo || role === "admin";
  const refresh = useCallback(async () => {
    if (demo || !supabase || !orgId) return;
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
      .toISOString().slice(0, 10);
    const [t, c, o, u] = await Promise.all([
      supabase.from("discovery_targeting").select("target_industries,target_cities,target_countries,max_new_prospects,serper_discovery_enabled").eq("org_id", orgId).maybeSingle(),
      supabase.from("discovery_campaigns").select("id,state,provider,target_industry,target_city,target_country,target_count,website_percent,max_credits,credits_reserved,next_page,pages_completed,observations_count,new_businesses_count,last_error_code,created_at,auto_continue,auto_stop_reason,batch_key").eq("org_id", orgId).order("created_at", { ascending: false }).limit(12),
      supabase.from("organizations").select("research_monthly_credit_cap").eq("id", orgId).maybeSingle(),
      supabase.from("research_credit_usage").select("reserved_credits").eq("org_id", orgId).eq("provider", "serper").eq("month_start", monthStart).maybeSingle(),
    ]);
    if (t.error || c.error || o.error) throw new Error("Campaign configuration could not be loaded.");
    setTargeting((t.data as Targeting | null) ?? EMPTY_TARGETING);
    setIndustries((current) => current.length ? current : ((t.data as Targeting | null)?.target_industries ?? []));
    setCampaigns((c.data ?? []) as Campaign[]);
    setCap((o.data?.research_monthly_credit_cap as number | null) ?? null);
    setUsedCredits((u.data?.reserved_credits as number | null) ?? 0);
    const ids = ((c.data ?? []) as Campaign[]).map((x) => x.id);
    if (ids.length) {
      const runs = await supabase.from("discovery_runs").select("campaign_id,state,observations_count,last_diagnostics").in("campaign_id", ids).order("created_at", { ascending: false });
      setDiags((runs.data ?? []) as RunDiag[]);
    } else setDiags([]);
  }, [demo, orgId]);
  // Run the next queued page of an armed campaign. The Edge Function claims the
  // campaign from the queue, executes exactly one page and advances the batch.
  const continueCampaign = useCallback(async (): Promise<void> => {
    if (demo || !supabase || !orgId) return;
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    if (!token) throw new Error("Sign in again before continuing a campaign.");
    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/serper-discovery-jobs`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: "campaign", org_id: orgId }),
    });
    if (!resp.ok) throw new Error(`Worker HTTP ${resp.status}`);
  }, [demo, orgId]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((e) => setError(e.message)); }, [refresh]);
  useEffect(() => {
    if (demo) return;
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 30000);
    return () => window.clearInterval(timer);
  }, [demo, refresh]);
  // Durable continuation: while the dashboard is open it nudges the queue so an
  // armed batch keeps moving without any further clicks. With the tab closed
  // the worker (or the activated schedule) takes over. Every page is claimed
  // and finished in the database, so a nudge can never execute a page twice.
  useEffect(() => {
    if (demo) return;
    const armed = campaigns.some((c) => c.auto_continue && (c.state === "queued" || c.state === "running"));
    if (!armed) return;
    const timer = window.setTimeout(() => { void continueCampaign().catch(() => {}); }, 2000);
    return () => window.clearTimeout(timer);
  }, [campaigns, demo, continueCampaign]);
  const diagOf = (id: string) => diags.find((d) => d.campaign_id === id)?.last_diagnostics ?? null;
  const availableIndustries = [...new Set([...targeting.target_industries, ...industries])];
  async function start() {
    setError(""); setNotice("");
    const chosen = industries.map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (!name.trim()) return setError("Give this campaign a name.");
    if (!chosen.length) return setError("Select or add at least one industry.");
    const cityList = cities.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    setBusy(true);
    const comboCount = Math.max(1, cityList.length) * chosen.length;
    const proceed = window.confirm(
      `Start ${comboCount} campaign${comboCount === 1 ? "" : "s"} (${chosen.join(", ")} · ${cityList.length ? cityList.join(", ") : "nationwide"}) ` +
      `targeting ${count} prospects each with up to ${maxCredits} credit${maxCredits === 1 ? "" : "s"} per campaign? ` +
      `Only paged_search (1 credit per page) will run. Queue/resume order follows combination order — pause or cancel any time.`,
    );
    if (!proceed) { setBusy(false); return; }
    try {
      const targetLib = [...new Set([...targeting.target_industries, ...chosen])];
      const actor = (await supabase!.auth.getUser()).data.user;
      if (!actor) throw new Error("Sign in again before starting a campaign.");
      const save = await supabase!.rpc("save_serper_targeting", {
        p_org: orgId, p_serper_enabled: true, p_industries: targetLib, p_cities: cityList.length ? cityList : [country.toLowerCase()],
        p_countries: [country], p_max_new_prospects: Math.max(count, targeting.max_new_prospects),
      });
      if (save.error) throw new Error(`Targeting could not be saved: ${save.error.message}`);
      const created = await supabase!.rpc("create_discovery_campaign_batch", {
        p_org: orgId, p_name: name.trim(), p_industries: chosen, p_cities: cityList.length ? cityList : [],
        p_country: country, p_count: count, p_website_percent: websitePercent, p_max_credits: maxCredits,
      });
      if (created.error) throw new Error(`Campaign could not be created: ${created.error.message}`);
      const ids = (created.data as string[]) ?? [];
      // One START authorizes the whole batch: every combination becomes
      // automatic, the first campaign starts now and the rest follow in order.
      const armed = await supabase!.rpc("arm_campaign_batch_continuation", {
        p_org: orgId, p_campaigns: ids,
      });
      if (armed.error) throw new Error(`Automatic continuation could not be armed: ${armed.error.message}`);
      await continueCampaign();
      setNotice(`Campaign batch started (${ids.length}). The first campaign is running and the remaining combinations follow automatically until the prospect target, the credit budget or the available results are exhausted.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The campaign could not be started."); } finally { setBusy(false); }
  }
  async function runPage(campaignId: string) {
    setError(""); setNotice("");
    setBusy(true);
    try {
      const { data: session } = await supabase!.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error("Sign in again before running a page.");
      const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/serper-discovery-jobs`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ org_id: orgId, campaign_id: campaignId }),
      });
      const body = await resp.text();
      setNotice(`Worker responded HTTP ${resp.status}. ${body.slice(0, 300)}`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Worker call failed."); } finally { setBusy(false); }
  }
  async function act(rpc: "pause_discovery_campaign" | "resume_discovery_campaign" | "cancel_discovery_campaign", campaignId: string, confirmText?: string) {
    setError(""); setNotice("");
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const result = await supabase!.rpc(rpc, { p_org: orgId, p_campaign: campaignId });
      if (result.error) throw new Error(result.error.message);
      setNotice("Discovery campaign updated.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The campaign could not be updated."); } finally { setBusy(false); }
  }
  const demoCampaigns: Campaign[] = [{
    id: "demo-1", state: "completed", provider: "serper", target_industry: "jewellery", target_city: "Surat",
    target_country: "India", target_count: 3, website_percent: 70, max_credits: 1, credits_reserved: 1,
    next_page: 2, pages_completed: 1, observations_count: 3, new_businesses_count: 3,
    last_error_code: null, created_at: "2026-11-16T00:00:00.000Z",
    auto_continue: false, auto_stop_reason: "BATCH_COMPLETE", batch_key: "demo-batch",
  }];
  const shownCampaigns = demo ? demoCampaigns : campaigns;
  const queuedCampaigns = demo ? [] : campaigns.filter((c) => c.state === "paused" && c.auto_continue);
  return (
    <>
      {error && <div role="alert" className="error">{error}</div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      <section className="panel">
        <div className="panel-heading">
          <h2>Campaign Command Center <small className="muted">Serper · paged_search</small></h2>
          <button className="icon-button" aria-label="Refresh campaigns" onClick={() => void refresh()}><ChevronRight size={18} /></button>
        </div>
        <div className="verification-metrics">
          <div className="metric"><div>Monthly Serper allowance</div><strong>{cap ?? "—"}</strong><small>Organization hard cap, atomic reservations</small></div>
          <div className="metric"><div>Credits used this month</div><strong>{usedCredits ?? "—"}</strong><small>{cap === null || usedCredits === null ? "—" : `${Math.max(0, cap - usedCredits)} remaining`}</small></div>
          <div className="metric"><div>Max new prospects / run</div><strong>{targeting.max_new_prospects || "—"}</strong><small>Per organization, enforced at lease and ingest</small></div>
          <div className="metric"><div>Targeting</div><strong>{targeting.serper_discovery_enabled ? "ENABLED" : "DISABLED"}</strong><small>Owner toggles in Settings; disabled until flipped</small></div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <div className="form-grid">
            <label>Campaign name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Website lane<input type="range" min={0} max={100} step={10} value={websitePercent} onChange={(e) => setWebsitePercent(Number(e.target.value))} />{websitePercent}% website · {100 - websitePercent}% automation</label>
            <label>Country<select value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>Cities (comma separated; empty = nationwide)<input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Surat, Mumbai" /></label>
            <label>Max prospects / campaign<select value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>Credit cap / campaign (1 search = 1 credit)<select value={maxCredits} onChange={(e) => setMaxCredits(Number(e.target.value))}>{[1, 2, 3, 5, 10, 15].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          </div>
          <fieldset className="verification-controls">
            <legend>Industry</legend>
            <div className="filter-row">
              {availableIndustries.map((industry) => (
                <label key={industry} className="checkbox">
                  <input type="checkbox" checked={industries.includes(industry)} onChange={() => setIndustries((cur) => cur.includes(industry) ? cur.filter((x) => x !== industry) : [...cur, industry])} />
                  {industry}
                </label>
              ))}
              <input value={customIndustry} onChange={(e) => setCustomIndustry(e.target.value)} placeholder="new industry" />
              <button type="button" className="secondary" onClick={() => { const v = customIndustry.trim().toLowerCase(); if (v && !industries.includes(v)) { setIndustries((cur) => [...cur, v]); setCustomIndustry(""); } }}><Plus size={14} /> Add</button>
            </div>
          </fieldset>
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy || !isAdmin || demo}><Rocket size={16} /> {busy ? "Starting…" : "START CAMPAIGN"}</button>
            <span className="muted">One active campaign per organization; the remaining combinations follow automatically in order and stop at the target, budget or exhausted results.</span>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>Active & recent campaigns</h2><span className="muted">{demo ? "Demonstration fixtures" : `${shownCampaigns.length} shown`}</span></div>
        {shownCampaigns.map((campaign) => {
          const diag = diagOf(campaign.id);
          const progress = campaign.target_count ? Math.min(100, Math.round((campaign.new_businesses_count / campaign.target_count) * 100)) : 0;
          return (
            <div className="verification-record" key={campaign.id}>
              <div className="detail-header">
                <span className="stage">{campaign.state}</span>
                <div><strong>{campaign.target_industry} · {campaign.target_city}</strong><small>{campaign.target_country} · {campaign.website_percent}% website lane · created {new Date(campaign.created_at).toLocaleDateString()}</small></div>
                <div className="score-number">{progress}%<small>of target</small></div>
              </div>
              <div className="detail-grid">
                <span><small>New prospects</small>{campaign.new_businesses_count} / {campaign.target_count}</span>
                <span><small>Observations</small>{campaign.observations_count}</span>
                <span><small>Pages</small>{campaign.pages_completed}</span>
                <span><small>Credits</small>{campaign.credits_reserved}/{campaign.max_credits}</span>
                <span><small>Next page</small>{campaign.next_page}</span>
                <span><small>Provider</small>{campaign.provider}</span>
              </div>
              {diag && (
                <div className="evidence">
                  <strong>Last page diagnostics</strong>
                  <small>raw {diag.raw_results} · accepted {diag.accepted} · identity rejected {diag.identity_rejected} · name rejected {diag.name_rejected} · education {diag.education_rejected} · snippet {diag.snippet_rejected} · unsafe URL {diag.unsafe_url_rejected} · duplicate {diag.duplicate_rejected}</small>
                </div>
              )}
              {campaign.last_error_code && <p className="error" role="alert">{campaign.last_error_code}</p>}
              <div className="evidence">
                <strong>Automatic continuation</strong>
                <small>{campaign.auto_continue
                  ? "ARMED — the background worker runs the next page without further clicks"
                  : `STOPPED${campaign.auto_stop_reason ? ` — ${campaign.auto_stop_reason}` : ""}`}</small>
              </div>
              <div className="button-row">
                {(campaign.state === "queued" || campaign.state === "running") && (
                  <button className="secondary" onClick={() => void runPage(campaign.id)} disabled={busy || demo}><Play size={14} /> Run next page</button>
                )}
                {(campaign.state === "queued" || campaign.state === "running") && (
                  <button className="secondary" onClick={() => void act("pause_discovery_campaign", campaign.id)} disabled={busy || demo}><Pause size={14} /> Pause</button>
                )}
                {campaign.state === "paused" && (
                  <button className="secondary" onClick={() => void act("resume_discovery_campaign", campaign.id)} disabled={busy || demo}><Play size={14} /> Resume</button>
                )}
                {campaign.state !== "completed" && campaign.state !== "cancelled" && (
                  <button className="secondary" onClick={() => void act("cancel_discovery_campaign", campaign.id, `Cancel this campaign? Budget reserved (${campaign.credits_reserved} credit${campaign.credits_reserved === 1 ? "" : "s"}) remains consumed.`)} disabled={busy || demo}><Trash2 size={14} /> Cancel</button>
                )}
              </div>
            </div>
          );
        })}
        {!shownCampaigns.length && <div className="empty"><h3>No campaigns yet.</h3><p>Configure the targeting above and press START. The first campaign starts immediately and the remaining combinations follow automatically.</p></div>}
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>Queued campaigns</h2><span className="muted">{queuedCampaigns.length} waiting in combination order</span></div>
        {queuedCampaigns.length ? queuedCampaigns.map((campaign) => (
          <div className="verification-record" key={`queued-${campaign.id}`}>
            <div className="detail-header">
              <span className="stage">{campaign.state}</span>
              <div><strong>{campaign.target_industry} · {campaign.target_city}</strong><small>{campaign.target_country} · queued after the current campaign finishes</small></div>
              <div className="score-number">{campaign.target_count}<small>prospects</small></div>
            </div>
          </div>
        )) : <div className="empty"><h3>Nothing queued.</h3><p>Every combination of the current batch has run or stopped.</p></div>}
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>Providers</h2><span className="muted">Only ready integrations may spend credits</span></div>
        <div className="integration-row"><ShieldCheck size={18} /><div><strong>Serper search (primary)</strong><small>{targeting.serper_discovery_enabled ? "Enabled for this organization (owner-set). 1 credit per paged search." : "Disabled. Owner/admin enables in targeting settings. No discovery can run while disabled."}</small></div><span className="status">{targeting.serper_discovery_enabled ? "ENABLED" : "DISABLED"}</span></div>
        <div className="integration-row"><AlertCircle size={18} /><div><strong>Harvey OSM fallback</strong><small>Not production-ready: OCR/certification gaps pending; requires owner enablement and revalidation.</small></div><span className="status">DISABLED</span></div>
        <div className="integration-row"><X size={18} /><div><strong>Tavily research</strong><small>TAVILY_API_KEY is not configured in the platform. Never used for discovery.</small></div><span className="status">NOT CONFIGURED</span></div>
        <p className="muted">Provider switches are never automatic. Changing provider requires explicit configuration and a fresh review before any credits are spent.</p>
      </section>
      <aside className="setting-row"><span>Recommendation</span><span>One campaign per organization at a time; extra combinations queue as paused and require explicit activation.</span></aside>
    </>
  );
}
