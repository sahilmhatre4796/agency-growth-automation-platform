"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Search, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";
import { crmStore } from "../lib/crm-store";
import { classifyLeadOpportunity, industryMatches, leadTargets, opportunityPriority, parseVibeRequest, websiteServiceLabel, type VibeFilters, type PublicDecisionMaker } from "../../../packages/server/vibe-prospecting";
import { allocateCountryTargets, canonicalDiscoveryCountry, DEFAULT_DAILY_TARGETS, DEFAULT_WEEKLY_COUNTRIES, mentionedDiscoveryCountries, SELECTABLE_DISCOVERY_COUNTRIES, weeklyMarketForDate } from "../../../packages/server/market-targeting";
import { leadReviewReadiness } from "../../../packages/server/lead-review";
import { advanceLeadWorkflow } from "../../../packages/server/lead-workflow";
import { OvertureReview } from "./overture-review";

const campaignsEnabled = process.env.NEXT_PUBLIC_ENABLE_DISCOVERY_CAMPAIGNS === "true";

type Lead = { id: string; business_name: string; business_category: string | null; city: string | null; state_region: string | null; country: string | null; website_url: string | null; source_type: string; status: string; created_at?: string };
type Contact = { id: string; lead_id: string; contact_name: string | null; role: string | null; email_normalized: string | null; phone_e164: string | null; source_url: string | null };
type Report = { id: string; lead_id: string; contact_id: string | null; state: string; website: { status: string; url: string | null }; decision_maker_candidates: PublicDecisionMaker[]; observed_at: string; expires_at: string };
type Assessment = { lead_id: string; status: string; reason: string; observed_at: string };
type Qualification = { lead_id: string; status: string; score: number; confidence: number; evaluated_at: string };
type Verification = { contact_id: string; status: string; provider: string; checked_at: string; expires_at: string; reviewed_at: string | null };
type Targeting = { serper_discovery_enabled: boolean; vibe_contact_discovery_enabled: boolean; max_new_prospects: number;
  weekly_countries?: string[]; weekly_timezone?: string; weekly_fallback_enabled?: boolean;
  daily_website_target?: number; daily_automation_target?: number; daily_india_manual_target?: number };
type WeeklyPlan = { countries: string[]; timezone: string; fallback: boolean; website: number; automation: number; india: number };
type Service = { id: string; service_key: string; name: string };
type ServiceMatch = { lead_id: string; service_id: string; status: string; reason: string; evidence_ids: string[]; confidence: number; assessed_at: string };
type DiscoveryRun = { id: string; campaign_id: string | null; state: string; observations_count: number; requested_limit: number; last_error_code: string | null; created_at: string };
type DiscoveryCampaign = { id: string; state: string; target_country: string; target_count: number; website_percent: number; pages_completed: number; observations_count: number; new_businesses_count: number; credits_reserved: number; max_credits: number; last_error_code: string | null; created_at: string };
type DiscoverySource = { lead_id: string; discovery_run_id: string | null; proposed_category: string | null };
type DiscoveryCandidate = { discovery_run_id: string; state: string };
type ContactDiscoveryJob = { id: string; lead_id: string; state: string; observations_count: number; error_code: string | null; requested_at: string };
type ContactPoint = { id: string; lead_id: string; kind: "email" | "phone" | "whatsapp"; normalized_value: string; display_value: string; email_type: string; contact_name: string | null; role: string | null; review_status: string; preferred: boolean; last_cross_checked_at: string };
type ContactSource = { id: string; point_id: string; source_provider: string; source_url: string; evidence_excerpt: string; observed_at: string; confidence: number };
type LeadEvidence = { id: string; lead_id: string; source_url: string | null; claim: string; observed_at: string; reviewed_by: string | null };
type Consent = { contact_id: string; state: string; revoked_at: string | null; recorded_at: string };
type Draft = { report_id: string; contact_id: string; draft_id: string };
type Row = { lead: Lead; contact: Contact | null; crmContacts: Contact[]; candidate: PublicDecisionMaker | null; reportId: string | null; assessment: Assessment | null; qualification: Qualification | null; verification: Verification | null; points: ContactPoint[] };

function evidenceUrl(value: string | null | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; }
  catch { return null; }
}

function csvCell(value: string | number | null | undefined) {
  const raw = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safe = /^[=+@\-\t]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function VibeProspecting({ demo, orgId, role, onOpenCRM, onOpenResearch, onOpenVerification }: { demo: boolean; orgId: string; role: string; onOpenCRM: () => void; onOpenResearch: (leadId: string) => void; onOpenVerification: () => void }) {
  const [request, setRequest] = useState("");
  const [filters, setFilters] = useState<VibeFilters | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [weeklyPlan, setWeeklyPlan] = useState<WeeklyPlan>({ countries: [...DEFAULT_WEEKLY_COUNTRIES], timezone: "Asia/Kolkata", fallback: false,
    website: DEFAULT_DAILY_TARGETS.internationalWebsite, automation: DEFAULT_DAILY_TARGETS.internationalAutomation, india: DEFAULT_DAILY_TARGETS.indiaManual });
  const [services, setServices] = useState<Service[]>([]);
  const [serviceMatches, setServiceMatches] = useState<ServiceMatch[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [campaigns, setCampaigns] = useState<DiscoveryCampaign[]>([]);
  const [discoverySources, setDiscoverySources] = useState<DiscoverySource[]>([]);
  const [discoveryCandidates, setDiscoveryCandidates] = useState<DiscoveryCandidate[]>([]);
  const [contactJobs, setContactJobs] = useState<ContactDiscoveryJob[]>([]);
  const [points, setPoints] = useState<ContactPoint[]>([]);
  const [sources, setSources] = useState<ContactSource[]>([]);
  const [leadEvidence, setLeadEvidence] = useState<LeadEvidence[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [creditCap, setCreditCap] = useState(0);
  const [reservedCredits, setReservedCredits] = useState(0);
  const [asOfMs, setAsOfMs] = useState(0);
  const [searchActive, setSearchActive] = useState(false);
  const [resultGroup, setResultGroup] = useState<"website" | "automation">("website");
  const [textFilter, setTextFilter] = useState("");
  const [contactFilter, setContactFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "score">("score");
  const [page, setPage] = useState(0);
  const [contactPage, setContactPage] = useState(0);
  const [selectedSnapshot, setSelected] = useState<Row | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [emailType, setEmailType] = useState("unknown");
  const [creditConsent, setCreditConsent] = useState(false);
  const [contactCreditConsent, setContactCreditConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!supabase && !demo) return;
    if (demo) {
      const store = crmStore(true, "");
      try {
        const rows = await store.list();
        setLeads(rows as unknown as Lead[]);
        setAsOfMs(Date.now());
        return;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Demonstration data unavailable.");
        return;
      }
    }
    if (!supabase || !orgId || role !== "admin") return;
    const [l, c, r, a, q, v, t, o, u, s, m, d, p, ps, cj, ev, dc, ds, dcan, cr, dr] = await Promise.all([
      supabase.from("leads").select("id,business_name,business_category,city,state_region,country,website_url,source_type,status,created_at").eq("org_id", orgId).eq("is_demo", false).limit(1000),
      supabase.from("contacts").select("id,lead_id,contact_name,role,email_normalized,phone_e164,source_url").eq("org_id", orgId).limit(3000),
      supabase.from("business_research_reports").select("id,lead_id,contact_id,state,website,decision_maker_candidates,observed_at,expires_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(500),
      supabase.from("lead_website_assessments").select("lead_id,status,reason,observed_at").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(1000),
      supabase.from("lead_qualifications").select("lead_id,status,score,confidence,evaluated_at").eq("org_id", orgId).order("evaluated_at", { ascending: false }).limit(1000),
      supabase.from("email_verification_records").select("contact_id,status,provider,checked_at,expires_at,reviewed_at").eq("org_id", orgId).order("checked_at", { ascending: false }).limit(1000),
      supabase.from("discovery_targeting").select("serper_discovery_enabled,vibe_contact_discovery_enabled,max_new_prospects,weekly_countries,weekly_timezone,weekly_fallback_enabled,daily_website_target,daily_automation_target,daily_india_manual_target").eq("org_id", orgId).maybeSingle(),
      supabase.from("organizations").select("research_monthly_credit_cap").eq("id", orgId).single(),
      supabase.from("research_credit_usage").select("provider,month_start,reserved_credits").eq("org_id", orgId).eq("provider", "serper").order("month_start", { ascending: false }).limit(1),
      supabase.from("service_catalog").select("id,service_key,name").eq("org_id", orgId).limit(100),
      supabase.from("lead_service_matches").select("lead_id,service_id,status,reason,evidence_ids,confidence,assessed_at").eq("org_id", orgId).order("assessed_at", { ascending: false }).limit(1000),
      campaignsEnabled ? supabase.from("discovery_runs").select("id,campaign_id,state,observations_count,requested_limit,last_error_code,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(50)
        : supabase.from("discovery_runs").select("id,state,observations_count,requested_limit,last_error_code,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(50),
      supabase.from("vibe_contact_points").select("id,lead_id,kind,normalized_value,display_value,email_type,contact_name,role,review_status,preferred,last_cross_checked_at").eq("org_id", orgId).limit(3000),
      supabase.from("vibe_contact_sources").select("id,point_id,source_provider,source_url,evidence_excerpt,observed_at,confidence").eq("org_id", orgId).limit(6000),
      supabase.from("vibe_contact_discovery_jobs").select("id,lead_id,state,observations_count,error_code,requested_at").eq("org_id", orgId).order("requested_at", { ascending: false }).limit(100),
      supabase.from("lead_evidence").select("id,lead_id,source_url,claim,observed_at,reviewed_by").eq("org_id", orgId).order("observed_at", { ascending: false }).limit(3000),
      campaignsEnabled ? supabase.from("discovery_campaigns").select("id,state,target_country,target_count,website_percent,pages_completed,observations_count,new_businesses_count,credits_reserved,max_credits,last_error_code,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(5) : Promise.resolve({ data: [], error: null }),
      supabase.from("lead_discovery_sources").select("lead_id,discovery_run_id,proposed_category").eq("org_id", orgId).order("created_at", { ascending: false }).limit(5000),
      supabase.from("discovery_candidates").select("discovery_run_id,state").eq("org_id", orgId).order("created_at", { ascending: false }).limit(5000),
      supabase.from("consent_records").select("contact_id,state,revoked_at,recorded_at").eq("org_id", orgId).eq("channel", "email").order("recorded_at", { ascending: false }).limit(3000),
      supabase.from("personalized_email_drafts").select("report_id,contact_id,draft_id").eq("org_id", orgId).limit(1000),
    ]);
    if ([l, c, r, a, q, v, t, o, u, s, m, d, p, ps, cj, ev, dc, ds, dcan, cr, dr].some((item) => item.error)) throw new Error("Prospecting evidence is unavailable. Refresh or check staging database permissions.");
    setLeads((l.data ?? []) as Lead[]);
    setContacts((c.data ?? []) as Contact[]);
    setReports((r.data ?? []) as Report[]);
    setAssessments((a.data ?? []) as Assessment[]);
    setQualifications((q.data ?? []) as Qualification[]);
    setVerifications((v.data ?? []) as Verification[]);
    setTargeting(t.data as Targeting | null);
    if (t.data) setWeeklyPlan({ countries: t.data.weekly_countries ?? [...DEFAULT_WEEKLY_COUNTRIES], timezone: t.data.weekly_timezone ?? "Asia/Kolkata",
      fallback: t.data.weekly_fallback_enabled ?? false, website: t.data.daily_website_target ?? 350,
      automation: t.data.daily_automation_target ?? 150, india: t.data.daily_india_manual_target ?? 100 });
    setServices((s.data ?? []) as Service[]);
    setServiceMatches((m.data ?? []) as ServiceMatch[]);
    setRuns((d.data ?? []) as unknown as DiscoveryRun[]);
    setCampaigns((dc.data ?? []) as DiscoveryCampaign[]);
    setDiscoverySources((ds.data ?? []) as DiscoverySource[]);
    setDiscoveryCandidates((dcan.data ?? []) as DiscoveryCandidate[]);
    setPoints((p.data ?? []) as ContactPoint[]);
    setSources((ps.data ?? []) as ContactSource[]);
    setContactJobs((cj.data ?? []) as ContactDiscoveryJob[]);
    setLeadEvidence((ev.data ?? []) as LeadEvidence[]);
    setConsents((cr.data ?? []) as Consent[]);
    setDrafts((dr.data ?? []) as Draft[]);
    setCreditCap(o.data?.research_monthly_credit_cap ?? 0);
    setReservedCredits(u.data?.[0]?.month_start?.startsWith(new Date().toISOString().slice(0, 7)) ? u.data[0].reserved_credits : 0);
    setAsOfMs(Date.now());
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);

  const rows = useMemo(() => {
    if (!searchActive || !filters) return [];
    const result: Row[] = [];
    for (const lead of leads) {
      if (lead.status === "disqualified") continue;
      // Never infer a country from a city, name or search target. Historical
      // India records remain stored, but are absent from international defaults.
      if (!filters.countries.includes(canonicalDiscoveryCountry(lead.country ?? "") ?? "")) continue;
      if (filters.region && lead.state_region?.trim().toLowerCase() !== filters.region.trim().toLowerCase()) continue;
      // Serper's industry is deliberately an unconfirmed source proposal, not
      // the reviewed CRM category. It may locate a record for contact review,
      // but must not make the lead qualified or change its catalog match.
      const industry = filters.industry?.toLowerCase();
      if (industry && !lead.business_category?.toLowerCase().includes(industry)
        && !discoverySources.some((source) => source.lead_id === lead.id
          && source.proposed_category?.toLowerCase().includes(industry))) continue;
      if (filters.city && lead.city?.trim().toLowerCase() !== filters.city.trim().toLowerCase()) continue;
      const assessment = assessments.find((item) => item.lead_id === lead.id) ?? null;
      if (filters.website_criterion === "missing_or_broken" && filters.lead_category === "website" && assessment?.status !== "NO_OFFICIAL_WEBSITE_DISCOVERED") continue;
      if (filters.lead_category === "website" && filters.website_criterion === "improvement" && assessment?.status !== "VERIFIED_TECHNICAL_PROBLEM") continue;
      if (filters.lead_category === "website" && filters.website_criterion === "ecommerce_opportunity") {
        const ecommerceIds = services.filter((service) => /e-?commerce|online (?:shop|store)/i.test(service.name)).map((service) => service.id);
        if (!ecommerceIds.some((id) => serviceMatches.find((match) => match.lead_id === lead.id && match.service_id === id)?.status === "verified_gap")) continue;
      }
      const report = reports.find((item) => item.lead_id === lead.id && Date.parse(item.expires_at) > asOfMs) ?? null;
      const candidate = report?.decision_maker_candidates?.find((item) => !filters.decision_maker_role || item.role.toLowerCase().includes(filters.decision_maker_role)) ?? null;
      const crmContacts = contacts.filter((item) => item.lead_id === lead.id);
      const contact = crmContacts.find((item) => !candidate?.email || item.email_normalized === candidate.email) ?? null;
      const leadPoints = points.filter((point) => point.lead_id === lead.id);
      const emails = leadPoints.filter((point) => point.kind === "email" && point.review_status !== "rejected");
      if (filters.require_public_email && !emails.length && !candidate?.email
        && !crmContacts.some((item) => item.email_normalized && item.source_url)) continue;
      const distinctEmails = new Set([...emails.map((item) => item.normalized_value), ...crmContacts.flatMap((item) => item.email_normalized ? [item.email_normalized] : [])]);
      if (contactFilter === "has_email" && !distinctEmails.size) continue;
      if (contactFilter === "missing_email" && distinctEmails.size) continue;
      if (contactFilter === "multiple_emails" && distinctEmails.size < 2) continue;
      if (contactFilter === "vibe_found" && !emails.some((point) => sources.some((source) => source.point_id === point.id && ["vibe", "official_website"].includes(source.source_provider)))) continue;
      if (contactFilter === "source_disagreement") {
        const byProvider = new Map<string, Set<string>>();
        for (const point of emails) for (const source of sources.filter((item) => item.point_id === point.id)) {
          const values = byProvider.get(source.source_provider) ?? new Set<string>();
          values.add(point.normalized_value); byProvider.set(source.source_provider, values);
        }
        const signatures = [...byProvider.values()].map((values) => [...values].sort().join("|"));
        if (byProvider.size < 2 || new Set(signatures).size < 2) continue;
      }
      if (contactFilter === "needs_verification" && ![...distinctEmails].some((email) => !crmContacts.some((entry) => entry.email_normalized === email && verifications.some((check) => check.contact_id === entry.id && check.status === "valid" && Date.parse(check.expires_at) > asOfMs)))) continue;
      if (contactFilter === "has_phone" && !leadPoints.some((point) => ["phone", "whatsapp"].includes(point.kind)) && !crmContacts.some((item) => item.phone_e164)) continue;
      if (contactFilter === "has_owner" && !candidate && !leadPoints.some((point) => point.contact_name)) continue;
      const verification = contact ? verifications.find((item) => item.contact_id === contact.id && Date.parse(item.expires_at) > asOfMs) ?? null : null;
      result.push({ lead, contact, crmContacts, candidate, reportId: report?.id ?? null, assessment, qualification: qualifications.find((item) => item.lead_id === lead.id) ?? null, verification, points: leadPoints });
    }
    const needle = textFilter.trim().toLowerCase();
    return result.filter((row) => !needle || [row.lead.business_name, row.candidate?.full_name, row.candidate?.email, row.lead.city,
      ...row.points.map((point) => point.display_value),
      ...row.crmContacts.flatMap((entry) => [entry.email_normalized, entry.phone_e164])].some((value) => value?.toLowerCase().includes(needle)))
      .sort((a, b) => sort === "name" ? a.lead.business_name.localeCompare(b.lead.business_name)
        : (b.qualification?.score ?? -1) - (a.qualification?.score ?? -1) || a.lead.business_name.localeCompare(b.lead.business_name));
  }, [searchActive, filters, leads, contacts, reports, assessments, qualifications, verifications, services, serviceMatches, points, sources, discoverySources, contactFilter, textFilter, sort, asOfMs]);

  const selected = selectedSnapshot ? rows.find((row) => row.lead.id === selectedSnapshot.lead.id) ?? selectedSnapshot : null;

  const targets = filters ? leadTargets(filters.requested_count, filters.website_percent, filters.lead_category) : { website: 0, automation: 0 };
  const indiaOnly = filters?.countries.length === 1 && filters.countries[0] === "India";
  const mixedPipelines = Boolean(filters?.countries.includes("India") && filters.countries.length > 1);
  const countryPlan = filters ? allocateCountryTargets(filters.requested_count, filters.countries) : [];
  const evaluated = rows.map((row) => {
    const latest = serviceMatches.filter((match) => match.lead_id === row.lead.id && Date.parse(match.assessed_at) > asOfMs - 90 * 86400000)
      .filter((match, index, all) => all.findIndex((item) => item.service_id === match.service_id) === index)
      .map((match) => ({ ...match, service_key: services.find((service) => service.id === match.service_id)?.service_key ?? "",
        evidence_ids: match.evidence_ids.every((id) => leadEvidence.some((evidence) => evidence.id === id
          && evidence.lead_id === row.lead.id && evidence.reviewed_by
          && Date.parse(evidence.observed_at) > asOfMs - 90 * 86400000 && evidenceUrl(evidence.source_url))) ? match.evidence_ids : [] }));
    return { row, opportunity: classifyLeadOpportunity({ website_url: row.lead.website_url,
      assessment_status: row.assessment && Date.parse(row.assessment.observed_at) > asOfMs - 90 * 86400000 ? row.assessment.status : null,
      matches: latest }) };
  });
  const priorityOf = (item: typeof evaluated[number]) => item.opportunity.match
    ? opportunityPriority({ category: item.opportunity.category, match_confidence: item.opportunity.match.confidence,
      reviewed_evidence_count: Math.max(1, item.opportunity.match.evidence_ids.length),
      has_sourced_email: item.row.points.some((point) => point.kind === "email" && point.review_status !== "rejected" && sources.some((source) => source.point_id === point.id))
        || item.row.crmContacts.some((contact) => contact.email_normalized && contact.source_url),
      has_sourced_phone: item.row.points.some((point) => point.kind === "phone" && point.review_status !== "rejected" && sources.some((source) => source.point_id === point.id))
        || item.row.crmContacts.some((contact) => contact.phone_e164 && contact.source_url) }) : 0;
  const rankCategory = (a: typeof evaluated[number], b: typeof evaluated[number]) => sort === "name"
    ? a.row.lead.business_name.localeCompare(b.row.lead.business_name)
    : priorityOf(b) - priorityOf(a)
      || a.row.lead.business_name.localeCompare(b.row.lead.business_name);
  const websiteResults = evaluated.filter((item) => item.opportunity.category === "website" && item.opportunity.qualified
    && industryMatches(item.row.lead.business_category, filters?.website_industries ?? [])).sort(rankCategory).slice(0, indiaOnly ? filters!.requested_count : targets.website);
  const automationResults = evaluated.filter((item) => item.opportunity.category === "automation" && item.opportunity.qualified
    && industryMatches(item.row.lead.business_category, filters?.automation_industries ?? [])).sort(rankCategory).slice(0, indiaOnly ? filters!.requested_count : targets.automation);
  const websiteResearch = evaluated.filter((item) => item.row.assessment?.status === "NO_OFFICIAL_WEBSITE_DISCOVERED" && !item.row.lead.website_url
    && item.opportunity.category !== "website" && industryMatches(item.row.lead.business_category, filters?.website_industries ?? []));
  const automationResearch = evaluated.filter((item) => item.opportunity.category === "automation" && !item.opportunity.qualified
    && industryMatches(item.row.lead.business_category, filters?.automation_industries ?? []));
  const visibleRows = (resultGroup === "website" ? websiteResults : automationResults).map((item) => item.row);
  const qualifiedRows = [...websiteResults, ...automationResults].map((item) => item.row);
  const sourcedEmails = new Set(qualifiedRows.flatMap((row) => [
    ...row.points.filter((point) => point.kind === "email" && point.review_status !== "rejected"
      && sources.some((source) => source.point_id === point.id)).map((point) => `${row.lead.id}:${point.normalized_value}`),
    ...row.crmContacts.filter((contact) => contact.email_normalized && contact.source_url)
      .map((contact) => `${row.lead.id}:${contact.email_normalized}`),
  ]));
  const contactSourceStats = new Map<string, { emails: number; exclusive: number; corroborated: number }>();
  for (const row of rows) for (const point of row.points) {
    if (point.kind !== "email" || point.review_status === "rejected") continue;
    const providers = [...new Set(sources.filter((source) => source.point_id === point.id).map((source) => source.source_provider))];
    for (const provider of providers) {
      const counts = contactSourceStats.get(provider) ?? { emails: 0, exclusive: 0, corroborated: 0 };
      counts.emails++;
      if (providers.length === 1) counts.exclusive++;
      else counts.corroborated++;
      contactSourceStats.set(provider, counts);
    }
  }

  function changeCountry(country: string, selected: boolean) {
    if (!filters) return;
    const countries = selected ? [...filters.countries, country] : filters.countries.filter((item) => item !== country);
    if (!countries.length) return;
    setFilters({ ...filters, countries, country: countries[0] });
    setSearchActive(false);
  }

  function moveCountry(index: number, direction: -1 | 1) {
    if (!filters || index + direction < 0 || index + direction >= filters.countries.length) return;
    const countries = [...filters.countries];
    [countries[index], countries[index + direction]] = [countries[index + direction], countries[index]];
    setFilters({ ...filters, countries, country: countries[0] });
    setSearchActive(false);
  }

  async function saveWeeklyPlan() {
    if (!supabase || !orgId || demo || role !== "admin") return;
    const client = supabase;
    setBusy(true); setError(""); setNotice("");
    try {
      weeklyMarketForDate(new Date(), weeklyPlan.timezone, weeklyPlan.countries);
      if (![weeklyPlan.website, weeklyPlan.automation, weeklyPlan.india].every((value) => Number.isInteger(value) && value >= 0 && value <= 500)
        || weeklyPlan.website + weeklyPlan.automation < 1 || weeklyPlan.website + weeklyPlan.automation > 500)
        throw new Error("Daily targets must be whole numbers; international total must be 1–500.");
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || !auth.user) throw new Error("Sign in again before saving the plan.");
      const planFields = {
        weekly_countries: weeklyPlan.countries, weekly_timezone: weeklyPlan.timezone,
        weekly_fallback_enabled: weeklyPlan.fallback, daily_website_target: weeklyPlan.website,
        daily_automation_target: weeklyPlan.automation, daily_india_manual_target: weeklyPlan.india,
        updated_by: auth.user.id, updated_at: new Date().toISOString(),
      };
      const result = targeting
        ? await client.from("discovery_targeting").update(planFields).eq("org_id", orgId).select("org_id").single()
        : await client.from("discovery_targeting").insert({ org_id: orgId, ...planFields }).select("org_id").single();
      const updateError = result.error;
      if (updateError) throw new Error("Weekly plan was not saved. Check organization permissions and migration state.");
      await refresh();
      setNotice("Weekly targeting plan saved. No provider, schedule or outreach was activated.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Weekly plan could not be saved."); }
    finally { setBusy(false); }
  }

  function interpret() {
    setError(""); setNotice(""); setSearchActive(false); setSelected(null);
    try { setFilters(applyWeeklyPrimary(parseVibeRequest(request))); }
    catch (cause) { setFilters(null); setError(cause instanceof Error ? cause.message : "Could not interpret request."); }
  }

  function applyWeeklyPrimary(parsed: VibeFilters): VibeFilters {
    if (parsed.mode !== "discover_new" || mentionedDiscoveryCountries(request).length) return parsed;
    const market = weeklyMarketForDate(new Date(), weeklyPlan.timezone, weeklyPlan.countries).today;
    return { ...parsed, country: market, countries: [market] };
  }

  async function interpretWithGroq() {
    if (!supabase || !orgId || !request.trim()) return;
    setBusy(true); setError(""); setNotice(""); setSearchActive(false); setSelected(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("vibe-interpret", { body: { org_id: orgId, request } });
      if (invokeError || !data?.filters) throw new Error("Groq interpretation is unavailable or its approved free-tier budget is disabled. Use local interpretation.");
      setFilters(applyWeeklyPrimary(data.filters as VibeFilters));
      setNotice("Groq proposed filters. Review and edit every field before searching; this has not searched or contacted anyone.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Groq interpretation failed."); }
    finally { setBusy(false); }
  }

  async function queueDiscovery() {
    if (!filters || !supabase || !orgId) return;
    if (filters.countries.length !== 1 || !filters.city || filters.region) { setError("Choose one country and city, without a region filter, for the existing bounded worker."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const batch = Math.min(3, filters.requested_count);
      const { data, error: rpcError } = await supabase.rpc("request_serper_discovery", {
        p_org: orgId, p_industry: filters.industry, p_city: filters.city,
        p_country: filters.country, p_limit: batch,
      });
      if (rpcError) throw new Error("Discovery request blocked by targeting or credit policy. No provider request was made.");
      setNotice(`Serper batch ${String(data).slice(0, 8)} queued for at most ${batch} observations. No outreach is authorized; the worker remains separately gated.`);
      setCreditConsent(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Discovery could not be queued."); }
    finally { setBusy(false); }
  }

  async function queueCampaign() {
    if (!filters || !supabase || !orgId) return;
    if (filters.countries.includes("India")) { setError("India manual-calling discovery is separate from the international 70/30 campaign. No provider request was made."); return; }
    if (filters.countries.length !== 1 || !filters.city || filters.region) { setError("Multi-country or region-targeted campaigns require a reviewed database change; no provider request was made."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const maxCredits = Math.min(15, creditCap - reservedCredits);
      const { data, error: rpcError } = await supabase.rpc("request_discovery_campaign", {
        p_org: orgId, p_industry: filters.industry, p_city: filters.city, p_country: filters.country,
        p_count: filters.requested_count, p_website_percent: filters.website_percent, p_max_credits: maxCredits,
      });
      if (rpcError) throw new Error("Discovery campaign was blocked by targeting or credit policy. No provider request was made.");
      setNotice(`Bounded campaign ${String(data).slice(0, 8)} queued for at most ${maxCredits} search credits. Results require separate evidence and service review.`);
      setCreditConsent(false);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Discovery could not be queued."); }
    finally { setBusy(false); }
  }

  async function cancelCampaign(id: string) {
    if (!supabase || !orgId) return;
    setBusy(true); setError("");
    try {
      const { error: rpcError } = await supabase.rpc("cancel_discovery_campaign", { p_org: orgId, p_campaign: id });
      if (rpcError) throw new Error("Campaign cancellation failed. Refresh its status before further requests.");
      setNotice("Campaign cancelled. A leased search may already have consumed its reserved credit; no further pages will be queued.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel campaign."); }
    finally { setBusy(false); }
  }

  async function processCampaignPage(id: string) {
    if (!supabase || !orgId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("serper-discovery-step", {
        body: { org_id: orgId, campaign_id: id },
      });
      if (invokeError || !data || data.failed) throw new Error("The bounded discovery step is disabled or failed. Review status and credit usage before retrying.");
      setNotice(data.processed ? "One bounded search page completed. Review candidate evidence and credits before the next page." : "No page was ready. Refresh status before trying again.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Discovery step is unavailable."); }
    finally { setBusy(false); }
  }

  async function queueContactDiscovery() {
    if (!selected || !supabase || !orgId || !contactCreditConsent) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { data, error: rpcError } = await supabase.rpc("request_vibe_contact_discovery", {
        p_org: orgId, p_lead: selected.lead.id, p_force: false,
      });
      if (rpcError) throw new Error("Contact discovery was blocked by official-site review, targeting or the credit cap. No provider request was made.");
      setNotice(`Public contact search ${String(data).slice(0, 8)} queued or a recent result reused. The worker is separately gated; no email will be sent.`);
      setContactCreditConsent(false);
      await refresh();
      setSelected(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Contact discovery could not be queued."); }
    finally { setBusy(false); }
  }

  async function advanceSelectedLead() {
    if (!selected || !supabase || !orgId || role !== "admin") return;
    const client = supabase;
    const lead = selected.lead;
    const reviewedIdentitySources = new Set(leadEvidence.filter((item) => item.lead_id === lead.id && item.reviewed_by && item.source_url)
      .map((item) => item.source_url));
    const approvedEmails = new Set(selected.points.filter((point) => point.kind === "email" && point.review_status === "approved")
      .map((point) => point.normalized_value));
    const emailContacts = selected.crmContacts.filter((item) => item.email_normalized &&
      (approvedEmails.has(item.email_normalized) || leadEvidence.some((evidence) =>
        evidence.lead_id === lead.id && evidence.reviewed_by && evidence.source_url === item.source_url)));
    const preferred = points.find((point) => point.lead_id === lead.id && point.kind === "email" && point.preferred && point.review_status === "approved");
    const contact = emailContacts.length === 1 ? emailContacts[0] : emailContacts.find((item) => item.email_normalized === preferred?.normalized_value);
    const currentReport = reports.find((item) => item.lead_id === lead.id && item.contact_id === contact?.id && Date.parse(item.expires_at) > asOfMs);
    const latestPermission = contact ? consents.find((item) => item.contact_id === contact.id) : null;
    const currentVerification = contact ? verifications.find((item) => item.contact_id === contact.id && Date.parse(item.expires_at) > asOfMs) : null;
    const match = serviceMatches.find((item) => item.lead_id === lead.id && item.status === "verified_gap" &&
      item.evidence_ids.some((id) => leadEvidence.some((evidence) => evidence.id === id && evidence.reviewed_by)));
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await advanceLeadWorkflow({
        country: lead.country ?? "", leadStatus: lead.status, identityReviewed: reviewedIdentitySources.size >= 2,
        websiteStatus: selected.assessment?.status ?? null, serviceGapReviewed: !!match,
        qualificationStatus: selected.qualification?.status ?? null,
        sourcedEmailCount: Math.max(emailContacts.length,
          selected.points.filter((point) => point.kind === "email" && point.review_status !== "rejected").length),
        contactId: contact?.id ?? null, verificationStatus: currentVerification?.status ?? null,
        verificationReviewed: !!currentVerification?.reviewed_at,
        reportId: currentReport?.id ?? null, reportReady: currentReport?.state === "ready",
        permissionRecorded: !!latestPermission && ["permitted", "opted_in"].includes(latestPermission.state) && !latestPermission.revoked_at,
        draftId: drafts.find((item) => item.report_id === currentReport?.id && item.contact_id === contact?.id)?.draft_id ?? null,
      }, {
        requestVibe: async () => {
          const { error } = await client.rpc("request_vibe_contact_discovery", { p_org: orgId, p_lead: lead.id, p_force: false });
          if (error) throw new Error("VIBE_REQUEST_BLOCKED");
          return "queued";
        },
        evaluateQualification: async () => {
          const { data: id, error } = await client.rpc("evaluate_lead_qualification", { p_org: orgId, p_lead: lead.id });
          if (error || !id) throw new Error("QUALIFICATION_EVALUATION_BLOCKED");
          const saved = await client.from("lead_qualifications").select("status").eq("org_id", orgId).eq("id", id).single();
          if (saved.error || !saved.data) throw new Error("QUALIFICATION_RESULT_UNAVAILABLE");
          return saved.data.status;
        },
        requestVerification: async (contactId) => {
          const { data, error } = await client.functions.invoke("email-verification-request", { body: { org_id: orgId, contact_ids: [contactId], force: false } });
          if (error || data?.error || data?.results?.[0]?.state === "REQUEST_REJECTED") throw new Error("VERIFICATION_REQUEST_BLOCKED");
          return "queued";
        },
        requestResearch: async (contactId) => {
          const { data, error } = await client.functions.invoke("business-research-request", { body: { org_id: orgId, lead_id: lead.id, contact_id: contactId, force: false } });
          if (error || data?.error) throw new Error("RESEARCH_REQUEST_BLOCKED");
          if (data?.data?.state === "cached" && data?.data?.report_id) {
            const saved = await client.from("business_research_reports").select("state").eq("org_id", orgId).eq("id", data.data.report_id).single();
            if (saved.error || !saved.data) throw new Error("RESEARCH_RESULT_UNAVAILABLE");
            return { state: "cached" as const, reportId: data.data.report_id, ready: saved.data.state === "ready" };
          }
          return { state: "queued" as const };
        },
        createDraft: async (reportId, contactId) => {
          const { data, error } = await client.functions.invoke("personalized-draft", { body: { org_id: orgId, report_id: reportId, contact_id: contactId, language: "en" } });
          if (error || data?.error || !data?.draft_id) throw new Error("PERSONALIZED_DRAFT_BLOCKED");
          return data.draft_id;
        },
      }, {
        vibe: !!targeting?.vibe_contact_discovery_enabled && contactCreditConsent,
        verification: process.env.NEXT_PUBLIC_ENABLE_EMAIL_VERIFICATION === "true",
        research: process.env.NEXT_PUBLIC_ENABLE_RESEARCH === "true",
        ai: process.env.NEXT_PUBLIC_ENABLE_PERSONALIZED_AI === "true",
      });
      if (result.completed.includes("vibe_requested")) setContactCreditConsent(false);
      setNotice(`${result.reason.replaceAll("_", " ")}. ${result.completed.length ? `Completed: ${result.completed.join(", ")}.` : "No operation was started."} No email was sent.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Lead workflow could not advance."); }
    finally { setBusy(false); }
  }

  async function approveContact() {
    if (!selected?.candidate?.email || !selected.reportId || !supabase) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: rpcError } = await supabase.rpc("approve_vibe_contact_candidate", {
        p_org: orgId, p_report: selected.reportId, p_name: selected.candidate.full_name,
        p_email: selected.candidate.email, p_note: reviewNote,
      });
      if (rpcError) throw new Error("Contact review was blocked. Confirm the official website evidence and that this address is not already in CRM.");
      await refresh();
      setReviewNote(""); setNotice("Sourced contact added to CRM. Inbox verification and recipient permission are still required before outreach.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Contact review failed."); }
    finally { setBusy(false); }
  }

  async function reviewPoint(point: ContactPoint, decision: "approve" | "reject") {
    if (!supabase || !orgId || reviewNote.trim().length < 20) return;
    setBusy(true); setError("");
    try {
      const { error: rpcError } = await supabase.rpc("review_vibe_contact_point", {
        p_org: orgId, p_point: point.id, p_decision: decision, p_type: point.kind === "email" ? emailType : "unknown", p_note: reviewNote,
      });
      if (rpcError) throw new Error("Review was blocked. Recheck business identity, evidence and duplicate ownership before retrying.");
      await refresh(); setSelected(null); setReviewNote("");
      setNotice(decision === "approve" ? "Contact saved to CRM without consent or sending permission." : "Contact evidence rejected; source history retained.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Contact review failed."); }
    finally { setBusy(false); }
  }

  async function preferPoint(point: ContactPoint) {
    if (!supabase || !orgId) return;
    setBusy(true); setError("");
    try {
      const { error: rpcError } = await supabase.rpc("set_vibe_preferred_email", { p_org: orgId, p_point: point.id });
      if (rpcError) throw new Error("Only an approved email can become preferred.");
      await refresh(); setSelected(null); setNotice("Preferred email saved for future manual selection. No draft or send was started.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Preference update failed."); }
    finally { setBusy(false); }
  }

  function exportCsv() {
    if (demo || role !== "admin" || !visibleRows.length) return;
    const columns = ["Business", "Opportunity category", "Opportunity status", "Category priority", "Recommended service", "Service evidence", "Email", "Email source providers", "Source URLs", "Email review", "Technical verification", "Preferred", "Phone", "City", "Website", "CRM qualification"];
    const values = visibleRows.flatMap((row) => {
      const emails = row.points.filter((point) => point.kind === "email" && point.review_status !== "rejected");
      const allEmails = [...new Set([...emails.map((point) => point.normalized_value), ...row.crmContacts.flatMap((entry) => entry.email_normalized ? [entry.email_normalized] : [])])];
      return (allEmails.length ? allEmails : [null]).map((address) => {
        const point = emails.find((entry) => entry.normalized_value === address);
        const crm = row.crmContacts.find((entry) => entry.email_normalized === address);
        const signal = crm ? verifications.find((entry) => entry.contact_id === crm.id && Date.parse(entry.expires_at) > asOfMs) : null;
        const selectedItem = (resultGroup === "website" ? websiteResults : automationResults).find((item) => item.row.lead.id === row.lead.id);
        const opportunity = selectedItem?.opportunity;
        const service = services.find((item) => item.service_key === opportunity?.match?.service_key);
        return [row.lead.business_name, resultGroup, opportunity?.qualification_status ?? "", selectedItem ? priorityOf(selectedItem) : "", resultGroup === "website" ? websiteServiceLabel(row.lead.business_category) : service?.name ?? "Review service", opportunity?.match?.reason ?? "",
          address ?? "Email Not Found",
        point ? [...new Set(sources.filter((source) => source.point_id === point.id).map((source) => source.source_provider))].join("; ") : "",
        point ? [...new Set(sources.filter((source) => source.point_id === point.id).map((source) => source.source_url))].join("; ") : crm?.source_url ?? "",
        point?.review_status ?? "CRM recorded", signal?.status ?? "not checked", point?.preferred ? "yes" : "no",
        [...new Set([...row.points.filter((entry) => entry.kind !== "email" && entry.review_status !== "rejected").map((entry) => entry.display_value),
          ...row.crmContacts.flatMap((entry) => entry.phone_e164 ? [entry.phone_e164] : [])])].join("; "),
        row.lead.city, row.lead.website_url, row.qualification?.status ?? "RESEARCH_NEEDED"];
      });
    });
    const csv = [columns, ...values].map((line) => line.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "chaincraft-reviewed-prospects.csv"; link.click(); URL.revokeObjectURL(url);
  }

  let weeklyStatus: ReturnType<typeof weeklyMarketForDate> | null = null;
  try { weeklyStatus = weeklyMarketForDate(new Date(), weeklyPlan.timezone, weeklyPlan.countries); }
  catch { weeklyStatus = null; }
  const localDay = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: weeklyPlan.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  const today = weeklyStatus ? localDay(new Date().toISOString()) : "";
  const freshnessCutoff = Date.now() - 90 * 86400000;
  const daily = { website: 0, automation: 0, india: 0 };
  const counted = new Set<string>();
  for (const lead of leads) {
    if (!weeklyStatus || !lead.created_at || lead.status === "disqualified" || localDay(lead.created_at) !== today) continue;
    const country = canonicalDiscoveryCountry(lead.country ?? "");
    if (country !== weeklyStatus.today && country !== "India") continue;
    const qualification = qualifications.find((item) => item.lead_id === lead.id);
    if (qualification?.status !== "QUALIFIED" || localDay(qualification.evaluated_at) !== today) continue;
    const key = `${country}:${lead.city?.trim().toLowerCase()}:${lead.business_name.trim().toLowerCase()}`;
    if (counted.has(key)) continue;
    const assessment = assessments.find((item) => item.lead_id === lead.id);
    const latestMatches = serviceMatches.filter((match) => match.lead_id === lead.id && Date.parse(match.assessed_at) > freshnessCutoff)
      .filter((match, index, all) => all.findIndex((item) => item.service_id === match.service_id) === index)
      .map((match) => ({ ...match, service_key: services.find((service) => service.id === match.service_id)?.service_key ?? "",
        evidence_ids: match.evidence_ids.every((id) => leadEvidence.some((evidence) => evidence.id === id && evidence.lead_id === lead.id
          && evidence.reviewed_by && Date.parse(evidence.observed_at) > freshnessCutoff && evidenceUrl(evidence.source_url))) ? match.evidence_ids : [] }));
    const opportunity = classifyLeadOpportunity({ website_url: lead.website_url,
      assessment_status: assessment && Date.parse(assessment.observed_at) > freshnessCutoff ? assessment.status : null, matches: latestMatches });
    if (!opportunity.qualified) continue;
    const hasSourcedPhone = points.some((point) => point.lead_id === lead.id && point.kind === "phone" && point.review_status !== "rejected"
      && sources.some((source) => source.point_id === point.id && evidenceUrl(source.source_url)));
    counted.add(key);
    if (country === "India") { if (hasSourcedPhone) daily.india++; }
    else if (opportunity.category === "website") daily.website++;
    else if (opportunity.category === "automation") daily.automation++;
  }

  const overtureKnownLeads = useMemo(() => {
    const byLead = new Map<string, { emails: string[]; phones: string[] }>();
    for (const contact of contacts) {
      const values = byLead.get(contact.lead_id) ?? { emails: [], phones: [] };
      if (contact.email_normalized) values.emails.push(contact.email_normalized);
      if (contact.phone_e164) values.phones.push(contact.phone_e164);
      byLead.set(contact.lead_id, values);
    }
    return leads.map((lead) => ({ id: lead.id, business_name: lead.business_name,
      city: lead.city, state_region: lead.state_region, country: lead.country, website_url: lead.website_url,
      ...(byLead.get(lead.id) ?? { emails: [], phones: [] }) }));
  }, [leads, contacts]);

  return <div className="research-workspace">
    <div className="safety-banner"><span><ShieldCheck size={16}/> Public evidence is a lead for review, not permission to contact someone.</span><span>{demo ? "Demo · no live search" : "Owner workspace"}</span></div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <section className="panel" aria-label="Weekly discovery plan">
      <div className="panel-heading"><h2>Weekly discovery plan</h2><span className="status">Planning only · scheduled research off</span></div>
      {weeklyStatus ? <p>Today ({weeklyStatus.weekday}, {weeklyStatus.timezone}): <strong>{weeklyStatus.today}</strong> · Next: <strong>{weeklyStatus.next}</strong> · International target {weeklyPlan.website + weeklyPlan.automation} ({weeklyPlan.website} website / {weeklyPlan.automation} automation) · India manual calling target {weeklyPlan.india} daily · Combined target {weeklyPlan.website + weeklyPlan.automation + weeklyPlan.india}</p>
        : <p role="alert">Choose a valid timezone and seven approved international markets.</p>}
      {weeklyStatus && <p>New, reviewed CRM qualifications today (first 1,000 loaded records): {daily.website}/{weeklyPlan.website} website · {daily.automation}/{weeklyPlan.automation} automation · {daily.india}/{weeklyPlan.india} India with sourced phone. Combined {daily.website + daily.automation + daily.india}/{weeklyPlan.website + weeklyPlan.automation + weeklyPlan.india}; shortfall {Math.max(0, weeklyPlan.website - daily.website) + Math.max(0, weeklyPlan.automation - daily.automation) + Math.max(0, weeklyPlan.india - daily.india)}. These are CRM counts, not provider search observations.</p>}
      <div className="research-controls"><label>Schedule timezone<input aria-label="Schedule timezone" value={weeklyPlan.timezone} onChange={(event) => setWeeklyPlan({ ...weeklyPlan, timezone: event.target.value })} /></label>
        <label>Website / day<input aria-label="Website daily target" type="number" min={0} max={500} value={weeklyPlan.website} onChange={(event) => setWeeklyPlan({ ...weeklyPlan, website: Number(event.target.value) })} /></label>
        <label>Automation / day<input aria-label="Automation daily target" type="number" min={0} max={500} value={weeklyPlan.automation} onChange={(event) => setWeeklyPlan({ ...weeklyPlan, automation: Number(event.target.value) })} /></label>
        <label>India manual calls / day<input aria-label="India manual daily target" type="number" min={0} max={500} value={weeklyPlan.india} onChange={(event) => setWeeklyPlan({ ...weeklyPlan, india: Number(event.target.value) })} /></label></div>
      <div className="research-controls">{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) =>
        <label key={day}>{day}<select aria-label={`${day} country`} value={weeklyPlan.countries[index]} onChange={(event) => {
          const countries = [...weeklyPlan.countries]; countries[index] = event.target.value; setWeeklyPlan({ ...weeklyPlan, countries });
        }}>{SELECTABLE_DISCOVERY_COUNTRIES.filter((country) => country !== "India").map((country) => <option key={country} value={country}>{country}</option>)}</select></label>)}</div>
      <label><input type="checkbox" checked={weeklyPlan.fallback} onChange={(event) => setWeeklyPlan({ ...weeklyPlan, fallback: event.target.checked })} /> Allow a different approved international market only when the primary market has a verified shortfall</label>
      <div className="button-row"><button className="secondary" disabled={busy || demo || role !== "admin"} onClick={() => void saveWeeklyPlan()}>Save weekly plan</button></div>
      <p className="muted">Targets are not qualified results. Existing campaigns still require an owner step, independent provider flag and credit budget; no daily scheduler is active. India stays separate for personal calling.</p>
    </section>
    <OvertureReview demo={demo} orgId={orgId} role={role} knownLeads={overtureKnownLeads} onPromoted={refresh} />
    <section className="panel">
      <div className="panel-heading"><h2>Vibe Prospecting</h2><span className="status">Free-first · human reviewed</span></div>
      <p>Find and cross-check public business contacts already discovered by Serper, Harvey or CRM. New-business discovery is a separate optional mode.</p>
      <label htmlFor="vibe-request">Prospect request</label>
      <textarea id="vibe-request" value={request} onChange={(event) => setRequest(event.target.value)} maxLength={1000} rows={3} placeholder="Find 10 dental practices in Austin, USA; research public contacts and review website or automation opportunities." />
      <div className="button-row"><button className="primary" onClick={interpret} disabled={demo || role !== "admin"}>Interpret request locally</button>{process.env.NEXT_PUBLIC_ENABLE_VIBE_AI === "true" && <button className="secondary" onClick={() => void interpretWithGroq()} disabled={busy || demo || role !== "admin"}>Suggest filters with Groq</button>}</div>
      <p className="muted">Local interpretation uses no model call or search credit. Groq interpretation requires a separately enabled server flag and approved organization budget.</p>
      {filters && <div className="verification-record">
        <h3>Review search filters</h3>
        <div className="research-controls">
          <label>Mode<select value={filters.mode} onChange={(event) => setFilters({ ...filters, mode: event.target.value as VibeFilters["mode"] })}><option value="enrich_existing">Enrich existing leads</option><option value="discover_new">Discover new businesses</option></select></label>
          <label>Industry<input value={filters.industry ?? ""} onChange={(event) => setFilters({ ...filters, industry: event.target.value || null })} /></label>
          <label>City<input value={filters.city ?? ""} onChange={(event) => setFilters({ ...filters, city: event.target.value || null })} /></label>
          <label>State / province / emirate<input value={filters.region ?? ""} onChange={(event) => setFilters({ ...filters, region: event.target.value || null })} /></label>
          <label>Requested prospects<input type="number" min={1} max={500} value={filters.requested_count} onChange={(event) => setFilters({ ...filters, requested_count: Number(event.target.value) })} /></label>
          <label>Lead mix<select value={filters.lead_category} disabled={indiaOnly} onChange={(event) => setFilters({ ...filters, lead_category: event.target.value as VibeFilters["lead_category"] })}><option value="mixed">Website + automation</option><option value="website">Website only</option><option value="automation">Automation only</option></select></label>
          {filters.lead_category === "mixed" && !indiaOnly && <label>Website target %<input type="number" min={0} max={100} value={filters.website_percent} onChange={(event) => setFilters({ ...filters, website_percent: Number(event.target.value) })} /></label>}
          <label>Website-category industries<input value={filters.website_industries.join(", ")} onChange={(event) => setFilters({ ...filters, website_industries: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="Any, or comma-separated" /></label>
          <label>Automation-category industries<input value={filters.automation_industries.join(", ")} onChange={(event) => setFilters({ ...filters, automation_industries: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} placeholder="Any, or comma-separated" /></label>
          <label>Decision-maker role<input value={filters.decision_maker_role ?? ""} onChange={(event) => setFilters({ ...filters, decision_maker_role: event.target.value || null })} /></label>
          <label>Website/service criterion<select value={filters.website_criterion} onChange={(event) => setFilters({ ...filters, website_criterion: event.target.value as VibeFilters["website_criterion"] })}><option value="any">Any; review evidence</option><option value="missing_or_broken">No official website found after reviewed checks</option><option value="improvement">Verified technical problem (outside Category A)</option><option value="ecommerce_opportunity">E-commerce opportunity; requires review</option></select></label>
        </div>
        <fieldset><legend>Countries in priority order</legend>
          {SELECTABLE_DISCOVERY_COUNTRIES.map((country) => {
            const index = filters.countries.indexOf(country);
            return <div className="button-row" key={country}>
              <label><input type="checkbox" checked={index >= 0} onChange={(event) => changeCountry(country, event.target.checked)} /> {country}</label>
              {index >= 0 && <><button className="secondary" type="button" disabled={index === 0} onClick={() => moveCountry(index, -1)} aria-label={`Move ${country} higher`}>↑</button>
                <button className="secondary" type="button" disabled={index === filters.countries.length - 1} onClick={() => moveCountry(index, 1)} aria-label={`Move ${country} lower`}>↓</button></>}
            </div>;
          })}
        </fieldset>
        <label><input type="checkbox" checked={filters.require_public_email} onChange={(event) => setFilters({ ...filters, require_public_email: event.target.checked })} /> Require a sourced public email</label>
        {filters.needs_review.length > 0 && <p className="muted">Interpretation needs review: {filters.needs_review.join(" ")}</p>}
        <p className="muted">{indiaOnly ? "India manual-calling research has no 70/30 service quota. Review the separate CRM calling queue; no automated outreach is permitted." : `Target: ${targets.website} reviewed no-official-website leads and ${targets.automation} evidence-supported automation leads. A shortfall stays unfilled.`}</p>
        {mixedPipelines && <p role="alert" className="error">India and international discovery are separate pipelines. Select India alone or remove India before queueing a campaign.</p>}
        <p className="muted">Priority allocation: {countryPlan.map((item) => `${item.country} ${item.target}`).join(" · ")}. {filters.mode === "discover_new" ? "India is selectable but excluded from new discovery by default." : "Existing CRM enrichment includes historical India records unless you filter them out."}</p>
        <button className="primary" disabled={filters.requested_count < 1 || filters.requested_count > 500 || filters.website_percent < 0 || filters.website_percent > 100} onClick={() => { setSearchActive(true); setPage(0); setContactPage(0); setSelected(null); }}>Search stored prospects <Search size={16}/></button>
        <p className="muted">Workspace search spends no credits and does not require a website gap. Contact enrichment runs separately from optional sales qualification.</p>
        {(filters.countries.length > 1 || filters.region) && <p className="muted">Country and region filters work for stored research. The existing provider worker accepts one country and city, without a region filter; broader scheduling remains disabled pending a reviewed migration and approval.</p>}
        {filters.mode === "discover_new" && (campaignsEnabled ? <><label><input type="checkbox" checked={creditConsent} onChange={(event) => setCreditConsent(event.target.checked)} /> I approve reserving up to {Math.min(15, Math.max(0, creditCap - reservedCredits))} Serper search credits for this bounded campaign.</label>
        <button className="secondary" disabled={busy || !creditConsent || indiaOnly || mixedPipelines || filters.countries.length !== 1 || !!filters.region || !filters.industry || !filters.city || filters.requested_count < 1 || filters.requested_count > 100 || !targeting?.serper_discovery_enabled || targeting.max_new_prospects < filters.requested_count || creditCap - reservedCredits < 1 || campaigns.some((item) => ["queued", "running"].includes(item.state))} onClick={() => void queueCampaign()}>Queue bounded discovery campaign</button></> : <><label><input type="checkbox" checked={creditConsent} onChange={(event) => setCreditConsent(event.target.checked)} /> I approve reserving up to 31 Serper credits for one discovery batch.</label>
        <button className="secondary" disabled={busy || !creditConsent || mixedPipelines || filters.countries.length !== 1 || !!filters.region || !filters.industry || !filters.city || filters.requested_count < 1 || filters.requested_count > 100 || !targeting?.serper_discovery_enabled || targeting.max_new_prospects < Math.min(3, filters.requested_count) || creditCap - reservedCredits < 31} onClick={() => void queueDiscovery()}>Queue up to {Math.min(3, filters.requested_count)} Serper observations</button></>)}
        <p className="muted">Current organization cap: {creditCap}; reserved this month: {reservedCredits}. {targeting?.serper_discovery_enabled ? "Targeting is configured; the worker has an independent off-by-default switch." : "Discovery targeting is disabled."} This never sends email.</p>
        <div className="button-row"><button className="secondary" onClick={() => void refresh().catch((cause) => setError(cause.message))} disabled={busy}>Refresh discovery status</button></div>
        {runs.map((run) => <p className="muted" key={run.id}>Discovery {run.id.slice(0, 8)} · {run.state} · {run.observations_count}/{run.requested_limit} observations{run.last_error_code ? ` · ${run.last_error_code}` : ""}</p>)}
        {campaignsEnabled && campaigns.map((campaign) => <div className="verification-record" key={campaign.id}>
          <strong>Campaign {campaign.id.slice(0, 8)} · {campaign.target_country} · {campaign.state}</strong>
          <p>Pages searched: {campaign.pages_completed} · Candidate observations: {campaign.observations_count} · New CRM businesses: {campaign.new_businesses_count}/{campaign.target_count} · Credits reserved: {campaign.credits_reserved}/{campaign.max_credits}</p>
          {(() => { const ids = new Set(runs.filter((run) => run.campaign_id === campaign.id).map((run) => run.id));
            const leadIds = new Set(discoverySources.filter((source) => source.discovery_run_id && ids.has(source.discovery_run_id)).map((source) => source.lead_id));
            const qualified = searchActive ? evaluated.filter((item) => leadIds.has(item.row.lead.id) && item.opportunity.qualified).length : null;
            const rejected = discoveryCandidates.filter((candidate) => ids.has(candidate.discovery_run_id) && candidate.state === "discarded").length;
            return <p className="muted">Qualified in current search: {qualified ?? "search stored prospects to assess"} · Identity candidates rejected: {rejected} · Awaiting service review: {Math.max(0, leadIds.size - (qualified ?? 0))}. Unfilled targets are not counted as qualified.{campaign.last_error_code ? ` ${campaign.last_error_code}` : ""}</p>;
          })()}
          {["queued", "running"].includes(campaign.state) && <button className="secondary" disabled={busy || role !== "admin"} onClick={() => void processCampaignPage(campaign.id)}>Process next bounded page</button>}
          {["queued", "running", "paused"].includes(campaign.state) && <button className="secondary" disabled={busy || role !== "admin"} onClick={() => void cancelCampaign(campaign.id)}>Cancel campaign</button>}
        </div>)}
      </div>}
    </section>
    <section className="panel">
      {searchActive && <><p>{indiaOnly ? `Screened stored Indian businesses: ${evaluated.length} · Evidence-supported website opportunities: ${websiteResults.length} · Evidence-supported automation opportunities: ${automationResults.length} · No 70/30 quota or automated outreach` : `Screened stored businesses: ${evaluated.length} · Website leads: ${websiteResults.length}/${targets.website} · Automation leads: ${automationResults.length}/${targets.automation} · Unfilled positions: ${Math.max(0, targets.website - websiteResults.length) + Math.max(0, targets.automation - automationResults.length)}`}</p>
        <p>Country research progress: {countryPlan.map(({ country, target }) => `${country}: ${evaluated.filter((item) => canonicalDiscoveryCountry(item.row.lead.country ?? "") === country).length} stored reviewed/held candidates, ${qualifiedRows.filter((row) => canonicalDiscoveryCountry(row.lead.country ?? "") === country).length} qualified / ${target} target`).join(" · ")}. A stored candidate is not a qualified opportunity.</p>
        <p>Pending website review: {websiteResearch.length} · Pending automation review: {automationResearch.length} · Qualified leads without sourced email: {qualifiedRows.filter((row) => !row.points.some((point) => point.kind === "email" && point.review_status !== "rejected" && sources.some((source) => source.point_id === point.id)) && !row.crmContacts.some((contact) => contact.email_normalized && contact.source_url)).length} · Distinct sourced emails: {sourcedEmails.size} · Organization Serper credits reserved this month: {reservedCredits}</p>
        <p className="muted">Only owner-reviewed service matches with current source evidence count. Automation opportunities based on a researched workflow are potential and need a discovery call; no absent internal system is asserted. Existing websites do not exclude automation. Contact evidence does not verify a mailbox or permit outreach. Reserved credits are not actual provider consumption.</p></>}
      <div className="button-row" role="tablist" aria-label="Lead category"><button role="tab" aria-selected={resultGroup === "website"} className="secondary" onClick={() => { setResultGroup("website"); setPage(0); setSelected(null); }}>Website development ({websiteResults.length}{indiaOnly ? "" : `/${targets.website}`})</button><button role="tab" aria-selected={resultGroup === "automation"} className="secondary" onClick={() => { setResultGroup("automation"); setPage(0); setSelected(null); }}>AI &amp; automation ({automationResults.length}{indiaOnly ? "" : `/${targets.automation}`})</button></div>
      <div className="panel-heading"><h2>{resultGroup === "website" ? "Website development leads" : "AI & automation leads"}</h2><span className="status">{visibleRows.length} qualified</span></div>
      <div className="research-controls"><label>Filter results<input value={textFilter} onChange={(event) => { setTextFilter(event.target.value); setPage(0); setContactPage(0); }} placeholder="Business, person, email or city" /></label><label>Contact state<select value={contactFilter} onChange={(event) => { setContactFilter(event.target.value); setPage(0); setContactPage(0); }}><option value="all">All contacts</option><option value="has_email">Has email</option><option value="missing_email">Email not found</option><option value="multiple_emails">Multiple emails</option><option value="vibe_found">Found on public website</option><option value="source_disagreement">Different emails by source</option><option value="needs_verification">Needs verification</option><option value="has_phone">Has phone</option><option value="has_owner">Has named person</option></select></label><label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as "name" | "score")}><option value="score">Qualification score</option><option value="name">Business name</option></select></label><button className="secondary" disabled={!visibleRows.length || role !== "admin"} onClick={exportCsv}><Download size={15}/> Export visible authorized records</button></div>
      {demo ? <p className="muted">Sign in to search tenant-scoped CRM evidence. Demonstration data is not a prospect source.</p> : !searchActive ? <p className="muted">Interpret a request, confirm its filters, then search the stored workspace.</p> : !visibleRows.length ? <p className="muted">No reviewed businesses currently qualify for this category. The target remains unfilled; source research and owner service review are required.</p> : <>
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>Priority</th><th>Opportunity status</th><th>Recommended service</th><th>Evidence-based reason</th><th>Public emails</th><th>Phones</th><th>Named person</th><th>City</th><th>Website status</th><th>Source status</th><th>Review</th></tr></thead><tbody>{visibleRows.slice(page * 20, page * 20 + 20).map((row) => <tr key={row.lead.id}>
          <td><strong>{row.lead.business_name}</strong><br/><small>{row.lead.source_type}</small></td>
          <td>{(() => { const item = (resultGroup === "website" ? websiteResults : automationResults).find((entry) => entry.row.lead.id === row.lead.id); return item ? priorityOf(item) : ""; })()}/100</td>
          <td>{(resultGroup === "website" ? websiteResults : automationResults).find((entry) => entry.row.lead.id === row.lead.id)?.opportunity.qualification_status.replaceAll("_", " ")}</td>
          <td>{resultGroup === "website" ? websiteServiceLabel(row.lead.business_category) : services.find((item) => item.service_key === automationResults.find((entry) => entry.row.lead.id === row.lead.id)?.opportunity.match?.service_key)?.name ?? "Review"}</td>
          <td>{(resultGroup === "website" ? websiteResults : automationResults).find((entry) => entry.row.lead.id === row.lead.id)?.opportunity.match?.reason ?? ""} · <button className="secondary" onClick={() => onOpenResearch(row.lead.id)}>Evidence</button></td>
          <td>{[...new Set([...row.points.filter((point) => point.kind === "email" && point.review_status !== "rejected").map((point) => point.normalized_value), ...row.crmContacts.flatMap((entry) => entry.email_normalized ? [entry.email_normalized] : [])])].join(" · ") || "Email Not Found"}</td>
          <td>{[...new Set([...row.points.filter((point) => point.kind !== "email" && point.review_status !== "rejected").map((point) => point.display_value), ...row.crmContacts.flatMap((entry) => entry.phone_e164 ? [entry.phone_e164] : [])])].join(" · ") || "Not found"}</td>
          <td>{row.candidate?.full_name ?? row.points.find((point) => point.contact_name)?.contact_name ?? row.contact?.contact_name ?? "Not found"}</td>
          <td>{row.lead.city ?? "Unknown"}</td>
          <td>{evidenceUrl(row.lead.website_url) ? <a href={evidenceUrl(row.lead.website_url)!} target="_blank" rel="noopener noreferrer">Official website</a> : row.assessment?.status === "NO_OFFICIAL_WEBSITE_DISCOVERED" ? "No official website found after reviewed checks" : "Website unknown"}</td>
          <td>{row.points.length} distinct contact points · {row.points.filter((point) => point.review_status === "pending").length} awaiting review</td>
          <td><button className="secondary" onClick={() => { setSelected(row); setReviewNote(""); }}>Review</button></td>
        </tr>)}</tbody></table></div>
        <div className="button-row"><button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(visibleRows.length / 20)}</span><button className="secondary" disabled={(page + 1) * 20 >= visibleRows.length} onClick={() => setPage(page + 1)}>Next</button></div>
      </>}
      {searchActive && (automationResearch.length > 0 || websiteResearch.length > 0) && <p className="muted">{websiteResearch.length} no-site observations and {automationResearch.length} automation hypotheses still need owner service-gap review. They are not counted as qualified results. <button className="secondary" onClick={onOpenCRM}>Review in CRM</button></p>}
      {searchActive && rows.length > 0 && <p className="muted">Coverage in these {rows.length} stored matches: {rows.filter((row) => row.points.some((point) => point.kind === "email" && point.review_status !== "rejected" && sources.some((source) => source.point_id === point.id)) || row.crmContacts.some((contact) => contact.email_normalized && contact.source_url)).length} businesses with a sourced email; {rows.filter((row) => new Set([...row.points.filter((point) => point.kind === "email" && point.review_status !== "rejected").map((point) => point.normalized_value), ...row.crmContacts.filter((contact) => contact.email_normalized && contact.source_url).map((contact) => contact.email_normalized)]).size > 1).length} with multiple distinct emails; {rows.filter((row) => row.candidate || row.points.some((point) => point.contact_name)).length} with a named person. Source agreement does not prove mailbox ownership or marketing consent.</p>}
    </section>
    {searchActive && rows.length > 0 && <section className="panel">
      <div className="panel-heading"><h2>Contact research</h2><span className="status">{rows.length} stored businesses</span></div>
      <p className="muted">Review sourced contacts independently of service qualification. An email can be reviewed without claiming the business needs a ChainCraft service or has consented to outreach.</p>
      {contactSourceStats.size > 0 && <p className="muted">Vibe email evidence by source: {[...contactSourceStats].sort(([a], [b]) => a.localeCompare(b)).map(([provider, count]) => `${provider}: ${count.emails} sourced, ${count.exclusive} sole-source, ${count.corroborated} cross-source`).join(" · ")}. CRM contact sources are displayed separately. Counts describe source overlap, not mailbox validity.</p>}
      <div className="table-wrap"><table><thead><tr><th>Business</th><th>Public emails</th><th>Phone / WhatsApp</th><th>Evidence</th><th>Service status</th><th>Review</th></tr></thead><tbody>{rows.slice(contactPage * 20, contactPage * 20 + 20).map((row) => {
        const opportunity = evaluated.find((item) => item.row.lead.id === row.lead.id)?.opportunity;
        const emails = row.points.filter((point) => point.kind === "email" && point.review_status !== "rejected");
        return <tr key={row.lead.id}>
          <td><strong>{row.lead.business_name}</strong><br/><small>{row.lead.city ?? "Location unknown"}</small></td>
          <td>{[...new Set([...emails.map((point) => point.normalized_value), ...row.crmContacts.flatMap((entry) => entry.email_normalized ? [entry.email_normalized] : [])])].join(" · ") || "Email Not Found"}</td>
          <td>{[...new Set([...row.points.filter((point) => point.kind !== "email" && point.review_status !== "rejected").map((point) => point.display_value), ...row.crmContacts.flatMap((entry) => entry.phone_e164 ? [entry.phone_e164] : [])])].join(" · ") || "Not found"}</td>
          <td>{row.points.length} Vibe points · {row.crmContacts.filter((entry) => entry.source_url).length} CRM contacts with sources · {row.points.filter((point) => point.review_status === "pending").length} Vibe points pending review</td>
          <td>{opportunity?.qualified ? opportunity.qualification_status.replaceAll("_", " ") : "Service gap unreviewed"}</td>
          <td><button className="secondary" onClick={() => { setSelected(row); setReviewNote(""); }}>Review evidence</button></td>
        </tr>;
      })}</tbody></table></div>
      <div className="button-row"><button className="secondary" disabled={contactPage === 0} onClick={() => setContactPage(contactPage - 1)}>Previous contacts</button><span>Page {contactPage + 1} of {Math.ceil(rows.length / 20)}</span><button className="secondary" disabled={(contactPage + 1) * 20 >= rows.length} onClick={() => setContactPage(contactPage + 1)}>Next contacts</button></div>
    </section>}
    {selected && <section className="panel"><div className="panel-heading"><h2>{selected.lead.business_name} · contact review</h2><button className="secondary" onClick={() => setSelected(null)}>Close</button></div>
      {(() => {
        const currentMatch = serviceMatches.find((item) => item.lead_id === selected.lead.id && item.status === "verified_gap" &&
          item.evidence_ids.some((id) => leadEvidence.some((evidence) => evidence.id === id && evidence.reviewed_by)));
        const emails = selected.points.filter((point) => point.kind === "email" && point.review_status !== "rejected");
        const approvedEmails = new Set(selected.points.filter((point) => point.kind === "email" && point.review_status === "approved")
          .map((point) => point.normalized_value));
        const emailContacts = selected.crmContacts.filter((contact) => contact.email_normalized &&
          (approvedEmails.has(contact.email_normalized) || leadEvidence.some((evidence) =>
            evidence.lead_id === selected.lead.id && evidence.reviewed_by && evidence.source_url === contact.source_url)));
        const preferred = selected.points.find((point) => point.kind === "email" && point.preferred && point.review_status === "approved");
        const chosen = emailContacts.length === 1 ? emailContacts[0] : emailContacts.find((contact) => contact.email_normalized === preferred?.normalized_value);
        const currentReport = reports.find((item) => item.lead_id === selected.lead.id &&
          item.contact_id === chosen?.id && Date.parse(item.expires_at) > asOfMs);
        const permission = chosen ? consents.find((record) => record.contact_id === chosen.id) : null;
        const verification = chosen ? verifications.find((record) => record.contact_id === chosen.id && Date.parse(record.expires_at) > asOfMs) : null;
        const status = leadReviewReadiness({
          identityEvidenceCount: leadEvidence.filter((item) => item.lead_id === selected.lead.id).length,
          identityReviewed: new Set(leadEvidence.filter((item) => item.lead_id === selected.lead.id && item.reviewed_by && item.source_url)
            .map((item) => item.source_url)).size >= 2,
          websiteStatus: selected.assessment?.status ?? null,
          serviceGapReviewed: !!currentMatch,
          qualificationStatus: selected.qualification?.status ?? null,
          sourcedEmails: emails.length,
          reviewedEmailContacts: chosen ? 1 : 0,
          verificationStatus: verification?.status ?? null,
          verificationReviewed: !!verification?.reviewed_at,
          researchReady: currentReport?.state === "ready",
          recipientPermission: !!permission && ["permitted", "opted_in"].includes(permission.state) && !permission.revoked_at,
          draftCount: drafts.filter((draft) => draft.report_id === currentReport?.id && draft.contact_id === chosen?.id).length,
        });
        return <div className="verification-record"><h3>Lead-to-draft review</h3>
          <p>{emails.length} sourced email{emails.length === 1 ? "" : "s"} · {emailContacts.length} reviewed CRM email contact{emailContacts.length === 1 ? "" : "s"} · {status.draftPreviewAvailable ? "Saved draft requires owner review" : "No personalized draft preview"}</p>
          {emailContacts.length > 1 && !chosen && <p>Select one approved preferred email before advancing this lead.</p>}
          {status.holds.length > 0 && <p>On research hold: {status.holds.join(" · ")}. No outreach is eligible.</p>}
          <button className="secondary" disabled={busy || role !== "admin"} onClick={() => void advanceSelectedLead()}>Advance eligible steps</button>
        </div>;
      })()}
      <p>{selected.points.filter((point) => point.kind === "email" && point.review_status !== "rejected").length || "No"} distinct sourced email addresses. {selected.points.filter((point) => point.kind === "email").length > 1 ? "Keep each legitimate address until individually reviewed." : "A missing email is not permission to guess one."}</p>
      <p>Independent contact search checks reviewed official contact pages, or a reviewed public listing when no official site is confirmed. It may find additional public email addresses; it does not verify mailboxes or grant permission to send.</p>
      <label><input type="checkbox" checked={contactCreditConsent} onChange={(event) => setContactCreditConsent(event.target.checked)} /> Reserve up to 21 Serper credits for one contact-page search.</label>
      <button className="secondary" disabled={busy || role !== "admin" || !contactCreditConsent || (Boolean(selected.lead.website_url) && !["WORKING", "VERIFIED_TECHNICAL_PROBLEM"].includes(selected.assessment?.status ?? "")) || !targeting?.vibe_contact_discovery_enabled || creditCap - reservedCredits < 21} onClick={() => void queueContactDiscovery()}>Find and cross-check public emails</button>
      {!targeting?.vibe_contact_discovery_enabled && <p className="muted">Independent provider search is disabled until a bounded staging test is approved.</p>}
      {contactJobs.filter((job) => job.lead_id === selected.lead.id).slice(0, 3).map((job) => <p className="muted" key={job.id}>Contact search {job.id.slice(0, 8)} · {job.state} · {job.observations_count} public observations{job.error_code ? ` · ${job.error_code}` : ""}</p>)}
      {selected.crmContacts.filter((entry) => entry.email_normalized && !selected.points.some((point) => point.normalized_value === entry.email_normalized)).map((entry) => <p key={entry.id}>CRM-recorded email: {entry.email_normalized} · source not yet cross-checked in Vibe {evidenceUrl(entry.source_url) ? <a href={evidenceUrl(entry.source_url)!} target="_blank" rel="noopener noreferrer">View recorded source</a> : null}</p>)}
      {selected.crmContacts.filter((entry) => entry.phone_e164 && !selected.points.some((point) => point.kind !== "email" && point.normalized_value === entry.phone_e164)).map((entry) => <p key={entry.id}>CRM-recorded phone: {entry.phone_e164} · source not yet cross-checked in Vibe {evidenceUrl(entry.source_url) ? <a href={evidenceUrl(entry.source_url)!} target="_blank" rel="noopener noreferrer">View recorded source</a> : null}</p>)}
      {selected.points.map((point) => {
        const evidence = sources.filter((source) => source.point_id === point.id);
        const providers = [...new Set(evidence.map((source) => source.source_provider))];
        const contact = contacts.find((entry) => entry.lead_id === selected.lead.id && entry.email_normalized === point.normalized_value);
        const verification = contact ? verifications.find((entry) => entry.contact_id === contact.id && Date.parse(entry.expires_at) > asOfMs) : null;
        return <div className="verification-record" key={point.id}>
          <h3>{point.kind === "email" ? "Email" : point.kind === "whatsapp" ? "Explicit public WhatsApp" : "Business phone"}: {point.display_value} {point.preferred ? "· preferred" : ""}</h3>
          <p>{point.review_status} · Found in {providers.length} source{providers.length === 1 ? "" : "s"} ({providers.join(", ")}) · {evidence.some((source) => ["official_website", "vibe", "scrapling"].includes(source.source_provider) && evidence.some((other) => other.source_provider !== source.source_provider && other.source_url !== source.source_url)) ? "Cross-checked on a distinct public business page" : "Source corroboration not established"} · {verification ? `Technical signal: ${verification.status}` : "Mailbox not checked"}</p>
          {evidence.map((source) => <div key={source.id}><p>{source.source_provider} · {new Date(source.observed_at).toLocaleString()} · {evidenceUrl(source.source_url) ? <a href={evidenceUrl(source.source_url)!} target="_blank" rel="noopener noreferrer">View public source</a> : "Source unavailable"}</p><blockquote>{source.evidence_excerpt}</blockquote></div>)}
          <div className="button-row"><button className="secondary" onClick={() => void navigator.clipboard.writeText(point.display_value)}>Copy {point.kind === "email" ? "email" : "phone"}</button>
            {point.kind === "email" && point.review_status === "approved" && !point.preferred && <button className="secondary" disabled={busy} onClick={() => void preferPoint(point)}>Mark preferred</button>}</div>
          {point.review_status === "pending" && <><label>Evidence review note<input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={500} placeholder="Why this source belongs to this business" /></label>
            {point.kind === "email" && <label>Email type<select value={emailType} onChange={(event) => setEmailType(event.target.value)}><option value="unknown">Unknown</option><option value="general">General</option><option value="sales">Sales</option><option value="support">Support</option><option value="owner">Owner, evidenced</option></select></label>}
            <div className="button-row"><button className="primary" disabled={busy || reviewNote.trim().length < 20} onClick={() => void reviewPoint(point, "approve")}>Approve into CRM</button><button className="secondary" disabled={busy || reviewNote.trim().length < 20} onClick={() => void reviewPoint(point, "reject")}>Reject</button></div></>}
        </div>;
      })}
      <p>Decision-maker: {selected.candidate?.full_name ?? "Not found"} · Role: {selected.candidate?.role ?? "Not found"}</p>
      <p>Email: {selected.candidate?.email ?? "Not found"} · Status: {selected.candidate?.email_status ?? "unknown"}</p>
      {selected.candidate && <><blockquote>{selected.candidate.evidence_excerpt}</blockquote><p>Observed {new Date(selected.candidate.observed_at).toLocaleString()} · Extraction confidence {Math.round(selected.candidate.confidence * 100)}% · {evidenceUrl(selected.candidate.source_url) ? <a href={evidenceUrl(selected.candidate.source_url)!} target="_blank" rel="noopener noreferrer">Source page</a> : "Source unavailable"}</p></>}
      <p>Website assessment: {selected.assessment?.status ?? "UNKNOWN"} · {selected.assessment?.reason ?? "No reviewed service gap."}</p>
      <p>Qualification: {selected.qualification?.status ?? "RESEARCH_NEEDED"}. A public address alone does not authorize sending.</p>
      {(() => {
        const item = (resultGroup === "website" ? websiteResults : automationResults).find((entry) => entry.row.lead.id === selected.lead.id);
        const match = item?.opportunity.match;
        if (!match) return null;
        return <div className="verification-record"><h3>Recommended {resultGroup === "website" ? websiteServiceLabel(selected.lead.business_category) : services.find((service) => service.service_key === match.service_key)?.name ?? "service"}</h3>
          <p>{match.reason} · Reviewed confidence {Math.round(match.confidence * 100)}% · {item?.opportunity.qualification_status.replaceAll("_", " ")}</p>
          <p>{resultGroup === "website" ? "A professional website could give customers a direct place to review the business and enquire. The research found no official website after reviewed checks; it does not prove that none exists." : "Potential workflow fit. Whether this business already uses a suitable system remains unknown and requires a discovery conversation."}</p>
          <p>Suggested opening: {resultGroup === "website" ? "Would a short idea for your own business website be useful?" : `Would it be useful to discuss how your ${services.find((service) => service.service_key === match.service_key)?.name.toLowerCase() ?? "customer workflow"} currently works?`}</p>
          {leadEvidence.filter((evidence) => match.evidence_ids.includes(evidence.id)).map((evidence) => <p key={evidence.id}>{evidence.claim} · {evidenceUrl(evidence.source_url) ? <a href={evidenceUrl(evidence.source_url)!} target="_blank" rel="noopener noreferrer">Public source</a> : "Source unavailable"}</p>)}
        </div>;
      })()}
      {selected.candidate?.email && !selected.contact && <><label>Why the official source associates this person and address<input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} minLength={20} maxLength={500} /></label><button className="primary" disabled={busy || reviewNote.trim().length < 20} onClick={() => void approveContact()}>Approve sourced contact into CRM</button></>}
      <div className="button-row"><button className="secondary" onClick={() => onOpenResearch(selected.lead.id)}>Find more on public business pages</button><button className="secondary" onClick={onOpenVerification}>Review technical email checks</button><button className="secondary" onClick={onOpenCRM}>Open CRM</button></div>
    </section>}
  </div>;
}
