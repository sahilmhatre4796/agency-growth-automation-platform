"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

type Service = {
  id: string; service_key: string; name: string; description: string; applicable_industries: string[];
  ideal_customer_profile: string; problems_solved: string[]; observable_signals: string[];
  disqualification_criteria: string[]; evidence_requirements: string[]; potential_benefits: string[];
  configured_price: string | null; approved_proof: string[]; offer_cta: string;
  status: "disabled" | "active" | "custom_quote";
};
type Targeting = {
  target_industries: string[]; target_subcategories: string[]; target_cities: string[];
  target_states: string[]; target_countries: string[]; target_business_types: string[];
  excluded_industries: string[]; excluded_businesses: string[];
  minimum_evidence_confidence: number; high_priority_threshold: number;
  research_depth: "basic" | "standard" | "deep"; max_new_prospects: number;
  serper_discovery_enabled: boolean; harvey_discovery_enabled: boolean;
  vibe_contact_discovery_enabled?: boolean;
};
type OsmRun = { id: string; state: string; observations_count: number;
  last_error_code: string | null; target_city: string; target_industry: string };
const emptyTargeting: Targeting = {
  target_industries: [], target_subcategories: [], target_cities: [], target_states: [], target_countries: [],
  target_business_types: [], excluded_industries: [], excluded_businesses: [], minimum_evidence_confidence: 0.7,
  high_priority_threshold: 75, research_depth: "basic", max_new_prospects: 0,
  serper_discovery_enabled: false, harvey_discovery_enabled: false,
};
const listFields: { key: keyof Pick<Service, "applicable_industries" | "problems_solved" | "observable_signals" | "disqualification_criteria" | "evidence_requirements" | "potential_benefits" | "approved_proof">; label: string }[] = [
  { key: "applicable_industries", label: "Applicable industries" },
  { key: "problems_solved", label: "Problems solved" },
  { key: "observable_signals", label: "Observable qualification signals" },
  { key: "disqualification_criteria", label: "Disqualification criteria" },
  { key: "evidence_requirements", label: "Evidence requirements" },
  { key: "potential_benefits", label: "Potential benefits" },
  { key: "approved_proof", label: "Approved proof or case study references" },
];
const targetFields: { key: keyof Pick<Targeting, "target_industries" | "target_subcategories" | "target_cities" | "target_states" | "target_countries" | "target_business_types" | "excluded_industries" | "excluded_businesses">; label: string }[] = [
  { key: "target_industries", label: "Target industries" }, { key: "target_subcategories", label: "Subcategories" },
  { key: "target_cities", label: "Cities" }, { key: "target_states", label: "States" },
  { key: "target_countries", label: "Countries" }, { key: "target_business_types", label: "Business types" },
  { key: "excluded_industries", label: "Excluded industries" }, { key: "excluded_businesses", label: "Excluded businesses" },
];
const parseLines = (value: FormDataEntryValue | null) => String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 50);

export function QualificationSettings({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [services, setServices] = useState<Service[]>([]);
  const [targeting, setTargeting] = useState<Targeting>(emptyTargeting);
  const [osmRuns, setOsmRuns] = useState<OsmRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [osmCategory, setOsmCategory] = useState("dentist");
  const [osmCity, setOsmCity] = useState("");
  const [osmCountry, setOsmCountry] = useState("India");
  const [osmLatitude, setOsmLatitude] = useState("");
  const [osmLongitude, setOsmLongitude] = useState("");
  const [osmRadius, setOsmRadius] = useState(5);
  const refresh = useCallback(async () => {
    if (demo || !supabase || !orgId) return;
    const [catalog, target, runs] = await Promise.all([
      supabase.from("service_catalog").select("*").eq("org_id", orgId).order("service_key"),
      supabase.from("discovery_targeting").select("*").eq("org_id", orgId).maybeSingle(),
      supabase.from("discovery_runs").select("id,state,observations_count,last_error_code,target_city,target_industry")
        .eq("org_id", orgId).eq("provider", "harvey").order("created_at", { ascending: false }).limit(10),
    ]);
    if (catalog.error || target.error || runs.error) throw new Error("Qualification settings could not be loaded.");
    setServices((catalog.data ?? []) as Service[]);
    setTargeting((target.data as Targeting | null) ?? emptyTargeting);
    setOsmRuns((runs.data ?? []) as OsmRun[]);
  }, [demo, orgId]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The change could not be saved."); }
    finally { setBusy(false); }
  }
  async function saveTargeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const actor = (await supabase!.auth.getUser()).data.user?.id;
      if (!actor) throw new Error("Sign in again before saving.");
      const payload: Record<string, unknown> = { org_id: orgId, updated_by: actor, updated_at: new Date().toISOString() };
      for (const field of targetFields) payload[field.key] = parseLines(form.get(field.key));
      payload.minimum_evidence_confidence = Number(form.get("minimum_evidence_confidence"));
      payload.high_priority_threshold = Number(form.get("high_priority_threshold"));
      payload.research_depth = String(form.get("research_depth"));
      payload.max_new_prospects = Number(form.get("max_new_prospects"));
      // Serper requires a separate approved credit budget. OSM can be enabled
      // explicitly by the owner, but its Edge worker remains OFF by default.
      payload.serper_discovery_enabled = false;
      payload.harvey_discovery_enabled = form.get("harvey_discovery_enabled") === "on";
      // This separately approved switch is configured through staging rollout;
      // saving general targeting must not silently enable or reset it.
      payload.vibe_contact_discovery_enabled = targeting.vibe_contact_discovery_enabled ?? false;
      const { error: saveError } = await supabase!.from("discovery_targeting").upsert(payload);
      if (saveError) throw new Error("Targeting could not be saved.");
      setNotice("Targeting saved. External discovery workers remain disabled until separately configured in approved staging.");
    });
  }
  async function saveService(event: FormEvent<HTMLFormElement>, service: Service) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const actor = (await supabase!.auth.getUser()).data.user?.id;
      if (!actor) throw new Error("Sign in again before saving.");
      const status = String(form.get("status")) as Service["status"];
      const payload: Record<string, unknown> = {
        name: String(form.get("name") ?? "").trim(), description: String(form.get("description") ?? "").trim(),
        ideal_customer_profile: String(form.get("ideal_customer_profile") ?? "").trim(),
        configured_price: String(form.get("configured_price") ?? "").trim() || null,
        offer_cta: String(form.get("offer_cta") ?? "").trim(), status,
        reviewed_by: status === "disabled" ? null : actor,
        reviewed_at: status === "disabled" ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      for (const field of listFields) payload[field.key] = parseLines(form.get(field.key));
      const { error: saveError } = await supabase!.from("service_catalog").update(payload).eq("org_id", orgId).eq("id", service.id);
      if (saveError) throw new Error("Service could not be saved. Check the required evidence and your access role.");
      setNotice(`${payload.name} saved for the current workspace.`);
    });
  }
  async function requestOsm() {
    await run(async () => {
      const { data, error: requestError } = await supabase!.rpc("request_harvey_osm_discovery", {
        p_org: orgId, p_category: osmCategory, p_city: osmCity.trim(), p_country: osmCountry.trim(),
        p_latitude: Number(osmLatitude), p_longitude: Number(osmLongitude),
        p_radius_km: osmRadius, p_limit: 3,
      });
      if (requestError) throw new Error(requestError.message);
      const { data: savedRun } = await supabase!.from("discovery_runs").select("state").eq("org_id", orgId).eq("id", data).maybeSingle();
      setNotice(savedRun?.state === "completed" ? "Recent OSM listing observations reused. Review them in Discover; no website or service gap was inferred." :
        "Bounded OSM discovery queued. The separate worker flag must be enabled in approved staging; listings never establish a service gap or official website.");
    });
  }
  async function processOsm(runId: string) {
    await run(async () => {
      const { data, error: invokeError } = await supabase!.functions.invoke("harvey-osm-discovery-step", {
        body: { org_id: orgId, run_id: runId },
      });
      if (invokeError || !data || data.error || data.failed)
        throw new Error("The one-job OSM step is disabled or failed. Review its saved status before another action.");
      setNotice(data.processed ? "One bounded OSM listing search completed. Review identity and contact evidence in CRM." :
        "No queued OSM run was ready; no external search was started.");
    });
  }
  return <div className="research-workspace">
    <section className="panel"><h2>Qualification and targeting</h2>
      <p className="muted">The catalog begins disabled. Review each actual ChainCraft capability and enter only approved proof, prices and offers. Saving criteria does not start discovery, research or outreach.</p>
      {demo ? <p>Settings are unavailable in the isolated demonstration.</p> : role !== "admin" ? <p>An organization admin manages qualification settings.</p> : <>
        {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
        <form key={JSON.stringify(targeting)} onSubmit={(event) => void saveTargeting(event)}>
          <h3>Target market</h3><p className="muted">Enter one value per line. An empty target industry or city holds leads for research.</p>
          <div className="form-grid">{targetFields.map((field) => <label key={field.key}>{field.label}<textarea name={field.key} defaultValue={targeting[field.key].join("\n")} rows={3}/></label>)}</div>
          <div className="form-grid">
            <label>Minimum evidence confidence<input name="minimum_evidence_confidence" type="number" min="0.5" max="1" step="0.05" defaultValue={targeting.minimum_evidence_confidence}/></label>
            <label>High-priority score<input name="high_priority_threshold" type="number" min="50" max="100" defaultValue={targeting.high_priority_threshold}/></label>
            <label>Research depth<select name="research_depth" defaultValue={targeting.research_depth}><option value="basic">Basic</option><option value="standard">Standard</option><option value="deep">Deep</option></select></label>
            <label>Maximum new prospects per run<input name="max_new_prospects" type="number" min="0" max="100" defaultValue={targeting.max_new_prospects}/></label>
          </div><label><input name="harvey_discovery_enabled" type="checkbox" defaultChecked={targeting.harvey_discovery_enabled}/> Allow owner-requested free OSM discovery (separate worker remains off by default)</label><button className="secondary" disabled={busy}>Save targeting</button>
        </form>
        <div className="verification-record"><h3>Optional Harvey-derived OSM listing search</h3>
          <p className="muted">Enter an approved target category and city plus its coordinates. Search radius is limited to 10 km and three listings. OSM tags are incomplete; an absent website tag is not proof of a missing site.</p>
          <p className="muted">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>. Public Overpass capacity is limited; use only small, deliberate searches.</p>
          <div className="form-grid">
            <label>Category<select value={osmCategory} onChange={(event) => setOsmCategory(event.target.value)}>{["dentist","plumber","electrician","roofer","gardener"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label>Approved city<input value={osmCity} onChange={(event) => setOsmCity(event.target.value)} maxLength={80}/></label>
            <label>Country<input value={osmCountry} onChange={(event) => setOsmCountry(event.target.value)} maxLength={80}/></label>
            <label>Latitude<input type="number" min={-90} max={90} step="any" value={osmLatitude} onChange={(event) => setOsmLatitude(event.target.value)}/></label>
            <label>Longitude<input type="number" min={-180} max={180} step="any" value={osmLongitude} onChange={(event) => setOsmLongitude(event.target.value)}/></label>
            <label>Radius, km<input type="number" min={1} max={10} step={0.5} value={osmRadius} onChange={(event) => setOsmRadius(Number(event.target.value))}/></label>
          </div>
          <button className="secondary" disabled={busy || !targeting.harvey_discovery_enabled || !osmCity.trim() || !osmLatitude || !osmLongitude} onClick={() => void requestOsm()}>Queue reviewed OSM search</button>
          {osmRuns.map((item) => <p className="muted" key={item.id}>{item.target_city} · {item.target_industry} · {item.state} · {item.observations_count} listing observations{item.last_error_code ? ` · ${item.last_error_code}` : ""} {item.state === "queued" && <button className="secondary" disabled={busy || !targeting.harvey_discovery_enabled} onClick={() => void processOsm(item.id)}>Process this OSM job once</button>}</p>)}
        </div>
      </>}
    </section>
    {!demo && role === "admin" && <section className="panel"><div className="panel-heading"><h2>ChainCraft service catalog</h2><button className="secondary" disabled={busy} onClick={() => void run(async () => { const { error: initError } = await supabase!.rpc("ensure_service_catalog", { p_org: orgId }); if (initError) throw new Error("Catalog initialization failed."); setNotice("Missing offerings and blank guidance filled. Existing owner edits, prices, proof and activation were preserved."); })}>Fill missing catalog guidance</button></div>
      {services.length === 0 && <p className="muted">Initialize the owner-provided list, then review and edit each offering.</p>}
      {services.map((service) => <details key={service.id} className="panel"><summary>{service.name} · {service.status.replaceAll("_", " ")}</summary>
        <form key={JSON.stringify(service)} onSubmit={(event) => void saveService(event, service)}>
          <div className="form-grid"><label>Name<input name="name" required minLength={3} maxLength={120} defaultValue={service.name}/></label>
          <label>Status<select name="status" defaultValue={service.status}><option value="disabled">Disabled</option><option value="active">Active</option><option value="custom_quote">Custom quote</option></select></label>
          <label>Description<textarea name="description" defaultValue={service.description} rows={3}/></label>
          <label>Ideal customer profile<textarea name="ideal_customer_profile" defaultValue={service.ideal_customer_profile} rows={3}/></label></div>
          <div className="form-grid">{listFields.map((field) => <label key={field.key}>{field.label}<textarea name={field.key} defaultValue={service[field.key].join("\n")} rows={3}/></label>)}</div>
          <div className="form-grid"><label>Configured price, if approved<input name="configured_price" defaultValue={service.configured_price ?? ""}/></label>
          <label>Offer or CTA<input name="offer_cta" defaultValue={service.offer_cta}/></label></div>
          <button className="secondary" disabled={busy}>Save service</button>
        </form>
      </details>)}
    </section>}
  </div>;
}
