"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Plus, Search, Upload, X } from "lucide-react";
import {
  leadInput,
  previewCSV,
  stages,
  type Evidence,
  type ImportRow,
  type LeadInput,
} from "../../../packages/shared/crm";
import { crmStore, type RecordLead, type Detail } from "../lib/crm-store";
import { IndiaManualCallingQueue } from "./india-manual-calling-queue";

export function CRM({
  demo,
  orgId,
  role,
  onChange,
}: {
  demo: boolean;
  orgId: string;
  role: string;
  onChange: () => void;
}) {
  const store = useMemo(() => crmStore(demo, orgId), [demo, orgId]);
  const [observedNow] = useState(() => Date.now());
  const [leads, setLeads] = useState<RecordLead[]>([]),
    [selected, setSelected] = useState<RecordLead | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [stage, setStage] = useState(""),
    [editor, setEditor] = useState(false),
    [importing, setImporting] = useState(false),
    [csv, setCSV] = useState(""),
    [preview, setPreview] = useState<ImportRow[]>([]);
  const canWrite = demo || role === "admin";
  useEffect(() => {
    let alive = true;
    store
      .list()
      .then((rows) => {
        if (alive) {
          setLeads(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setError(
            "Lead records are unavailable. Check your connection or organization access.",
          );
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [store]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setLeads(await store.list());
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }
  async function open(lead: RecordLead) {
    setSelected(lead);
    setDetail(null);
    setError("");
    try {
      setDetail(await store.detail(lead.id));
    } catch {
      setError("Lead details could not be loaded.");
    }
  }
  async function refreshDetail() {
    if (selected) setDetail(await store.detail(selected.id));
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = leadInput.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((e) => `${e.path}: ${e.message}`).join("; "),
      );
      return;
    }
    await run(async () => {
      const result = await store.import([parsed.data]);
      setNotice(
        `${result.added} created; ${result.skipped} duplicate(s) skipped. ${result.processing_attempted} submitted to automatic evidence review; others remain saved for later processing. Permissions and suppressions are unchanged.`,
      );
      setEditor(false);
    });
  }
  function previewImport() {
    try {
      setPreview(previewCSV(csv, leads));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const filtered = leads.filter(
    (l) =>
      (!stage || l.status === stage) &&
      `${l.business_name} ${l.city} ${l.business_category} ${l.source_type}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  if (loading)
    return (
      <section className="panel" role="status">
        Loading lead directory…
      </section>
    );
  return (
    <div className="crm">
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
      {selected ? (
        <>
          <button
            className="text-button"
            onClick={() => {
              setSelected(null);
              setDetail(null);
            }}
          >
            <ArrowLeft size={16} />
            Back to directory
          </button>
          <div className="detail-header">
            <div>
              <h2>{selected.business_name}</h2>
              <p>
                {selected.website_url
                  ? `Website URL recorded: ${selected.website_url}`
                  : "Website URL not recorded"} ·{" "}
                {[selected.city, selected.state_region, selected.country]
                  .filter(Boolean).join(", ") || "Location unknown"}
              </p>
              {selected.public_address && (
                <p>Public business address: {selected.public_address}</p>
              )}
            </div>
            <span className="status">
              {demo ? "Demonstration record" : "Stored CRM record"}
            </span>
          </div>
          {canWrite && (
            <details className="panel">
              <summary>Edit business details</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = leadInput.safeParse({
                    ...selected,
                    ...Object.fromEntries(new FormData(e.currentTarget)),
                  });
                  if (!parsed.success) {
                    setError(
                      parsed.error.issues.map((i) => i.message).join("; "),
                    );
                    return;
                  }
                  void run(async () => {
                    await store.edit(selected.id, parsed.data);
                    setSelected({ ...selected, ...parsed.data });
                    setNotice(
                      "Business details saved. Outreach permissions remain unchanged.",
                    );
                  });
                }}
              >
                <div className="form-grid">
                  {(
                    [
                      "business_name",
                      "website_url",
                      "city",
                      "business_category",
                      "source_url",
                    ] as const
                  ).map((field) => (
                    <label key={field}>
                      {field.replaceAll("_", " ")}
                      <input
                        name={field}
                        defaultValue={selected[field]}
                        required={field === "business_name"}
                        type={field.endsWith("_url") ? "url" : "text"}
                      />
                    </label>
                  ))}
                </div>
                <button className="secondary" disabled={busy}>
                  Save business details
                </button>
              </form>
            </details>
          )}
          <section className="panel">
            <div className="form-grid">
              <label>
                Pipeline stage
                <select
                  aria-label="Pipeline stage"
                  value={selected.status}
                  disabled={!canWrite || busy}
                  onChange={(e) => {
                    const status = e.target.value as RecordLead["status"];
                    void run(async () => {
                      await store.update(selected.id, { status });
                      setSelected({ ...selected, status });
                      await refreshDetail();
                    });
                  }}
                >
                  {stages.map((s) => (
                    <option key={s} value={s}>
                      {s.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Deal value (INR)
                <input
                  aria-label="Deal value (INR)"
                  type="number"
                  min="0"
                  max="100000000"
                  step="0.01"
                  defaultValue={
                    selected.deal_value_paise === null
                      ? ""
                      : selected.deal_value_paise / 100
                  }
                  disabled={!canWrite || busy}
                  onBlur={(e) => {
                    const amount =
                      e.target.value === ""
                        ? null
                        : Math.round(Number(e.target.value) * 100);
                    if (
                      amount !== null &&
                      (!Number.isSafeInteger(amount) || amount < 0)
                    ) {
                      setError("Enter a valid nonnegative deal value.");
                      return;
                    }
                    if (amount !== selected.deal_value_paise)
                      void run(async () => {
                        await store.update(selected.id, {
                          deal_value_paise: amount,
                        });
                        setSelected({ ...selected, deal_value_paise: amount });
                      });
                  }}
                />
              </label>
            </div>
            <p className="muted">
              {selected.email
                ? `CRM email on file: ${selected.email}`
                : "No CRM email on file"} · Outreach permission is not shown here.
              Public contact details do not authorize outreach; check
              eligibility separately.
            </p>
          </section>
          {!detail ? (
            <p role="status">Loading evidence and history…</p>
          ) : (
            <>
              <section className="panel" aria-label="Website and service review">
                <h2>Website and service review</h2>
                {detail.websiteAssessment ? (
                  <>
                    <p><strong>Website assessment: {detail.websiteAssessment.status.replaceAll("_", " ")}</strong> · {detail.websiteAssessment.reason}</p>
                    {detail.websiteAssessment.official_url && (
                      <p>Assessed official URL: <a href={detail.websiteAssessment.official_url} target="_blank" rel="noopener noreferrer">{detail.websiteAssessment.official_url}</a></p>
                    )}
                    <small>Assessed {new Date(detail.websiteAssessment.observed_at).toLocaleDateString()}. A missing URL alone does not establish that no website exists.</small>
                  </>
                ) : (
                  <p>Website status unknown — no saved assessment. A missing URL alone does not establish that no website exists.</p>
                )}
                {selected.needs && <p><strong>Saved service recommendation / research note:</strong> {selected.needs}</p>}
                <p className="muted">Pipeline: {selected.status.replaceAll("_", " ")} · {detail.evidence.filter((item) => !item.reviewed && !item.rejected).length} evidence item(s) pending owner review. A saved recommendation is not outreach approval.</p>
              </section>
            <div className="detail-grid">
              <div>
                <section className="panel">
                  <h2>Contacts</h2>
                  <p className="muted">Changing an email or phone requires a new reviewed contact. Previous consent and verification never transfer to a new address.</p>
                  {detail.contacts.length ? detail.contacts.map((contact) => (
                    <div className="evidence" key={contact.id}>
                      <strong>{contact.email || contact.phone_e164 || "No endpoint"}</strong>
                      <p>{contact.contact_name || "Name not recorded"} · {contact.role || "Role not recorded"}</p>
                      <small>{contact.source_url ? `Public source: ${contact.source_url}` : "Source not recorded"} · {contact.email ? (contact.verified_at ? "Verification timestamp recorded; inspect the verification result before claiming mailbox validity" : "Mailbox verification not recorded") : "Phone verification not recorded"} · Contact review decision not recorded on this CRM contact · Check outreach eligibility separately</small>
                      {canWrite && <details>
                        <summary>Edit contact profile</summary>
                        <form onSubmit={(event) => {
                          event.preventDefault();
                          const form = event.currentTarget;
                          const values = new FormData(form);
                          void run(async () => {
                            await store.updateContactProfile(selected.id, contact.id,
                              String(values.get("contact_name") || "").trim(),
                              String(values.get("role") || "").trim(),
                              String(values.get("source_url") || "").trim());
                            await refreshDetail();
                            setNotice("Contact profile updated. Endpoint, consent and verification remain unchanged.");
                          });
                        }}>
                          <label>Contact name<input name="contact_name" defaultValue={contact.contact_name || ""} maxLength={160} /></label>
                          <label>Role<input name="role" defaultValue={contact.role || ""} maxLength={100} /></label>
                          <label>Public source URL<input name="source_url" type="url" defaultValue={contact.source_url || ""} maxLength={500} /></label>
                          <button className="secondary" disabled={busy}>Save profile</button>
                        </form>
                      </details>}
                    </div>
                  )) : <p>No CRM contact recorded.</p>}
                  {detail.publicContacts.filter((point) => point.review_status !== "rejected").length > 0 && <div>
                    <h3>Public contact candidates</h3>
                    <p className="muted">Sourced addresses and numbers await owner review. A public email has not been verified as a working mailbox and does not grant permission to send.</p>
                    {detail.publicContacts.filter((point) => point.review_status !== "rejected").map((point) => <div className="evidence" key={point.id}>
                      <strong>{point.display_value}</strong> · {point.kind} · {point.review_status}
                      {detail.publicContactSources.filter((source) => source.point_id === point.id).map((source) =>
                        <p key={`${source.point_id}:${source.source_url}`}><a href={source.source_url} target="_blank" rel="noopener noreferrer">Public source ({source.source_provider})</a></p>)}
                    </div>)}
                  </div>}
                  {canWrite && <details>
                    <summary>Add reviewed public contact</summary>
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const values = new FormData(form);
                      void run(async () => {
                        await store.addReviewedContact(selected.id,
                          String(values.get("email") || "").trim().toLowerCase(),
                          String(values.get("source_url") || "").trim(),
                          String(values.get("review_note") || "").trim());
                        await refreshDetail();
                        form.reset();
                        setNotice("Contact added without verification or outreach permission.");
                      });
                    }}>
                      <label>Public email<input name="email" type="email" maxLength={254} required /></label>
                      <label>Supporting public URL<input name="source_url" type="url" maxLength={500} required /></label>
                      <label>Why this address belongs to this business<textarea name="review_note" minLength={15} maxLength={1000} required /></label>
                      <button className="secondary" disabled={busy}>Add contact for review</button>
                    </form>
                  </details>}
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Evidence & provenance</h2>
                  </div>
                  {detail.evidence.length ? (
                    detail.evidence.map((e) => (
                      <article className="evidence" key={e.id}>
                        <span className="status">
                          {e.rejected ? "Rejected" : e.reviewed ? "Human reviewed" : "Pending owner review"} ·{" "}
                          {e.kind}
                        </span>
                        <p>{e.claim}</p>
                        <small>
                          {e.source_url} ·{" "}
                          {new Date(e.observed_at).toLocaleDateString()} ·
                          Confidence {Math.round(e.confidence * 100)}%
                          {observedNow - Date.parse(e.observed_at) >
                          90 * 86400000
                            ? " · Stale"
                            : ""}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p>No evidence recorded. Buying intent is unknown.</p>
                  )}
                  {canWrite && (
                    <EvidenceForm
                      busy={busy}
                      onSubmit={(e) =>
                        run(async () => {
                          await store.addEvidence(selected.id, e);
                          await refreshDetail();
                        })
                      }
                    />
                  )}
                </section>
                <section className="panel">
                  <h2>Notes</h2>
                  {detail.notes.map((n) => (
                    <div className="evidence" key={n.id}>
                      <p>{n.body}</p>
                      <small>{new Date(n.created_at).toLocaleString()}</small>
                    </div>
                  ))}
                  {canWrite && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const body = String(
                          new FormData(form).get("note"),
                        ).trim();
                        if (!body) return;
                        void run(async () => {
                          await store.note(selected.id, body);
                          await refreshDetail();
                          form.reset();
                        });
                      }}
                    >
                      <label htmlFor="lead-note">Add a note</label>
                      <textarea
                        id="lead-note"
                        name="note"
                        maxLength={5000}
                        required
                      />
                      <button className="secondary" disabled={busy}>
                        Save note
                      </button>
                    </form>
                  )}
                </section>
              </div>
              <div>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Explainable score</h2>
                    <button
                      className="secondary"
                      disabled={!canWrite || busy}
                      onClick={() =>
                        void run(async () => {
                          await store.score(selected.id);
                          await refreshDetail();
                        })
                      }
                    >
                      Calculate
                    </button>
                  </div>
                  {detail.scores[0] ? (
                    <>
                      <div className="score-number">
                        {detail.scores[0].score}
                        <small>/ 100 · {detail.scores[0].score_version}</small>
                      </div>
                      {Object.entries(detail.scores[0].breakdown).map(
                        ([key, value]) => (
                          <div className="setting-row" key={key}>
                            <span>{key}</span>
                            <strong>{value}</strong>
                          </div>
                        ),
                      )}
                      <p className="muted">
                        Confidence{" "}
                        {Math.round(detail.scores[0].confidence * 100)}% ·{" "}
                        {detail.scores[0].evidence_ids.length} cited evidence
                        record(s). Score is an assessment, never confirmed
                        intent. Change stage manually after review.
                      </p>
                    </>
                  ) : (
                    <p>No score yet. Add reviewed source evidence to begin.</p>
                  )}
                  {detail.overrides?.[0] && (
                    <div className="notice">
                      <strong>
                        Owner assessment: {detail.overrides[0].score}/100
                      </strong>
                      <p>{detail.overrides[0].reason}</p>
                      <small>Separate from the calculated score.</small>
                    </div>
                  )}
                  {canWrite && (
                    <details>
                      <summary>Record owner assessment</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void run(async () => {
                            await store.override(
                              selected.id,
                              Number(f.get("score")),
                              String(f.get("reason")),
                            );
                            await refreshDetail();
                          });
                        }}
                      >
                        <label>
                          Owner score
                          <input
                            name="score"
                            type="number"
                            min="0"
                            max="100"
                            required
                          />
                        </label>
                        <label>
                          Reason
                          <input
                            name="reason"
                            minLength={10}
                            maxLength={1000}
                            required
                          />
                        </label>
                        <button className="secondary" disabled={busy}>
                          Save assessment
                        </button>
                      </form>
                    </details>
                  )}
                </section>
                <section className="panel">
                  <h2>Tasks</h2>
                  {detail.tasks.map((t) => (
                    <div className="task-row" key={t.id}>
                      <span>
                        {t.title}
                        <small>
                          {t.due_at
                            ? new Date(t.due_at).toLocaleString()
                            : "No due date"}{" "}
                          · {t.state}
                        </small>
                      </span>
                      {t.state === "open" && (
                        <button
                          className="text-button"
                          disabled={!canWrite || busy}
                          onClick={() =>
                            void run(async () => {
                              await store.completeTask(selected.id, t.id);
                              await refreshDetail();
                            })
                          }
                        >
                          Complete
                        </button>
                      )}
                    </div>
                  ))}
                  {canWrite && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const f = new FormData(form);
                        void run(async () => {
                          await store.task(
                            selected.id,
                            String(f.get("title")),
                            f.get("due")
                              ? new Date(String(f.get("due"))).toISOString()
                              : null,
                          );
                          await refreshDetail();
                          form.reset();
                        });
                      }}
                    >
                      <label htmlFor="task-title">Task title</label>
                      <input
                        id="task-title"
                        name="title"
                        required
                        maxLength={160}
                      />
                      <label htmlFor="task-due">
                        Due in your local timezone
                      </label>
                      <input id="task-due" name="due" type="datetime-local" />
                      <button className="secondary" disabled={busy}>
                        Add task
                      </button>
                    </form>
                  )}
                </section>
                <section className="panel">
                  <h2>Activity timeline</h2>
                  {detail.activity.length ? (
                    detail.activity.map((a, i) => (
                      <div className="evidence" key={i}>
                        <strong>{a.action.replaceAll("_", " ")}</strong>
                        <small>
                          {new Date(a.occurred_at).toLocaleString()}
                        </small>
                      </div>
                    ))
                  ) : (
                    <p>No activity recorded.</p>
                  )}
                </section>
              </div>
            </div>
            </>
          )}
        </>
      ) : (
        <>
          <section className="panel">
            <div className="panel-heading">
              <h2>
                Lead directory <span className="muted">({leads.length})</span>
              </h2>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={!canWrite}
                  onClick={() => {
                    setEditor(!editor);
                    setImporting(false);
                  }}
                >
                  <Plus size={15} />
                  New lead
                </button>
                <button
                  className="secondary"
                  disabled={!canWrite}
                  onClick={() => {
                    setImporting(!importing);
                    setEditor(false);
                  }}
                >
                  <Upload size={15} />
                  Import CSV
                </button>
              </div>
            </div>
            <div className="filter-row">
              <label className="search">
                <Search size={16} />
                <input
                  aria-label="Search leads"
                  placeholder="Search business, city, source…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                aria-label="Filter stage"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option value="">All stages</option>
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <span className="muted">
                {demo
                  ? "Local demonstration storage · Fictional records only"
                  : "RLS-protected database · Up to 1,000 records"}
              </span>
            </div>
            {editor && (
              <form className="inline-editor" onSubmit={create}>
                <div className="panel-heading">
                  <h2>New opportunity</h2>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Close new lead"
                    onClick={() => setEditor(false)}
                  >
                    <X size={17} />
                  </button>
                </div>
                <div className="form-grid">
                  {[
                    {
                      name: "business_name",
                      label: "Business name",
                      required: true,
                    },
                    { name: "website_url", label: "Website URL", type: "url" },
                    { name: "email", label: "Business email", type: "email" },
                    { name: "additional_emails", label: "Other public emails (comma-separated)" },
                    { name: "phones", label: "Public phones (E.164, comma-separated)" },
                    { name: "city", label: "City" },
                    { name: "state_region", label: "State / region" },
                    { name: "country", label: "Country (from source)" },
                    { name: "business_category", label: "Category" },
                    { name: "source_url", label: "Source URL", type: "url" },
                    { name: "identity_claim", label: "Sourced business fact" },
                  ].map((f) => (
                    <label key={f.name}>
                      {f.label}
                      <input
                        name={f.name}
                        aria-label={f.label}
                        type={f.type || "text"}
                        required={f.required}
                        maxLength={f.name === "business_name" ? 160 : 500}
                      />
                    </label>
                  ))}
                  <label>
                    Source
                    <select name="source_type">
                      <option value="manual">Manual</option>
                      <option value="inbound">Inbound</option>
                      <option value="referral">Referral</option>
                      <option value="approved_source">Approved source</option>
                    </select>
                  </label>
                </div>
                <p className="muted">
                  No outreach permissions are inferred. Duplicates are skipped
                  for review. Use the source URL that actually lists every
                  contact entered on this form.
                </p>
                <button className="primary" disabled={busy}>
                  Save lead
                </button>
              </form>
            )}
            {importing && (
              <div className="inline-editor">
                <h2>Preview before importing</h2>
                <p className="muted">
                  CSV headers: business_name, website_url, email, additional_emails, phones, city, state_region, country, business_category, source_url, source_observed_at, identity_claim. Maximum 500 rows / 1 MB.
                  Duplicates are skipped; existing records and suppressions are
                  retained. Each row’s source URL must support its contact details.
                </p>
                <label htmlFor="csv-data">CSV content</label>
                <textarea
                  id="csv-data"
                  rows={6}
                  value={csv}
                  onChange={(e) => {
                    setCSV(e.target.value);
                    setPreview([]);
                  }}
                />
                <button className="secondary" onClick={previewImport}>
                  Validate & preview
                </button>
                {preview.length > 0 && (
                  <>
                    <div className="import-preview">
                      {preview.map((r) => (
                        <div key={r.row}>
                          Row {r.row}: {r.input?.business_name || "Invalid"} ·{" "}
                          {r.errors.length
                            ? r.errors.join("; ")
                            : r.duplicate
                              ? "Duplicate — skipped"
                              : "Ready"}
                        </div>
                      ))}
                    </div>
                    <button
                      className="primary"
                      disabled={
                        busy || preview.some((r) => r.errors.length > 0)
                      }
                      onClick={() =>
                        void run(async () => {
                          const result = await store.import(
                            preview
                              .filter((r) => !r.duplicate && r.input)
                              .map((r) => r.input as LeadInput),
                          );
                          setNotice(
                            `${result.added} imported; ${result.skipped + preview.filter((r) => r.duplicate).length} duplicate(s) skipped. ${result.processing_attempted} submitted to automatic evidence review; others remain saved for later processing.`,
                          );
                          setImporting(false);
                          setPreview([]);
                          setCSV("");
                        })
                      }
                    >
                      Commit validated import
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Source / location</th>
                    <th>Stage</th>
                    <th>Permission</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <div className="business">
                          <span className="business-icon">
                            {l.business_name[0]}
                          </span>
                          <div>
                            <strong>{l.business_name}</strong>
                            <small>
                              {l.website_url || "Website not recorded"}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {l.source_type}
                        <small>{l.city || "Unknown location"}</small>
                      </td>
                      <td>
                        <span className="stage">
                          {l.status.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>
                        <span className="muted">Unknown / review</span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          aria-label={`Open ${l.business_name}`}
                          onClick={() => void open(l)}
                        >
                          Open <ArrowUpRight size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filtered.length && (
                <div className="empty">
                  <h3>No matching leads.</h3>
                  <p>Add a permitted lead or adjust your filters.</p>
                </div>
              )}
            </div>
          </section>
          <IndiaManualCallingQueue demo={demo} orgId={orgId} role={role} leads={leads} onOpenLead={(lead) => void open(lead)} />
        </>
      )}
    </div>
  );
}
function EvidenceForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (e: Omit<Evidence, "id">) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="evidence-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const f = new FormData(form);
        const observed_at = new Date(
          String(f.get("observed_at")),
        ).toISOString();
        if (Date.parse(observed_at) > Date.now()) {
          setError("Observation cannot be in the future.");
          return;
        }
        setError("");
        void onSubmit({
          claim: String(f.get("claim")),
          source_url: String(f.get("source_url")),
          observed_at,
          confidence: Number(f.get("confidence")),
          reviewed: f.get("reviewed") === "on",
          kind: String(f.get("kind")) as Evidence["kind"],
        }).then(() => form.reset());
      }}
    >
      <h3>Add source evidence</h3>
      <label htmlFor="evidence-claim">
        Observed fact or customer statement
      </label>
      <textarea id="evidence-claim" name="claim" required maxLength={2000} />
      <label htmlFor="evidence-url">Supporting source URL</label>
      <input
        id="evidence-url"
        name="source_url"
        type="url"
        pattern="https?://.*"
        required
      />
      <div className="form-grid">
        <label>
          Observed at
          <input name="observed_at" type="datetime-local" required />
        </label>
        <label>
          Confidence (0–1)
          <input
            name="confidence"
            type="number"
            min="0"
            max="1"
            step="0.05"
            defaultValue="0.7"
            required
          />
        </label>
        <label>
          Factor
          <select name="kind">
            {[
              "observation",
              "intent",
              "relevance",
              "quality",
              "contactability",
              "urgency",
            ].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="checkbox">
        <input type="checkbox" name="reviewed" />I reviewed the source and this
        specific claim.
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="secondary" disabled={busy}>
        Save evidence
      </button>
    </form>
  );
}
