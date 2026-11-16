"use client";

import { useState } from "react";
import { supabase } from "../lib/supabase";
import { parseOverturePlacesGeoJSON, type OvertureCandidate, type OvertureKnownLead } from "../../../packages/server/overture-places";

export function OvertureReview({ demo, orgId, role, knownLeads, onPromoted }: {
  demo: boolean; orgId: string; role: string; knownLeads: OvertureKnownLead[];
  onPromoted: () => Promise<void>;
}) {
  const [city, setCity] = useState("Modesto");
  const [state, setState] = useState("California");
  const [country, setCountry] = useState("USA");
  const [release, setRelease] = useState("");
  const [limit, setLimit] = useState(10);
  const [file, setFile] = useState<File | null>(null);
  const [candidates, setCandidates] = useState<OvertureCandidate[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [promoted, setPromoted] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reviewExport() {
    setError(""); setCandidates([]); setPromoted({});
    if (!file || file.size > 5_000_000 || !/\.geojson$|\.json$/i.test(file.name)) {
      setError("Select an official Overture Places GeoJSON export of at most 5 MB."); return;
    }
    setBusy(true);
    try {
      const payload: unknown = JSON.parse(await file.text());
      setCandidates(parseOverturePlacesGeoJSON(payload, { city, state, country, limit, release }, knownLeads));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Overture export could not be reviewed.");
    } finally { setBusy(false); }
  }

  async function promote(candidate: OvertureCandidate) {
    const reviewNote = notes[candidate.id]?.trim() ?? "";
    if (demo || role !== "admin" || !supabase || !orgId || candidate.duplicateLeadIds.length || reviewNote.length < 20) return;
    setBusy(true); setError("");
    try {
      const { data, error: rpcError } = await supabase.rpc("promote_reviewed_overture_place", {
        p_org: orgId,
        p_place: {
          id: candidate.id, release: candidate.release, name: candidate.businessName,
          category: candidate.category, city: candidate.city, state_region: candidate.stateRegion,
          country: candidate.country, address: candidate.address, website_url: candidate.websiteUrl,
          source_url: candidate.sourceUrl, observed_at: candidate.observedAt, review_note: reviewNote,
          sources: candidate.sources.map((source) => ({ dataset: source.dataset,
            record_id: source.recordId, property: source.property,
            license: source.license, update_time: source.updatedAt })),
          emails: candidate.contacts.filter((contact) => contact.kind === "email").map((contact) => contact.value),
          phones: candidate.contacts.filter((contact) => contact.kind === "phone").map((contact) => contact.value),
        },
      });
      if (rpcError) throw rpcError;
      const result = data as { state?: string; lead_id?: string } | null;
      setPromoted((current) => ({ ...current, [candidate.id]: result?.state ?? "review_needed" }));
      if (result?.state === "created") await onPromoted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Promotion was blocked; no record was confirmed.");
    } finally { setBusy(false); }
  }

  return <section className="panel" aria-label="Overture Places review">
    <div className="panel-heading"><h2>Overture Places discovery</h2><span className="status">Owner-triggered · no credits</span></div>
    <p>Choose one location and review a small <a href="https://explore.overturemaps.org/" target="_blank" rel="noopener noreferrer">official Overture Places GeoJSON export</a>. Download only the visible area in Explorer. The file stays in this browser until you explicitly promote a reviewed candidate.</p>
    <div className="research-controls">
      <label>City<input value={city} maxLength={100} onChange={(event) => setCity(event.target.value)} /></label>
      <label>State or region<input value={state} maxLength={120} onChange={(event) => setState(event.target.value)} /></label>
      <label>Country<input value={country} maxLength={120} onChange={(event) => setCountry(event.target.value)} /></label>
      <label>Release ID<input value={release} maxLength={20} placeholder="YYYY-MM-DD.0" onChange={(event) => setRelease(event.target.value)} /></label>
      <label>Candidate limit<input type="number" min={1} max={15} value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label>
      <label>Places GeoJSON file<input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
    </div>
    <p className="muted">Use the release shown by Explorer or the <a href="https://stac.overturemaps.org/catalog.json" target="_blank" rel="noopener noreferrer">official STAC catalog</a>. Only matching locality records with source IDs are shown. Overture website fields and contacts remain unverified observations. Missing website fields do not prove website absence. <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener noreferrer">Source attribution</a> is retained.</p>
    <button className="secondary" disabled={busy || demo || role !== "admin" || !file} onClick={() => void reviewExport()}>Review bounded export</button>
    {error && <p role="alert" className="error">{error}</p>}
    {candidates.length === 0 && file && !error && <p className="muted">No matching candidate has been reviewed yet.</p>}
    {candidates.map((candidate) => <div className="verification-record" key={candidate.id}>
      <h3>{candidate.businessName}</h3>
      <p>{candidate.category} · {candidate.city}, {candidate.stateRegion}, {candidate.country} · {candidate.identityStatus.replaceAll("_", " ")}</p>
      <p>Website: <strong>UNKNOWN</strong>{candidate.websiteUrl ? <> · Overture lists <a href={candidate.websiteUrl} target="_blank" rel="noopener noreferrer">this unverified URL</a></> : " · no URL in this source record; independent website checks are still required"}.</p>
      {candidate.recommendation && <p>{candidate.recommendation}. This is a potential use case, not an established need.</p>}
      <p>Public-source contacts: {candidate.contacts.length ? candidate.contacts.map((contact) => `${contact.kind} ${contact.value} (mailbox/number validity unknown; owner review pending)`).join(" · ") : "none in this record"}</p>
      <p className="muted">Overture GERS ID: {candidate.id} · Release {candidate.release} · {candidate.attribution} · Source IDs: {candidate.sources.map((source) => `${source.dataset}:${source.recordId}${source.license ? ` (${source.license})` : ""}`).join(", ")}. <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer">Inspect in Explorer</a>.</p>
      {candidate.duplicateLeadIds.length > 0 && <p role="status">Possible existing CRM match: {candidate.duplicateLeadIds.join(", ")}. Review in CRM; promotion is blocked to avoid a duplicate.</p>}
      {promoted[candidate.id] && <p role="status">Promotion result: {promoted[candidate.id]}. Contacts remain pending review; no outreach is approved.</p>}
      {!promoted[candidate.id] && <><label>Owner identity and website review note
        <textarea rows={2} maxLength={500} value={notes[candidate.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [candidate.id]: event.target.value }))} placeholder="Describe the independent identity and website checks before promoting." />
      </label><button className="secondary" disabled={busy || demo || role !== "admin" || candidate.duplicateLeadIds.length > 0 || (notes[candidate.id]?.trim().length ?? 0) < 20} onClick={() => void promote(candidate)}>Promote reviewed candidate to CRM</button></>}
    </div>)}
  </section>;
}
