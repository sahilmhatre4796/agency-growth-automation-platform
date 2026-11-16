"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { RecordLead } from "../lib/crm-store";
import { canonicalDiscoveryCountry } from "../../../packages/server/market-targeting";

type Point = { id: string; lead_id: string; kind: string; display_value: string; review_status: string; contact_name: string | null };
type Source = { point_id: string; source_url: string; source_provider: string };
type Match = { lead_id: string; service_id: string; status: string; reason: string; evidence_ids: string[]; assessed_at: string };
type Evidence = { id: string; lead_id: string; source_url: string | null; reviewed_by: string | null; observed_at: string };
type Service = { id: string; name: string };
type Assessment = { lead_id: string; status: string; observed_at: string };
type Qualification = { lead_id: string; status: string; evaluated_at: string };
type QueueData = { points: Point[]; sources: Source[]; matches: Match[]; evidence: Evidence[]; services: Service[]; assessments: Assessment[]; qualifications: Qualification[] };
const empty: QueueData = { points: [], sources: [], matches: [], evidence: [], services: [], assessments: [], qualifications: [] };

function safeUrl(value: string | null | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; }
  catch { return null; }
}

function csvCell(value: string | number | null | undefined) {
  const raw = String(value ?? "").replace(/[\r\n]+/g, " ");
  return `"${(/^[=+@\-\t]/.test(raw) ? `'${raw}` : raw).replaceAll('"', '""')}"`;
}

export function IndiaManualCallingQueue({ demo, orgId, role, leads, onOpenLead }: {
  demo: boolean; orgId: string; role: string; leads: RecordLead[]; onOpenLead: (lead: RecordLead) => void;
}) {
  const india = useMemo(() => leads.filter((lead) => !lead.is_demo && lead.status !== "disqualified"
    && canonicalDiscoveryCountry(lead.country ?? "") === "India"), [leads]);
  const [data, setData] = useState<QueueData>(empty);
  const [loadedOrg, setLoadedOrg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [phoneOnly, setPhoneOnly] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    if (demo || !supabase || !orgId || role !== "admin" || !india.length) return;
    const client = supabase;
    let alive = true;
    const ids = india.map((lead) => lead.id);
    Promise.resolve().then(async () => {
      if (alive) setLoading(true);
      const [p, s, m, e, c, a, q] = await Promise.all([
        client.from("vibe_contact_points").select("id,lead_id,kind,display_value,review_status,contact_name").eq("org_id", orgId).in("lead_id", ids).limit(3000),
        client.from("vibe_contact_sources").select("point_id,source_url,source_provider").eq("org_id", orgId).in("lead_id", ids).limit(6000),
        client.from("lead_service_matches").select("lead_id,service_id,status,reason,evidence_ids,assessed_at").eq("org_id", orgId).in("lead_id", ids).order("assessed_at", { ascending: false }).limit(3000),
        client.from("lead_evidence").select("id,lead_id,source_url,reviewed_by,observed_at").eq("org_id", orgId).in("lead_id", ids).limit(3000),
        client.from("service_catalog").select("id,name").eq("org_id", orgId).limit(100),
        client.from("lead_website_assessments").select("lead_id,status,observed_at").eq("org_id", orgId).in("lead_id", ids).order("observed_at", { ascending: false }).limit(3000),
        client.from("lead_qualifications").select("lead_id,status,evaluated_at").eq("org_id", orgId).in("lead_id", ids).order("evaluated_at", { ascending: false }).limit(3000),
      ]);
      if ([p, s, m, e, c, a, q].some((result) => result.error)) throw new Error("Calling evidence could not be loaded. No contact is treated as sourced.");
      if (alive) { setData({ points: p.data ?? [], sources: s.data ?? [], matches: m.data ?? [], evidence: e.data ?? [], services: c.data ?? [], assessments: a.data ?? [], qualifications: q.data ?? [] }); setLoadedOrg(orgId); }
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Calling evidence unavailable."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [demo, orgId, role, india]);

  const scoped = loadedOrg === orgId ? data : empty;
  const rows = india.map((lead) => {
    const points = scoped.points.filter((point) => point.lead_id === lead.id && point.review_status !== "rejected")
      .map((point) => ({ ...point, urls: [...new Set(scoped.sources.filter((source) => source.point_id === point.id).map((source) => safeUrl(source.source_url)).filter((url): url is string => Boolean(url)))] }))
      .filter((point) => point.urls.length);
    const phones = points.filter((point) => point.kind === "phone");
    const emails = points.filter((point) => point.kind === "email");
    const latest = scoped.matches.filter((match) => match.lead_id === lead.id)
      .filter((match, index, all) => all.findIndex((item) => item.service_id === match.service_id) === index);
    const reviewedMatch = latest.find((match) => match.status === "verified_gap" && match.evidence_ids.length > 0
      && match.evidence_ids.every((id) => scoped.evidence.some((evidence) => evidence.id === id && evidence.lead_id === lead.id
        && evidence.reviewed_by && safeUrl(evidence.source_url))));
    const qualification = scoped.qualifications.find((item) => item.lead_id === lead.id);
    const assessment = scoped.assessments.find((item) => item.lead_id === lead.id);
    const service = reviewedMatch && qualification?.status === "QUALIFIED"
      && (lead.website_url || assessment?.status === "NO_OFFICIAL_WEBSITE_DISCOVERED")
      ? scoped.services.find((item) => item.id === reviewedMatch.service_id)?.name : null;
    const sourceUrls = [...new Set([...phones, ...emails].flatMap((point) => point.urls).concat(
      reviewedMatch?.evidence_ids.flatMap((id) => scoped.evidence.filter((evidence) => evidence.id === id)
        .map((evidence) => safeUrl(evidence.source_url)).filter((url): url is string => Boolean(url))) ?? []))];
    return { lead, phones, emails, service, reason: service ? reviewedMatch?.reason ?? "" : "Needs identity, website or service review", sourceUrls,
      contactName: points.find((point) => point.contact_name)?.contact_name ?? null,
      websiteStatus: assessment?.status === "NO_OFFICIAL_WEBSITE_DISCOVERED" && !lead.website_url ? "No official site found after reviewed checks"
        : lead.website_url ? "Website recorded; review assessment" : "Website unknown" };
  }).filter((row) => (!phoneOnly || row.phones.length > 0) && `${row.lead.business_name} ${row.lead.city} ${row.lead.state_region ?? ""}`.toLowerCase().includes(text.toLowerCase()));

  function exportCsv() {
    const columns = ["Business", "City", "State", "Public phones", "Public emails", "Named person", "Website status", "Recommended service", "Evidence-based reason", "Source URLs", "Owner review status"];
    const records = rows.map((row) => [row.lead.business_name, row.lead.city, row.lead.state_region, row.phones.map((point) => point.display_value).join("; "),
      row.emails.map((point) => point.display_value).join("; "), row.contactName, row.websiteStatus, row.service, row.reason,
      row.sourceUrls.join("; "), row.phones.some((point) => point.review_status === "pending") ? "Contact review pending" : "Owner review required"]);
    const csv = [columns, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "chaincraft-india-manual-calling.csv"; link.click(); URL.revokeObjectURL(url);
  }

  if (demo || role !== "admin") return null;
  return <section className="panel" aria-label="India manual calling queue">
    <div className="panel-heading"><h2>India — Manual Calling</h2><span className="status">{india.length} stored businesses</span></div>
    <p className="muted">Owner review and personal phone calls only. No automated email, WhatsApp or AI calling. A sourced number is not permission to call.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {loading && <p role="status">Loading public contact evidence…</p>}
    <p>{rows.filter((row) => row.service).length} evidence-supported service opportunities · {rows.filter((row) => row.phones.length).length} with sourced business phones · {rows.filter((row) => row.emails.length).length} with sourced emails · {rows.filter((row) => !row.service).length} needing review. Stored businesses are not automatically qualified.</p>
    <div className="research-controls"><label>Filter Indian businesses<input aria-label="Filter Indian businesses" value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label><input type="checkbox" checked={phoneOnly} onChange={(event) => setPhoneOnly(event.target.checked)} /> Has sourced business phone</label>
      <button className="secondary" disabled={loading || Boolean(error) || !rows.length} onClick={exportCsv}>Export visible calling list</button></div>
    {!india.length ? <p className="muted">No India-tagged CRM businesses are loaded. Country must be explicitly recorded.</p> : <div className="table-wrap"><table>
      <thead><tr><th>Business / location</th><th>Public phone</th><th>Public email</th><th>Named person</th><th>Website</th><th>Service / reason</th><th>Sources</th><th>Review</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.lead.id}>
        <td><strong>{row.lead.business_name}</strong><br/><small>{row.lead.city || "City unknown"}{row.lead.state_region ? `, ${row.lead.state_region}` : ""}</small></td>
        <td>{row.phones.map((point) => <div key={point.id}>{point.display_value} · {point.review_status}</div>)}{!row.phones.length && "Not sourced"}</td>
        <td>{row.emails.map((point) => <div key={point.id}>{point.display_value} · {point.review_status}</div>)}{!row.emails.length && "Not sourced"}</td>
        <td>{row.contactName ?? "Not sourced"}</td><td>{row.websiteStatus}</td>
        <td>{row.service ?? "Research hold"}<br/><small>{row.reason}</small></td>
        <td>{row.sourceUrls.map((url) => <div key={url}><a href={url} target="_blank" rel="noopener noreferrer">Public source</a></div>)}{!row.sourceUrls.length && "No reviewed source"}</td>
        <td><button className="secondary" onClick={() => onOpenLead(row.lead)}>Open CRM</button></td>
      </tr>)}</tbody></table></div>}
  </section>;
}
