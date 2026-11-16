import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { HarveyOsmCollector } from "../../packages/server/harvey-osm.ts";
import { discoverSerperSearchCandidates } from "../../packages/server/discovery.ts";
import { buildEvidenceOnlyPreview, buildResearchPreview, potentialPreviewService, type ReviewedPreviewEvidence } from "../../packages/server/research-preview.ts";
import { buildAISelectedResearchPreview, aiPreviewSelectionSchema } from "../../packages/server/ai-research-preview.ts";
import { StructuredAI } from "../../packages/server/ai.ts";
import { planAutomaticWebsiteObservation } from "../../packages/server/automatic-website-observation.ts";
import { auditWebsite, type PinnedAuditTransport } from "../../packages/server/audit.ts";
import { storedWebsiteAudit } from "../../packages/server/website-audit-result.ts";
import { handoffCompletedWebsiteAudit } from "../../packages/server/audit-preview-handoff.ts";
import type { ResearchReport } from "../../packages/server/research.ts";
let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000001",
  orgB = "00000000-0000-4000-8000-000000000002";
const userA = "00000000-0000-4000-8000-000000000011",
  userB = "00000000-0000-4000-8000-000000000012";
const leadA = "00000000-0000-4000-8000-000000000021",
  leadB = "00000000-0000-4000-8000-000000000022";
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `create role service_role bypassrls; create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`,
  );
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;alter default privileges in schema public grant all on tables to anon,authenticated;",
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    // pgcrypto is unused: UUID generation is native PostgreSQL. PGlite has no OpenSSL.
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  await db.exec(
    `insert into auth.users values('${userA}'),('${userB}'); insert into public.organizations(id,name) values('${orgA}','Synthetic A'),('${orgB}','Synthetic B'); insert into public.memberships(org_id,user_id,role) values('${orgA}','${userA}','admin'),('${orgB}','${userB}','analyst'); insert into public.leads(id,org_id,business_name,source_type,is_demo) values('${leadA}','${orgA}','Fixture A','manual',true),('${leadB}','${orgB}','Fixture B','manual',true);`,
  );
});
afterAll(async () => {
  await db.close();
});

test("sourced intake, permitted pinned audit and bounded handoff save only a grounded internal preview", async () => {
  const site = "https://synthetic-plumbing.example/";
  const name = "Synthetic Emergency Plumbing";
  await db.exec("begin");
  try {
    const rows = JSON.stringify([{ business_name: name, website_url: site, city: "Ada",
      state_region: "Idaho", country: "USA", business_category: "Plumbing", source_type: "manual",
      source_url: site, email: "office@synthetic-plumbing.example", phones: "+1555010001",
      identity_claim: `${name} in Ada lists 24/7 emergency calls.` }]);
    const intake = (await asUser(userA,
      `select public.import_leads('${orgA}','${rows}'::jsonb) as result`)).rows[0] as
      { result: { created_lead_ids: string[] } };
    const leadId = intake.result.created_lead_ids[0];
    expect(leadId).toBeTruthy();
    const service = "91000000-0000-4000-8000-000000000001";
    await db.query(`insert into public.service_catalog(id,org_id,service_key,name,status,reviewed_by,reviewed_at)
      values($1,$2,'service_09','AI receptionists','active',$3,now())`, [service, orgA, userA]);
    await db.query(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence,kind)
      values($1,$2,'manual','https://directory.example/plumbing',now(),$3,0.8,'observation')`,
    [orgA, leadId, `${name} in Ada is listed as an emergency plumbing business.`]);
    const requested = await asUser(userA,
      `select public.request_website_audit('${orgA}','${leadId}',
       'Reviewed synthetic public site policy',array['synthetic-plumbing.example']) as id`);
    expect(requested.rows).toHaveLength(1);
    const leased = (await db.query<{ id: string; official_url: string }>(
      "select (public.lease_website_audit_job()).id as id, (select official_url from public.website_audit_jobs where state='leased' order by requested_at desc limit 1) as official_url")).rows[0];
    const transport: PinnedAuditTransport = {
      resolve: async () => ["93.184.215.14"],
      fetchPinned: async (url) => ({ status: url.endsWith("/robots.txt") ? 404 : 200,
        headers: {}, body: url.endsWith("/robots.txt") ? "" :
          `<title>${name}</title><meta name="viewport" content="width=device-width"><a href="/contact">Contact</a>`,
        remoteAddress: "93.184.215.14" }),
    };
    const audited = await auditWebsite({ url: site, permissionReference: "Reviewed synthetic public site policy",
      approvedHosts: ["synthetic-plumbing.example"] }, transport);
    const stored = storedWebsiteAudit(audited, site);
    expect(stored).toMatchObject({ outcome: "ok", httpStatus: 200,
      objective: { title: name, hasViewport: true, hasContactPath: true, finalUrl: site } });
    await db.query("select public.finish_website_audit_job($1,$2,$3,$4,$5,$6)",
      [leased.id, stored.outcome, stored.checkedUrl, stored.httpStatus,
        JSON.stringify(stored.objective), stored.errorCode]);
    const handoff = await handoffCompletedWebsiteAudit({ supabaseUrl: "https://staging.supabase.co",
      internalSecret: "x".repeat(32), leadId }, async () => {
      const observation = (await db.query<{ id: string; checked_at: string; outcome: string; http_status: number }>(
        "select id,checked_at,outcome,http_status from public.website_audit_observations where job_id=$1",
        [leased.id])).rows[0];
      const planned = await planAutomaticWebsiteObservation({ lead: { id: leadId, country: "USA",
        website_url: site, is_demo: false, status: "new" }, reviewedAssessmentObservedAt: null,
      audits: [{ ...observation, checked_url: site }], proposals: [] });
      expect(planned?.state).toBe("recorded_url_reachable");
      await db.query(`insert into public.lead_website_observations(org_id,lead_id,source_fingerprint,state,
        recorded_url,checked_url,audit_observation_id,http_status,reason,confidence,observed_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgA, leadId, planned!.source_fingerprint, planned!.state, planned!.recorded_url,
        planned!.checked_url, planned!.audit_observation_id, planned!.http_status,
        planned!.reason, planned!.confidence, planned!.observed_at]);
      expect(potentialPreviewService({ websiteUrl: site, assessment: {
        status: "WORKING", official_url: site, observed_at: planned!.observed_at } })).toBe("service_09");
      const facts = (await db.query<{ id: string; lead_id: string; source_url: string; claim: string;
        confidence: string; observed_at: string; reviewed_by: string | null; rejected_by: string | null }>(
          "select id,lead_id,source_url,claim,confidence,observed_at,reviewed_by,rejected_by from public.lead_evidence where lead_id=$1",
          [leadId])).rows.map((fact) => ({ ...fact, confidence: Number(fact.confidence) }));
      const draft = buildEvidenceOnlyPreview({ businessName: name, fact: facts.find((fact) => fact.source_url === site)!,
        corroboration: facts, serviceKey: "service_09", serviceName: "AI receptionists",
        matchConfidence: 0.5, websiteStatus: "WORKING", requiredLocation: "Ada" });
      await db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
        evidence_ids,fact_claim,basis,confidence,state,generator)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgA, leadId, service, draft.subjects, draft.body, draft.evidence_ids,
        draft.fact_claim, draft.basis, draft.confidence, draft.state, draft.generator]);
      return Response.json({ created: 1, provider_calls: 0, outbound_events: 0 });
    });
    expect(handoff).toBe("submitted");
    expect((await asUser(userA, `select generator,state,basis from public.research_draft_previews where lead_id='${leadId}'`)).rows)
      .toEqual([{ generator: "grounded_template", state: "research_review", basis: "potential_use_case" }]);
    expect((await asUser(userB, `select id from public.research_draft_previews where lead_id='${leadId}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.outbound_drafts where lead_id='${leadId}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.lead_qualifications where lead_id='${leadId}'`)).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});

test("machine website reachability stays separate from reviewed assessment and outbound eligibility", async () => {
  const lead = "69000000-0000-4000-8000-000000000001";
  const job = "69000000-0000-4000-8000-000000000002";
  const audit = "69000000-0000-4000-8000-000000000003";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo,country,website_url)
      values('${lead}','${orgA}','Synthetic Reachable Service','manual',false,'USA','https://reachable.example/');
      insert into public.website_audit_jobs(id,org_id,lead_id,official_url,host_key,approved_hosts,permission_reference,requested_by)
      values('${job}','${orgA}','${lead}','https://reachable.example/','reachable.example',array['reachable.example'],
       'Owner-approved public site check','${userA}');
      insert into public.website_audit_observations(id,org_id,lead_id,job_id,checked_url,outcome,http_status)
      values('${audit}','${orgA}','${lead}','${job}','https://reachable.example/','ok',200);`);
    const planned = await planAutomaticWebsiteObservation({ lead: {
      id: lead, country: "USA", website_url: "https://reachable.example/", is_demo: false, status: "new",
    }, reviewedAssessmentObservedAt: null, audits: [{ id: audit, checked_url: "https://reachable.example/",
      checked_at: new Date().toISOString(), outcome: "ok", http_status: 200 }], proposals: [] });
    expect(planned?.state).toBe("recorded_url_reachable");
    await db.query(`insert into public.lead_website_observations(org_id,lead_id,source_fingerprint,state,
      recorded_url,checked_url,audit_observation_id,http_status,reason,confidence,observed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orgA, lead, planned!.source_fingerprint,
      planned!.state, planned!.recorded_url, planned!.checked_url, planned!.audit_observation_id,
      planned!.http_status, planned!.reason, planned!.confidence, planned!.observed_at]);
    expect((await asUser(userA, `select state from public.lead_website_observations where lead_id='${lead}'`)).rows)
      .toEqual([{ state: "recorded_url_reachable" }]);
    expect((await asUser(userB, `select id from public.lead_website_observations where lead_id='${lead}'`)).rows)
      .toEqual([]);
    await db.exec("savepoint denied_machine_write");
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userA}',false);`);
    await expect(db.query(`insert into public.lead_website_observations(org_id,lead_id,source_fingerprint,state,reason,confidence,observed_at)
      values('${orgA}','${lead}','${"a".repeat(64)}','unknown','Unauthorized machine assertion',0.2,now())`))
      .rejects.toThrow(/permission denied/);
    await db.exec("rollback to savepoint denied_machine_write");
    expect((await db.query(`select id from public.lead_website_assessments where lead_id='${lead}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.lead_qualifications where lead_id='${lead}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.outbound_drafts where lead_id='${lead}'`)).rows).toEqual([]);
    await db.exec("savepoint incomplete_reachability");
    await expect(db.query(`insert into public.lead_website_observations(org_id,lead_id,source_fingerprint,state,
      recorded_url,audit_observation_id,reason,confidence,observed_at)
      values($1,$2,$3,'recorded_url_reachable',$4,$5,$6,0.7,now())`,
      [orgA, lead, "b".repeat(64), planned!.recorded_url, audit,
        "An incomplete HTTP observation cannot establish reachability."]))
      .rejects.toThrow(/check constraint/);
    await db.exec("rollback to savepoint incomplete_reachability");
    await expect(db.query(`insert into public.lead_website_observations(org_id,lead_id,source_fingerprint,state,
      recorded_url,checked_url,audit_observation_id,http_status,reason,confidence,observed_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orgA, lead, planned!.source_fingerprint,
      planned!.state, planned!.recorded_url, planned!.checked_url, planned!.audit_observation_id,
      planned!.http_status, planned!.reason, planned!.confidence, planned!.observed_at]))
      .rejects.toThrow(/duplicate key/);
  } finally { await db.exec("rollback"); }
});

test("research previews are tenant-scoped and cannot enter the outbound draft table", async () => {
  const job = "70000000-0000-4000-8000-000000000001";
  const report = "70000000-0000-4000-8000-000000000002";
  const preview = "70000000-0000-4000-8000-000000000003";
  const service = "70000000-0000-4000-8000-000000000004";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.service_catalog(id,org_id,service_key,name,status,reviewed_by,reviewed_at)
      values('${service}','${orgA}','fixture_preview','Synthetic service','active','${userA}',now());
      insert into public.business_research_jobs(id,org_id,lead_id,provider,source_snapshot)
      values('${job}','${orgA}','${leadA}','serper','{}'::jsonb);
      insert into public.business_research_reports(id,org_id,lead_id,job_id,source_snapshot,state,website,evidence,competitors,opportunity,confidence,reason,expires_at)
      values('${report}','${orgA}','${leadA}','${job}','{}'::jsonb,'ready',
        '{"status":"verified","url":"https://example.org"}'::jsonb,'[]'::jsonb,'[]'::jsonb,
        'business_research_only',0.9,'Synthetic research',now()+interval '1 day');
      insert into public.research_draft_previews(id,org_id,lead_id,report_id,service_id,subjects,body,evidence_ids,confidence,generator)
      values('${preview}','${orgA}','${leadA}','${report}','${service}',array['Synthetic idea one','Synthetic idea two'],
        'This is internal synthetic research copy only.',array['${preview}']::uuid[],0.9,'grounded_template');`);
    expect((await asUser(userA, `select id from public.research_draft_previews where id='${preview}'`)).rows).toHaveLength(1);
    expect((await asUser(userB, `select id from public.research_draft_previews where id='${preview}'`)).rows).toHaveLength(0);
    await db.exec("savepoint denied_owner_insert");
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userA}',false);`);
    await expect(db.query(`insert into public.research_draft_previews(org_id,lead_id,report_id,service_id,subjects,body,evidence_ids,confidence,generator)
      values('${orgA}','${leadA}','${report}','${service}',array['A','B'],'Unauthorized owner copy',array['${preview}']::uuid[],0.9,'grounded_template')`))
      .rejects.toThrow(/permission denied/);
    await db.exec("rollback to savepoint denied_owner_insert");
    expect((await db.query(`select id from public.outbound_drafts where lead_id='${leadA}'`)).rows).toHaveLength(0);
    await expect(db.exec(`insert into public.research_draft_previews(org_id,lead_id,report_id,service_id,subjects,body,evidence_ids,confidence,generator)
      values('${orgB}','${leadB}','${report}','${service}',array['A','B'],'Wrong tenant and report',array['${preview}']::uuid[],0.9,'grounded_template')`))
      .rejects.toThrow();
  } finally { await db.exec("rollback"); }
});

test("ten stored research reports become owner-only previews without contacts or outbound rows", async () => {
  const org = "71000000-0000-4000-8000-000000000001";
  const service = "71000000-0000-4000-8000-000000000002";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.organizations(id,name) values('${org}','Synthetic preview org');
      insert into public.memberships(org_id,user_id,role) values('${org}','${userA}','admin');
      insert into public.service_catalog(id,org_id,service_key,name,status,reviewed_by,reviewed_at)
      values('${service}','${org}','synthetic_booking','Appointment and booking systems','active','${userA}',now());`);
    for (let index = 1; index <= 10; index++) {
      const suffix = String(index).padStart(12, "0");
      const lead = `71000000-0000-4000-8001-${suffix}`;
      const job = `71000000-0000-4000-8002-${suffix}`;
      const reportId = `71000000-0000-4000-8003-${suffix}`;
      const factId = `71000000-0000-4000-8004-${suffix}`;
      const gapId = `71000000-0000-4000-8005-${suffix}`;
      const source = `https://synthetic-${index}.example.org/services`;
      const businessName = `Synthetic Repair Business ${index}`;
      const fact = `${businessName} offers scheduled repair visits in its local market.`;
      const gap = "The owner confirmed that appointment requests need a clearer route.";
      const report: ResearchReport = { state: "ready", website: { status: "verified", url: source },
        evidence: [{ id: factId, kind: "business_fact", claim: fact, url: source,
          observed_at: new Date().toISOString(), confidence: 0.9 }], competitors: [],
        opportunity: "appointment_workflow_review", confidence: 0.9, reason: "Synthetic reviewed research" };
      await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo)
        values('${lead}','${org}','${businessName}','manual',true);
        insert into public.business_research_jobs(id,org_id,lead_id,provider,source_snapshot)
        values('${job}','${org}','${lead}','serper','{}'::jsonb);
        insert into public.business_research_reports(id,org_id,lead_id,job_id,source_snapshot,state,website,evidence,competitors,opportunity,confidence,reason,expires_at)
        values('${reportId}','${org}','${lead}','${job}','{}'::jsonb,'ready',
          '${JSON.stringify(report.website)}'::jsonb,'${JSON.stringify(report.evidence)}'::jsonb,'[]'::jsonb,
          '${report.opportunity}',0.9,'Synthetic reviewed research',now()+interval '1 day');
        insert into public.lead_evidence(id,org_id,lead_id,source_url,source_type,observed_at,claim,confidence,reviewed_by)
        values('${factId}','${org}','${lead}','${source}','official_website',now(),'${fact}',0.9,'${userA}'),
          ('${gapId}','${org}','${lead}','${source}','owner_review',now(),'${gap}',0.9,'${userA}');
        insert into public.lead_service_matches(org_id,lead_id,service_id,status,reason,evidence_ids,confidence)
        values('${org}','${lead}','${service}','verified_gap','Owner confirmed appointment gap',array['${gapId}']::uuid[],0.9);`);
      const stored = await db.query<{ evidence: ResearchReport["evidence"]; website: ResearchReport["website"] }>(
        `select evidence,website from public.business_research_reports where id='${reportId}'`);
      const evidenceRows = await db.query<ReviewedPreviewEvidence>(
        `select id,source_url,claim,confidence,observed_at,reviewed_by,rejected_by
         from public.lead_evidence where org_id='${org}' and lead_id='${lead}'`);
      const preview = buildResearchPreview({ businessName,
        report: { ...report, evidence: stored.rows[0].evidence, website: stored.rows[0].website },
        evidence: evidenceRows.rows, serviceName: "Appointment and booking systems",
        gapEvidenceId: gapId, benefit: "easier appointment requests" });
      await db.query(`insert into public.research_draft_previews(org_id,lead_id,report_id,service_id,subjects,body,evidence_ids,confidence,generator)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [org, lead, reportId, service, preview.subjects,
        preview.body, preview.evidence_ids, preview.confidence, preview.generator]);
    }
    expect((await asUser(userA, `select id from public.research_draft_previews where org_id='${org}'`)).rows).toHaveLength(10);
    expect((await asUser(userB, `select id from public.research_draft_previews where org_id='${org}'`)).rows).toHaveLength(0);
    expect((await db.query(`select id from public.outbound_drafts where org_id='${org}'`)).rows).toHaveLength(0);
  } finally { await db.exec("rollback"); }
});

test("evidence-only research preview persists without a provider report, contact or send permission", async () => {
  const workerGrants = await db.query<{ leads_read: boolean; evidence_read: boolean; leads_write: boolean; evidence_write: boolean }>(
    `select has_table_privilege('service_role','public.leads','select') as leads_read,
      has_table_privilege('service_role','public.lead_evidence','select') as evidence_read,
      has_table_privilege('service_role','public.leads','update') as leads_write,
      has_table_privilege('service_role','public.lead_evidence','insert') as evidence_write`);
  expect(workerGrants.rows[0]).toEqual({ leads_read: true, evidence_read: true,
    leads_write: false, evidence_write: false });
  const tenant = "72000000-0000-4000-8000-000000000001";
  const lead = "72000000-0000-4000-8000-000000000002";
  const service = "72000000-0000-4000-8000-000000000003";
  const factId = "72000000-0000-4000-8000-000000000004";
  const corroborationId = "72000000-0000-4000-8000-000000000005";
  const websiteService = "72000000-0000-4000-8000-000000000006";
  const directoryId = "72000000-0000-4000-8000-000000000007";
  const independentId = "72000000-0000-4000-8000-000000000008";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.organizations(id,name) values('${tenant}','Synthetic source-only research');
      insert into public.memberships(org_id,user_id,role) values('${tenant}','${userA}','admin');
      insert into public.leads(id,org_id,business_name,source_type,is_demo,country)
      values('${lead}','${tenant}','Synthetic Plumbing Inc.','manual',false,'USA');
      insert into public.service_catalog(id,org_id,service_key,name,status)
      values('${service}','${tenant}','service_09','AI receptionists','disabled'),
        ('${websiteService}','${tenant}','service_01','Business websites','disabled');
      insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence)
      values('${factId}','${tenant}','${lead}','manual_identity','https://chamber.example/plumbing',
        'Local Chamber lists Synthetic Plumbing Inc. as offering around-the-clock plumbing service.',now(),0.9),
        ('${corroborationId}','${tenant}','${lead}','website_audit','https://synthetic-plumbing.test/',
        'Synthetic Plumbing Inc. provides plumbing services in its local market.',now(),0.9),
        ('${directoryId}','${tenant}','${lead}','manual_identity','https://city.example/directory',
        'City Water approved tester directory lists Synthetic Plumbing Inc. at 100 Main Street, phone +1555010009, email hello@example.org. This directory does not prove website absence or mailbox deliverability. The full source is preserved for owner review.',now(),0.9),
        ('${independentId}','${tenant}','${lead}','manual_identity','https://utility.test/testers',
        'Utility register lists Synthetic Plumbing Inc. as a local tester.',now(),0.8);`);
    const evidence = (await db.query<ReviewedPreviewEvidence>(`select id,source_url,claim,confidence,observed_at,reviewed_by,rejected_by
      from public.lead_evidence where org_id='${tenant}' and lead_id='${lead}' order by id`)).rows;
    const preview = buildEvidenceOnlyPreview({ businessName: "Synthetic Plumbing Inc.",
      fact: evidence.find((row) => row.id === factId)!, corroboration: evidence,
      serviceKey: "service_09", serviceName: "AI receptionists",
      matchConfidence: 0.5,
      websiteStatus: "WORKING" });
    await db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenant, lead, service, preview.subjects,
      preview.body, preview.evidence_ids, preview.confidence, preview.generator, preview.basis,
      preview.fact_claim]);
    expect((await asUser(userA, `select id from public.research_draft_previews where org_id='${tenant}'`)).rows).toHaveLength(1);
    expect((await asUser(userB, `select id from public.research_draft_previews where org_id='${tenant}'`)).rows).toHaveLength(0);
    expect((await db.query(`select id from public.outbound_drafts where org_id='${tenant}'`)).rows).toHaveLength(0);
    expect((await db.query(`select id from public.contacts where org_id='${tenant}'`)).rows).toHaveLength(0);
    const directoryPreview = buildEvidenceOnlyPreview({ businessName: "Synthetic Plumbing Inc.",
      fact: evidence.find((row) => row.id === directoryId)!,
      corroboration: evidence.filter((row) => [directoryId, independentId].includes(row.id)),
      serviceKey: "service_01", serviceName: "Business websites",
      matchConfidence: 0.65, websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED" });
    expect(evidence.find((row) => row.id === directoryId)!.claim).toHaveLength(250);
    expect(directoryPreview.fact_claim.length).toBeLessThanOrEqual(180);
    await db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenant, lead, websiteService, directoryPreview.subjects, directoryPreview.body,
      directoryPreview.evidence_ids, directoryPreview.confidence, directoryPreview.generator,
      directoryPreview.basis, directoryPreview.fact_claim]);
    expect((await db.query(`select id from public.research_draft_previews where org_id='${tenant}'`)).rows).toHaveLength(2);
    const storedOriginal = (await db.query<{ claim: string }>(`select claim from public.lead_evidence
      where org_id='${tenant}' and id='${directoryId}'`)).rows[0].claim;
    expect(storedOriginal).toHaveLength(250);
    expect(storedOriginal).toContain("hello@example.org");
    await expect(db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenant, lead, service, preview.subjects, preview.body, preview.evidence_ids, preview.confidence,
      preview.generator, preview.basis, preview.fact_claim])).rejects.toThrow(/duplicate key/);
  } finally { await db.exec("rollback"); }
});

test("mock Groq selection saves one owner-only, evidence-bound preview without outbound eligibility", async () => {
  const org = "73000000-0000-4000-8000-000000000001";
  const lead = "73000000-0000-4000-8000-000000000002";
  const otherLead = "73000000-0000-4000-8000-000000000003";
  const service = "73000000-0000-4000-8000-000000000004";
  const factId = "73000000-0000-4000-8000-000000000005";
  const corroborationId = "73000000-0000-4000-8000-000000000006";
  const otherFactId = "73000000-0000-4000-8000-000000000007";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.organizations(id,name) values('${org}','Synthetic Groq preview');
      insert into public.memberships(org_id,user_id,role) values('${org}','${userA}','admin');
      insert into public.leads(id,org_id,business_name,source_type,is_demo,country)
      values('${lead}','${org}','Cedar Pipe Works','manual',false,'USA'),
        ('${otherLead}','${org}','Different Pipe Works','manual',false,'USA');
      insert into public.service_catalog(id,org_id,service_key,name,status)
      values('${service}','${org}','service_01','Business websites','disabled');
      insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence)
      values('${factId}','${org}','${lead}','manual_identity','https://city.example/testers',
        'City Water approved tester directory lists Cedar Pipe Works at 100 Main Street, phone +1555010009, email hello@example.org. Directory does not establish website absence.',now(),0.9),
        ('${corroborationId}','${org}','${lead}','manual_identity','https://utility.test/testers',
        'Utility register lists Cedar Pipe Works as a local tester.',now(),0.8),
        ('${otherFactId}','${org}','${otherLead}','manual_identity','https://city.example.org/other',
        'City Water directory lists Different Pipe Works as a local tester.',now(),0.9);
      insert into public.lead_website_assessments(org_id,lead_id,status,reason,confidence,evidence_ids)
      values('${org}','${lead}','NO_OFFICIAL_WEBSITE_DISCOVERED','Synthetic bounded checks did not find an official website',0.7,array['${factId}','${corroborationId}']::uuid[]);
      insert into public.lead_service_matches(org_id,lead_id,service_id,status,reason,evidence_ids,confidence)
      values('${org}','${lead}','${service}','research_needed','Conditional website idea only',array['${factId}']::uuid[],0.65);`);
    const evidence = (await db.query<ReviewedPreviewEvidence & { lead_id: string }>(
      `select id,lead_id,source_url,claim,confidence,observed_at,reviewed_by,rejected_by
       from public.lead_evidence where org_id='${org}' order by id`)).rows;
    const mockTransport: typeof fetch = async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ fact_id: factId, cta_variant: "short_example", subject_variant: "second" }) } }],
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    });
    const ai = new StructuredAI({ provider: "groq", apiKey: "mock-only", model: "openai/gpt-oss-120b",
      freeTierApproved: true, maxTokens: 64, timeoutMs: 1000 }, {
      reserve: async () => "synthetic-reservation", settle: async () => {},
    }, mockTransport);
    const selected = await ai.generate(aiPreviewSelectionSchema, {
      business_name: "Cedar Pipe Works", evidence_ids: [factId, corroborationId],
    });
    const preview = buildAISelectedResearchPreview({ leadId: lead,
      businessName: "Cedar Pipe Works", evidence,
      selection: selected.data, serviceKey: "service_01", serviceName: "Business websites",
      matchConfidence: 0.65, websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED" });
    expect(preview.generator).toBe("groq_selected_template");
    expect(preview.evidence_ids).toEqual([factId, corroborationId]);
    expect(preview.body).toContain(preview.fact_claim);
    expect(preview.body).toContain("If a dedicated website is in your plans");
    expect(preview.body).not.toContain("hello@example.org");
    await db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [org, lead, service, preview.subjects, preview.body, preview.evidence_ids, preview.confidence,
      preview.generator, preview.basis, preview.fact_claim]);
    expect((await asUser(userA, `select generator,state,body from public.research_draft_previews where lead_id='${lead}'`)).rows)
      .toMatchObject([{ generator: "groq_selected_template", state: "research_review", body: preview.body }]);
    expect((await asUser(userB, `select id from public.research_draft_previews where lead_id='${lead}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.contacts where lead_id='${lead}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.outbound_drafts where lead_id='${lead}'`)).rows).toEqual([]);
    expect(() => buildAISelectedResearchPreview({ leadId: lead, businessName: "Cedar Pipe Works",
      evidence, selection: { fact_id: otherFactId, cta_variant: "brief_example", subject_variant: "first" },
      serviceKey: "service_01", serviceName: "Business websites", matchConfidence: 0.65,
      websiteStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED" })).toThrow("AI_EVIDENCE_NOT_FOR_LEAD");
    await db.exec("savepoint duplicate_preview");
    await expect(db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [org, lead, service, preview.subjects, preview.body, preview.evidence_ids, preview.confidence,
      preview.generator, preview.basis, preview.fact_claim])).rejects.toThrow(/duplicate key/);
    await db.exec("rollback to savepoint duplicate_preview");
    expect((await db.query(`select id from public.research_draft_previews where lead_id='${lead}'`)).rows).toHaveLength(1);
  } finally { await db.exec("rollback"); }
});

test("stale Gmail backlog rolls forward without changing approved copy, sender or tenant", async () => {
  await db.exec("begin");
  try {
    const org = "90000000-0000-4000-8000-000000000001";
    const lead = "90000000-0000-4000-8000-000000000002";
    const contact = "90000000-0000-4000-8000-000000000003";
    const campaign = "90000000-0000-4000-8000-000000000004";
    const account = "90000000-0000-4000-8000-000000000005";
    const draft = "90000000-0000-4000-8000-000000000006";
    const outbox = "90000000-0000-4000-8000-000000000007";
    await db.exec(`insert into public.organizations(id,name,outbound_paused,email_live_approved,email_daily_cap,email_monthly_cap,email_timezone)
      values('${org}','Rollback-only fixture',false,true,1,10,'UTC');
      insert into public.memberships(org_id,user_id,role) values('${org}','${userA}','admin');
      insert into public.leads(id,org_id,business_name,source_type,is_demo,country,outreach_timezone,outreach_timezone_reviewed_at)
      values('${lead}','${org}','Synthetic backlog business','manual',false,'United States','America/New_York',now());
      insert into public.contacts(id,org_id,lead_id,email,email_normalized)
      values('${contact}','${org}','${lead}','fixture@example.org','fixture@example.org');
      insert into public.campaigns(id,org_id,name,channel,state,daily_send_cap)
      values('${campaign}','${org}','Synthetic campaign','email','active',1);
      insert into public.external_connections(id,org_id,provider,provider_account_id,state,verified_at)
      values('${account}','${org}','gmail','rollover-fixture@example.org','connected',now());
      insert into public.gmail_account_settings(org_id,connection_id,timezone,window_start,window_end,daily_cap,monthly_cap,paused,send_enabled)
      values('${org}','${account}','America/New_York','09:00','17:00',1,10,false,true);
      insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
      values('${draft}','${org}','${campaign}','${lead}','${contact}','email','Fixture subject','Approved fixture copy','queued');
      insert into public.email_outbox(id,org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,
        recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at)
      values('${outbox}','${org}','${campaign}','${draft}','${lead}','${contact}','${account}',
        'fixture@example.org','Fixture subject','Approved fixture copy','${"a".repeat(64)}','Fixture sender','${draft}',now()-interval '2 days');
      insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
      values('90000000-0000-4000-8000-000000000008','${org}','${campaign}','${lead}','${contact}',
        'email','Today fixture','Approved today copy','queued');
      insert into public.email_outbox(org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,
        recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at)
      values('${org}','${campaign}','90000000-0000-4000-8000-000000000008','${lead}','${contact}','${account}',
        'fixture@example.org','Today fixture','Approved today copy','${"b".repeat(64)}','Fixture sender',
        'today-fixture',now());`);
    expect((await db.query<{ result: number }>(`select public.rollover_email_backlog('${org}',10) as result`)).rows[0].result).toBe(1);
    const saved = (await db.query<{ state: string; sender_connection_id: string; subject: string; body: string; scheduled_at: string }>(
      `select state,sender_connection_id,subject,body,scheduled_at from public.email_outbox where id='${outbox}'`)).rows[0];
    expect(saved).toMatchObject({ state: "queued", sender_connection_id: account,
      subject: "Fixture subject", body: "Approved fixture copy" });
    expect(new Date(saved.scheduled_at).getTime()).toBeGreaterThan(Date.now());
    expect((await db.query<{ result: number }>(`select public.rollover_email_backlog('${org}',10) as result`)).rows[0].result).toBe(0);
    expect((await db.query<{ count: number }>(`select count(*)::int as count from public.email_outbox where org_id='${org}'`)).rows[0].count).toBe(2);
    const summary = (await asUser(userA, `select public.gmail_backlog_summary('${org}') as result`)).rows[0] as
      { result: { approved_backlog: number; future_queued: number } };
    expect(summary.result).toMatchObject({ approved_backlog: 0, future_queued: 1 });
    await db.exec(`update public.organizations set outbound_paused=true where id='${org}';
      update public.email_outbox set scheduled_at=now()-interval '2 days' where id='${outbox}'`);
    expect((await db.query<{ result: number }>(`select public.rollover_email_backlog('${org}',10) as result`)).rows[0].result).toBe(0);
  } finally { await db.exec("rollback"); }
  await expect(asUser(userA, "select public.rollover_email_backlog('90000000-0000-4000-8000-000000000001',10)"))
    .rejects.toThrow(/permission denied/);
});

test("Vibe keeps distinct Serper, Harvey and official emails with independent evidence and review", async () => {
  await db.exec("begin");
  try {
  const lead = "00000000-0000-4000-8000-000000000251";
  const website = "https://aster.example/contact";
  const osm = "https://www.openstreetmap.org/node/251";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,website_url,normalized_domain,is_demo)
    values('${lead}','${orgA}','Aster Jewellery','serper','${website}','aster.example',false);
    insert into public.lead_discovery_sources(org_id,lead_id,source,actual_provider,source_url,observed_at)
    values('${orgA}','${lead}','serper','serper','${website}',now()),
    ('${orgA}','${lead}','harvey','harvey_osm','${osm}',now());`);
  const observed = new Date().toISOString();
  const record = async (provider: string, items: Array<{kind: string;value: string;source_url: string;evidence_excerpt: string}>) =>
    db.query(`select public.record_vibe_contact_observations('${orgA}','${lead}','${provider}',
      '${JSON.stringify(items.map((item) => ({ ...item, observed_at: observed, confidence: 0.6 }))).replaceAll("'", "''")}'::jsonb)`);
  await record("serper", [{ kind: "email", value: "hello@aster.example", source_url: website,
    evidence_excerpt: "Email hello@aster.example" }, { kind: "email", value: "contact@aster.example", source_url: website,
    evidence_excerpt: "Contact contact@aster.example" }]);
  await record("harvey", [{ kind: "email", value: "HELLO@aster.example", source_url: osm,
    evidence_excerpt: "contact:email=HELLO@aster.example" }, { kind: "email", value: "business@example.com", source_url: osm,
    evidence_excerpt: "email=business@example.com" }]);
  await record("official_website", [{ kind: "email", value: "sales@aster.example", source_url: website,
    evidence_excerpt: "Sales sales@aster.example" }]);
  await record("serper", [{ kind: "email", value: "hello@aster.example", source_url: website,
    evidence_excerpt: "Email hello@aster.example" }]);
  const points = await asUser(userA, `select id,normalized_value,review_status,preferred from public.vibe_contact_points where lead_id='${lead}' order by normalized_value`);
  const pointRows = points.rows as Array<{ id: string; normalized_value: string }>;
  expect(pointRows.map((row) => row.normalized_value)).toEqual(["business@example.com", "contact@aster.example", "hello@aster.example", "sales@aster.example"]);
  const hello = pointRows.find((row) => row.normalized_value === "hello@aster.example")!;
  const sources = await asUser(userA, `select source_provider from public.vibe_contact_sources where point_id='${hello.id}' order by source_provider`);
  expect((sources.rows as Array<{ source_provider: string }>).map((row) => row.source_provider)).toEqual(["harvey", "serper"]);
  expect((await asUser(userB, `select id from public.vibe_contact_points where lead_id='${lead}'`)).rows).toEqual([]);
  await asUser(userA, `select public.review_vibe_contact_point('${orgA}','${hello.id}','approve','general','Official listing and search evidence belong to Aster.')`);
  await asUser(userA, `select public.set_vibe_preferred_email('${orgA}','${hello.id}')`);
  await record("official_website", [{ kind: "email", value: "sales@aster.example", source_url: website,
    evidence_excerpt: "Sales sales@aster.example" }]);
  expect((await asUser(userA, `select preferred from public.vibe_contact_points where id='${hello.id}'`)).rows[0]).toEqual({ preferred: true });
  expect((await asUser(userA, `select email_normalized,verified_at from public.contacts where lead_id='${lead}'`)).rows).toEqual([
    { email_normalized: "hello@aster.example", verified_at: null },
  ]);
  expect((await asUser(userA, `select count(*)::int as count from public.vibe_contact_points where lead_id='${lead}'`)).rows[0]).toEqual({ count: 4 });
  } finally {
    await db.exec("rollback");
  }
});

test("Vibe contact review is inaccessible across organizations", async () => {
  await expect(asUser(userB, `select public.review_vibe_contact_point('${orgA}','${leadA}','approve','general','Synthetic source review is complete.')`)).rejects.toThrow(/FORBIDDEN/);
  await expect(asUser(userA, `select public.review_vibe_contact_point('${orgA}','${leadA}',null,'general','Synthetic source review is complete.')`)).rejects.toThrow(/INVALID_CONTACT_REVIEW/);
});

test("Vibe independently queues, reserves and saves official-page contacts with tenant and budget gates", async () => {
  await db.exec("begin");
  try {
    const lead = "00000000-0000-4000-8000-000000000252";
    const website = "https://sura.example/";
    await db.exec(`insert into public.leads(id,org_id,business_name,source_type,website_url,is_demo)
      values('${lead}','${orgA}','Sura Jewels','manual','${website}',false);
      insert into public.lead_website_assessments(org_id,lead_id,status,official_url,reason,confidence)
      values('${orgA}','${lead}','WORKING','${website}','Reviewed official business site',0.9);
      insert into public.discovery_targeting(org_id,vibe_contact_discovery_enabled)
      values('${orgA}',true) on conflict(org_id) do update set vibe_contact_discovery_enabled=true;
      update public.organizations set research_monthly_credit_cap=21 where id='${orgA}';`);
    const requested = await asUser(userA, `select public.request_vibe_contact_discovery('${orgA}','${lead}',false) as id`);
    const job = (requested.rows[0] as { id: string }).id;
    expect((await asUser(userA, `select public.request_vibe_contact_discovery('${orgA}','${lead}',false) as id`)).rows[0])
      .toEqual({ id: job });
    const lease = (await db.query(`select id,lease_token from public.lease_vibe_contact_discovery_job()`))
      .rows[0] as { id: string; lease_token: string };
    expect(lease.id).toBe(job);
    await db.exec(`insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,
      first_discovered_at,last_cross_checked_at) values('${orgA}','${lead}','email',
      'hello@sura.example','hello@sura.example',now(),now())`);
    expect((await db.query(`select public.reserve_vibe_contact_discovery_credits('${job}','${lease.lease_token}') as ok`)).rows[0])
      .toEqual({ ok: true });
    const evidence = [{ kind: "email", value: "hello@sura.example", source_url: "https://sura.example/contact",
      observed_at: new Date().toISOString(), evidence_excerpt: "Asha Shah Founder hello@sura.example",
      contact_name: "Asha Shah", role: "Founder", confidence: 0.65 }];
    const payload = JSON.stringify(evidence).replaceAll("'", "''");
    expect((await db.query(`select public.finish_vibe_contact_discovery_job('${job}','${lease.lease_token}',
      '${payload}'::jsonb,null) as saved`)).rows[0]).toEqual({ saved: 1 });
    const records = await asUser(userA, `select p.normalized_value,p.review_status,p.contact_name,p.role,s.source_provider,s.source_url
      from public.vibe_contact_points p join public.vibe_contact_sources s on s.point_id=p.id
      where p.org_id='${orgA}' and p.lead_id='${lead}'`);
    expect(records.rows).toEqual([{ normalized_value: "hello@sura.example", review_status: "pending",
      contact_name: "Asha Shah", role: "Founder",
      source_provider: "vibe", source_url: "https://sura.example/contact" }]);
    expect((await asUser(userB, `select id from public.vibe_contact_discovery_jobs where id='${job}'`)).rows).toEqual([]);
    expect((await asUser(userA, `select public.request_vibe_contact_discovery('${orgA}','${lead}',false) as id`)).rows[0])
      .toEqual({ id: job });
    expect((await db.query(`select reserved_credits from public.research_credit_usage where org_id='${orgA}'
      and provider='serper' order by month_start desc limit 1`)).rows[0]).toEqual({ reserved_credits: 21 });
  } finally {
    await db.exec("rollback");
  }
});

test("Vibe listing mode requires reviewed source identity and persists only that listing URL", async () => {
  await db.exec("begin");
  try {
    const lead = "00000000-0000-4000-8000-000000000253";
    const listing = "https://directory.example/surat-jewellers";
    await db.exec(`insert into public.leads(id,org_id,business_name,city,source_type,is_demo)
      values('${lead}','${orgA}','Aster Jewellery','Surat','serper',false);
      insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence,reviewed_by,review_note)
      values('${orgA}','${lead}','serper','${listing}',now(),
      'Aster Jewellery in Surat is listed here',0.8,'${userA}','I reviewed this listing identity.');
      insert into public.discovery_targeting(org_id,vibe_contact_discovery_enabled)
      values('${orgA}',true) on conflict(org_id) do update set vibe_contact_discovery_enabled=true;
      update public.organizations set research_monthly_credit_cap=21 where id='${orgA}';`);
    const requested = await asUser(userA, `select public.request_vibe_contact_discovery('${orgA}','${lead}',false) as id`);
    const job = (requested.rows[0] as { id: string }).id;
    const lease = (await db.query(`select id,lease_token,source_kind,target_url
      from public.lease_vibe_contact_discovery_job()`)).rows[0] as {
      id: string; lease_token: string; source_kind: string; target_url: string;
    };
    expect(lease).toMatchObject({ id: job, source_kind: "listing", target_url: listing });
    expect((await db.query(`select public.reserve_vibe_contact_discovery_credits('${job}','${lease.lease_token}') as ok`)).rows[0])
      .toEqual({ ok: true });
    const evidence = [{ kind: "email", value: "asterstudio@example.com", source_url: listing,
      observed_at: new Date().toISOString(), evidence_excerpt: "Aster Jewellery Surat Email asterstudio@example.com",
      confidence: 0.5 }];
    expect((await db.query(`select public.finish_vibe_contact_discovery_job('${job}','${lease.lease_token}',
      '${JSON.stringify(evidence)}'::jsonb,null) as saved`)).rows[0]).toEqual({ saved: 1 });
    expect((await asUser(userA, `select normalized_value,review_status from public.vibe_contact_points
      where org_id='${orgA}' and lead_id='${lead}'`)).rows).toEqual([
      { normalized_value: "asterstudio@example.com", review_status: "pending" },
    ]);
    expect((await asUser(userB, `select id from public.vibe_contact_points where lead_id='${lead}'`)).rows).toEqual([]);
  } finally {
    await db.exec("rollback");
  }
});


async function asUser(user: string, sql: string) {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`,
  );
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role");
  }
}
test("anonymous cannot read lead PII", async () => {
  await db.exec("set role anon");
  try {
    await expect(db.query("select * from public.leads")).rejects.toThrow(
      /permission denied/,
    );
  } finally {
    await db.exec("reset role");
  }
});
test("Edge service role has only the needed base-table reads", async () => {
  const grants = await db.query(`select
    has_table_privilege('service_role','public.organizations','SELECT') as org_read,
    has_table_privilege('service_role','public.suppressions','SELECT') as suppression_read,
    has_table_privilege('service_role','public.organizations','INSERT') as org_write,
    has_table_privilege('service_role','public.suppressions','INSERT') as suppression_write`);
  expect(grants.rows[0]).toEqual({
    org_read: true, suppression_read: true, org_write: false, suppression_write: false,
  });
});
test("admin sees only own organization and cannot guess cross-tenant lead", async () => {
  expect((await asUser(userA, "select id from public.leads")).rows).toEqual([
    { id: leadA },
  ]);
  expect(
    (await asUser(userA, `select * from public.leads where id='${leadB}'`))
      .rows,
  ).toEqual([]);
});
test("cross-org insert and role escalation denied", async () => {
  await expect(
    asUser(
      userA,
      `insert into public.leads(org_id,business_name,source_type) values('${orgB}','Attack','manual')`,
    ),
  ).rejects.toThrow(/row-level security/);
  await expect(
    asUser(userB, `update public.memberships set role='admin'`),
  ).rejects.toThrow(/permission denied/);
});
test("analyst cannot mutate leads or approve drafts", async () => {
  expect(
    (
      await asUser(
        userB,
        `update public.leads set business_name='Attack' where id='${leadB}' returning id`,
      )
    ).rows,
  ).toEqual([]);
  await expect(
    asUser(userB, `update public.outbound_drafts set state='approved'`),
  ).rejects.toThrow(/permission denied/);
});
test("even privileged cross-org relationship fails", async () => {
  await expect(
    db.exec(
      `insert into public.contacts(org_id,lead_id,email) values('${orgA}','${leadB}','fixture@example.org')`,
    ),
  ).rejects.toThrow(/foreign key/);
});
test("job keys are unique within organization and defaults are safe", async () => {
  await db.exec(
    `insert into public.jobs(org_id,kind,idempotency_key) values('${orgA}','fake','same')`,
  );
  await expect(
    db.exec(
      `insert into public.jobs(org_id,kind,idempotency_key) values('${orgA}','fake','same')`,
    ),
  ).rejects.toThrow(/unique/);
  expect(
    (
      await db.query<{ outbound_paused: boolean }>(
        "select outbound_paused from public.organizations",
      )
    ).rows.every((r) => r.outbound_paused),
  ).toBe(true);
});
test("admin CRM changes create immutable audit event", async () => {
  await asUser(
    userA,
    `update public.leads set business_name='Fixture updated' where id='${leadA}'`,
  );
  expect(
    (
      await asUser(
        userA,
        `select action from public.audit_events where entity_id='${leadA}' and action='update'`,
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    asUser(userA, "delete from public.audit_events"),
  ).rejects.toThrow(/permission denied/);
});
test("draft insert cannot smuggle approval and valid draft can be saved", async () => {
  const contact = "00000000-0000-4000-8000-000000000031";
  await db.exec(
    `insert into public.contacts(id,org_id,lead_id,email) values('${contact}','${orgA}','${leadA}','fixture@example.org')`,
  );
  await expect(
    asUser(
      userA,
      `insert into public.outbound_drafts(org_id,lead_id,contact_id,channel,body,approval_by) values('${orgA}','${leadA}','${contact}','email','Synthetic','${userA}')`,
    ),
  ).rejects.toThrow(/row-level security/);
  expect(
    (
      await asUser(
        userA,
        `insert into public.outbound_drafts(org_id,lead_id,contact_id,channel,body) values('${orgA}','${leadA}','${contact}','email','Synthetic') returning state`,
      )
    ).rows,
  ).toEqual([{ state: "draft" }]);
});
test("all sensitive tables have RLS enabled", async () => {
  const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `select relname,relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=pg_class.relnamespace where nspname='public' and relkind='r'`,
  );
  expect(rows.length).toBe(65);
  expect(rows.every((r) => r.relrowsecurity)).toBe(true);
});
test("org-scoped relationships and function grants fail closed", async () => {
  const contactLeadKeys = (await db.query<{ conname: string }>(`
    select conname from pg_constraint
    where conrelid='public.contacts'::regclass
      and confrelid='public.leads'::regclass and contype='f'`)).rows;
  expect(contactLeadKeys.map((key) => key.conname)).toContain("contacts_org_id_lead_id_fkey");
  const tables = (await db.query<{ id: number; name: string; has_org: boolean }>(`
    select c.oid::int id,c.relname name,bool_or(a.attname='org_id') has_org
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname='public' and c.relkind='r' group by c.oid,c.relname`)).rows;
  const byId = new Map(tables.map((table) => [table.id, table]));
  const foreignKeys = (await db.query<{ src: number; target: number; definition: string }>(`
    select c.conrelid::int src,c.confrelid::int target,pg_get_constraintdef(c.oid) definition
    from pg_constraint c join pg_namespace n on n.oid=c.connamespace
    where n.nspname='public' and c.contype='f'`)).rows;
  const relationships = new Map<string, string[]>();
  for (const fk of foreignKeys) {
    const child = byId.get(fk.src), parent = byId.get(fk.target);
    if (!child?.has_org || !parent?.has_org) continue;
    const pair = `${child.name} -> ${parent.name}`;
    relationships.set(pair, [...(relationships.get(pair) ?? []), fk.definition]);
  }
  const unbound = [...relationships].filter(([, definitions]) =>
    !definitions.some((definition) =>
      /FOREIGN KEY \([^)]*org_id[^)]*\) REFERENCES [^(]+\([^)]*org_id[^)]*\)/i.test(definition)));
  expect(unbound).toEqual([]);

  const anonFunctions = (await db.query<{ name: string }>(`
    select p.oid::regprocedure::text name from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and has_function_privilege('anon',p.oid,'EXECUTE')`)).rows;
  expect(anonFunctions).toEqual([]);

  const job = "00000000-0000-4000-8000-0000000000a1";
  await db.exec(`insert into public.website_audit_jobs
    (id,org_id,lead_id,official_url,host_key,approved_hosts,permission_reference,requested_by)
    values('${job}','${orgA}','${leadA}','https://example.org','example.org',
      array['example.org'],'Synthetic approved site check','${userA}')`);
  await expect(db.exec(`insert into public.website_audit_observations
    (org_id,lead_id,job_id,checked_url,outcome,http_status)
    values('${orgB}','${leadB}','${job}','https://example.org','ok',200)`))
    .rejects.toThrow(/foreign key/);
  await db.exec(`delete from public.website_audit_jobs where id='${job}'`);
});
test("catalog starts disabled, targets are tenant-scoped, and discovery provenance is service-only", async () => {
  expect((await asUser(userA, `select public.ensure_service_catalog('${orgA}') as added`)).rows).toEqual([{ added: 24 }]);
  expect((await asUser(userA, `select public.ensure_service_catalog('${orgA}') as added`)).rows).toEqual([{ added: 0 }]);
  const services = await asUser(userA, `select status from public.service_catalog where org_id='${orgA}'`);
  expect(services.rows).toHaveLength(24);
  expect(services.rows.every((row) => (row as { status: string }).status === "disabled")).toBe(true);
  const guidance = await asUser(userA, `select service_key,description,observable_signals,disqualification_criteria,evidence_requirements,potential_benefits,approved_proof,configured_price
    from public.service_catalog where org_id='${orgA}'`);
  expect(guidance.rows).toHaveLength(24);
  expect(guidance.rows.every((row) => {
    const item = row as { description: string; observable_signals: string[]; disqualification_criteria: string[];
      evidence_requirements: string[]; potential_benefits: string[]; approved_proof: unknown[]; configured_price: string | null };
    return item.description.length > 20 && item.observable_signals.length > 0 && item.disqualification_criteria.length > 0 &&
      item.evidence_requirements.length > 0 && item.potential_benefits.length > 0 && item.approved_proof.length === 0 && item.configured_price === null;
  })).toBe(true);
  expect((await asUser(userB, "select * from public.service_catalog")).rows).toEqual([]);
  await expect(asUser(userB, `select public.ensure_service_catalog('${orgA}')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `insert into public.lead_discovery_sources(org_id,lead_id,source,actual_provider,observed_at) values('${orgA}','${leadA}','harvey','harvey',now())`)).rejects.toThrow(/permission denied/);
  await expect(asUser(userA, `insert into public.discovery_targeting(org_id,updated_by) values('${orgB}','${userA}')`)).rejects.toThrow(/row-level security/);
  await asUser(userA, `insert into public.discovery_targeting(org_id,updated_by) values('${orgA}','${userA}')`);
  expect((await asUser(userA, `select max_new_prospects,serper_discovery_enabled,harvey_discovery_enabled from public.discovery_targeting where org_id='${orgA}'`)).rows).toEqual([{ max_new_prospects: 0, serper_discovery_enabled: false, harvey_discovery_enabled: false }]);
});
test("follow-up wait skips weekends and one-step limit is enforced at the database boundary", async () => {
  const due = await db.query<{ due: string }>(`select private.followup_earliest('2026-10-16 10:00:00+00'::timestamptz,2::smallint,'UTC','09:00'::time) as due`);
  expect(new Date(due.rows[0].due).toISOString()).toBe("2026-10-20T10:00:00.000Z");
  await expect(asUser(userB, `select public.set_followup_wait_days('${orgA}',1::smallint)`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.set_followup_wait_days('${orgA}',1::smallint)`);
  expect((await asUser(userA, `select followup_wait_business_days from public.organizations where id='${orgA}'`)).rows).toEqual([{ followup_wait_business_days: 1 }]);
  await expect(asUser(userA, `select public.create_email_sequence('${orgA}',gen_random_uuid(),gen_random_uuid(),now()+interval '2 days',gen_random_uuid(),now()+interval '4 days')`)).rejects.toThrow("ONE_FOLLOWUP_MAXIMUM");
  await asUser(userA, `select public.set_followup_wait_days('${orgA}',2::smallint)`);
});

test("weekly targeting settings are tenant-scoped, editable and keep provider switches off", async () => {
  await db.exec("begin");
  try {
    const before = (await asUser(userA, `select weekly_countries,weekly_timezone,weekly_fallback_enabled,daily_website_target,daily_automation_target,daily_india_manual_target,serper_discovery_enabled
      from public.discovery_targeting where org_id='${orgA}'`)).rows[0] as Record<string, unknown>;
    expect(before).toMatchObject({ weekly_timezone: "Asia/Kolkata", weekly_fallback_enabled: false,
      daily_website_target: 350, daily_automation_target: 150, daily_india_manual_target: 100, serper_discovery_enabled: false });
    expect(before.weekly_countries).toEqual(["United States", "New Zealand", "United Arab Emirates", "Australia", "United Kingdom", "United States", "Australia"]);
    await asUser(userA, `update public.discovery_targeting set weekly_countries=array['Australia','United States','New Zealand','United Arab Emirates','United Kingdom','United States','Australia'],
      weekly_timezone='UTC',weekly_fallback_enabled=true,daily_website_target=300,daily_automation_target=200,daily_india_manual_target=80,updated_by='${userA}' where org_id='${orgA}'`);
    expect((await asUser(userA, `select weekly_countries,weekly_timezone,weekly_fallback_enabled,daily_website_target,daily_automation_target,daily_india_manual_target,serper_discovery_enabled
      from public.discovery_targeting where org_id='${orgA}'`)).rows[0]).toMatchObject({ weekly_timezone: "UTC", weekly_fallback_enabled: true,
      daily_website_target: 300, daily_automation_target: 200, daily_india_manual_target: 80, serper_discovery_enabled: false });
    expect((await asUser(userB, `select weekly_timezone from public.discovery_targeting where org_id='${orgA}'`)).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
  await expect(db.query(`update public.discovery_targeting set weekly_countries=array['India','India','India','India','India','India','India'] where org_id='${orgA}'`))
    .rejects.toThrow(/weekly_countries_seven_approved/);
});
test("Serper and Harvey observations share one CRM record, retain real provenance, and hold ambiguous identity", async () => {
  const serperRun = "00000000-0000-4000-8000-000000000081";
  const harveyRun = "00000000-0000-4000-8000-000000000082";
  await asUser(userA, `update public.discovery_targeting set max_new_prospects=3,updated_by='${userA}' where org_id='${orgA}'`);
  await db.exec(`insert into public.discovery_runs(id,org_id,provider,state,requested_limit) values
    ('${serperRun}','${orgA}','serper','leased',3),('${harveyRun}','${orgA}','harvey','leased',3)`);
  const ingest = (run: string, source: string, provider: string, name: string, website: string | null, city: string, record: string) =>
    `select public.ingest_discovered_business('${orgA}','${run}','${source}','${provider}','${name}',${website ? `'${website}'` : "null"},'${city}','Maharashtra','India','https://example.org/source/${record}','${record}',now()) as result`;
  await expect(db.query(ingest(serperRun,"serper","serper","Zephyr Textiles","https://zephyr.example.org","Pune","serper-1"))).rejects.toThrow("DISCOVERY_DISABLED");
  await asUser(userA, `update public.discovery_targeting set serper_discovery_enabled=true,harvey_discovery_enabled=true,updated_by='${userA}' where org_id='${orgA}'`);
  const serper = (await db.query<{ result: { state: string; lead_id: string } }>(ingest(serperRun,"serper","serper","Zephyr Textiles","https://zephyr.example.org","Pune","serper-1"))).rows[0].result;
  expect(serper.state).toBe("created");
  const both = (await db.query<{ result: { state: string; lead_id: string } }>(ingest(harveyRun,"harvey","harvey_osm","Zephyr Textiles","https://zephyr.example.org","Pune","osm-1"))).rows[0].result;
  expect(both).toEqual({ state: "matched", lead_id: serper.lead_id });
  expect((await db.query<{ website_url: string | null }>(`select website_url from public.leads where id='${serper.lead_id}'`)).rows[0].website_url).toBeNull();
  expect((await db.query<{ proposed_website_url: string }>(`select proposed_website_url from public.lead_discovery_sources where source='harvey' and lead_id='${serper.lead_id}'`)).rows[0].proposed_website_url).toBe("https://zephyr.example.org");
  await expect(asUser(userB, `select public.record_manual_identity_evidence('${orgA}','${serper.lead_id}','https://zephyr.example.org','Zephyr Textiles makes textiles in Pune.','I checked the proposed site and its business name.')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.record_manual_identity_evidence('${orgA}','${serper.lead_id}','https://unproposed.example.org','Zephyr Textiles makes textiles in Pune.','I checked the proposed site and its business name.')`)).rejects.toThrow("PROPOSED_SITE_NOT_FOUND");
  const identity = (await asUser(userA, `select public.record_manual_identity_evidence('${orgA}','${serper.lead_id}','https://zephyr.example.org','Zephyr Textiles makes textiles in Pune.','I checked the proposed site and its business name.') as id`)).rows[0] as { id: string };
  await expect(asUser(userA, `select public.confirm_discovered_website('${orgA}','${serper.lead_id}','${identity.id}','https://other.example.org','I confirmed that this is the business site.')`)).rejects.toThrow("WEBSITE_SOURCE_MISMATCH");
  await asUser(userA, `select public.confirm_discovered_website('${orgA}','${serper.lead_id}','${identity.id}','https://zephyr.example.org','I confirmed the on-site identity and proposed link.')`);
  expect((await db.query<{ website_url: string }>(`select website_url from public.leads where id='${serper.lead_id}'`)).rows[0].website_url).toBe("https://zephyr.example.org");
  expect((await db.query<{ source: string }>(`select source from public.lead_discovery_sources where lead_id='${serper.lead_id}' order by source`)).rows).toEqual([{ source: "harvey" }, { source: "serper" }]);
  const harveyOnly = (await db.query<{ result: { state: string; lead_id: string } }>(ingest(harveyRun,"harvey","harvey_osm","Marigold Clinic",null,"Mumbai","osm-2"))).rows[0].result;
  expect(harveyOnly.state).toBe("created");
  expect(harveyOnly.lead_id).not.toBe(serper.lead_id);
  const ambiguous = (await db.query<{ result: { state: string; candidate_id: string } }>(ingest(serperRun,"serper","serper","Zephyr Textiles","https://zephyr.example.org","Jaipur","serper-2"))).rows[0].result;
  expect(ambiguous.state).toBe("review_needed");
  expect((await db.query(`select id from public.leads where business_name='Zephyr Textiles' and org_id='${orgA}'`)).rows).toHaveLength(1);
  expect((await asUser(userB, `select id from public.discovery_candidates where org_id='${orgA}'`)).rows).toEqual([]);
  await expect(asUser(userB, `select public.resolve_discovery_candidate('${orgA}','${ambiguous.candidate_id}','merge','${serper.lead_id}')`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.resolve_discovery_candidate('${orgA}','${ambiguous.candidate_id}','merge','${serper.lead_id}')`);
  expect((await db.query<{ source: string }>(`select source from public.lead_discovery_sources where lead_id='${serper.lead_id}'`)).rows).toHaveLength(3);
  expect((await db.query<{ proposed_website_url: string }>(`select proposed_website_url from public.lead_discovery_sources where lead_id='${serper.lead_id}' and provider_record_id='serper-2'`)).rows[0].proposed_website_url).toBe("https://zephyr.example.org");
  await expect(asUser(userA, `select public.resolve_discovery_candidate('${orgA}','${ambiguous.candidate_id}','merge','${serper.lead_id}')`)).rejects.toThrow("DISCOVERY_CANDIDATE_NOT_PENDING");
  await expect(asUser(userA, ingest(serperRun,"serper","serper","Another Business",null,"Pune","serper-3"))).rejects.toThrow(/permission denied/);
  await db.exec(`delete from public.discovery_candidates where org_id='${orgA}'; delete from public.leads where id in ('${serper.lead_id}','${harveyOnly.lead_id}'); delete from public.discovery_runs where id in ('${serperRun}','${harveyRun}')`);
  await asUser(userA, `update public.discovery_targeting set serper_discovery_enabled=false,harvey_discovery_enabled=false,max_new_prospects=0,updated_by='${userA}' where org_id='${orgA}'`);
});
test("country mismatch or missing country never auto-merges a same-name business", async () => {
  await db.exec("begin");
  try {
    const run = "00000000-0000-4000-8000-000000000891";
    await db.exec(`insert into public.discovery_targeting(org_id,max_new_prospects,serper_discovery_enabled)
      values('${orgA}',5,true) on conflict(org_id) do update set max_new_prospects=5,serper_discovery_enabled=true;
      insert into public.discovery_runs(id,org_id,provider,state,requested_limit)
      values('${run}','${orgA}','serper','leased',5);
      insert into public.leads(org_id,business_name,city,country,source_type,is_demo)
      values('${orgA}','Bluebird Dental','Austin','United States','manual',false),
      ('${orgA}','Seabird Dental','Austin',null,'manual',false),
      ('${orgA}','Northstar Dental','Austin','United States','manual',false);`);
    const ingest = (name: string, country: string, suffix: string) =>
      `select public.ingest_discovered_business('${orgA}','${run}','serper','serper',
        '${name}',null,'Austin',null,'${country}','https://example.org/${suffix}',null,now()) as result`;
    const abroad = (await db.query<{ result: { state: string } }>(ingest("Bluebird Dental", "Australia", "bluebird"))).rows[0].result;
    const unknown = (await db.query<{ result: { state: string } }>(ingest("Seabird Dental", "United States", "seabird"))).rows[0].result;
    const matched = (await db.query<{ result: { state: string } }>(ingest("Northstar Dental", "United States", "northstar"))).rows[0].result;
    expect([abroad.state, unknown.state, matched.state]).toEqual(["review_needed", "review_needed", "matched"]);
    expect((await asUser(userB, `select id from public.discovery_candidates where org_id='${orgA}'`)).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});
test("Serper discovery leases one owner-approved target and reserves a shared free-tier budget before intake", async () => {
  await expect(asUser(userA, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2)`))
    .rejects.toThrow("DISCOVERY_DISABLED");
  await asUser(userA, `update public.discovery_targeting set target_industries=array['textiles'],target_cities=array['Pune'],
    target_countries=array['India'],max_new_prospects=2,serper_discovery_enabled=true,updated_by='${userA}' where org_id='${orgA}'`);
  await db.exec(`update public.organizations set research_provider='serper',research_monthly_credit_cap=31 where id='${orgA}'`);
  await expect(asUser(userB, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2)`))
    .rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.request_serper_discovery('${orgA}','finance','Pune','India',2)`))
    .rejects.toThrow("DISCOVERY_TARGET_NOT_APPROVED");
  const run = (await asUser(userA, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2) as id`)).rows[0] as { id: string };
  await expect(asUser(userA, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2)`))
    .rejects.toThrow("DISCOVERY_ALREADY_PENDING");
  await expect(asUser(userA, `select * from public.lease_serper_discovery_runs(1)`)).rejects.toThrow(/permission denied/);
  const leased = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_serper_discovery_runs(1)")).rows[0];
  expect(leased.id).toBe(run.id);
  expect((await db.query<{ reserved: boolean }>(`select public.reserve_serper_discovery_credits('${run.id}','${leased.lease_token}') as reserved`)).rows[0].reserved).toBe(true);
  expect((await db.query<{ reserved: boolean }>(`select public.reserve_serper_discovery_credits('${run.id}','${leased.lease_token}') as reserved`)).rows[0].reserved).toBe(true);
  const observation = (await db.query<{ result: { lead_id: string } }>(`select public.ingest_discovered_business('${orgA}','${run.id}',
    'serper','serper','Synthetic Textiles',null,'Pune',null,'India','https://example.org/search/synthetic',null,now()) as result`)).rows[0].result;
  expect((await db.query<{ website_url: string | null }>(`select website_url from public.leads where id='${observation.lead_id}'`)).rows[0].website_url).toBeNull();
  await db.query(`select public.finish_serper_discovery_run('${run.id}','${leased.lease_token}',1,null)`);
  expect((await db.query<{ state: string; observations_count: number }>(`select state,observations_count from public.discovery_runs where id='${run.id}'`)).rows[0])
    .toEqual({ state: "completed", observations_count: 1 });
  await expect(asUser(userA, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2)`))
    .rejects.toThrow("DISCOVERY_CREDIT_CAP");
  await db.exec(`update public.organizations set research_monthly_credit_cap=62 where id='${orgA}'`);
  const exhausted = (await asUser(userA, `select public.request_serper_discovery('${orgA}','textiles','Pune','India',2) as id`)).rows[0] as { id: string };
  await db.exec(`update public.research_credit_usage set reserved_credits=62 where org_id='${orgA}' and provider='serper'`);
  const second = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_serper_discovery_runs(1)")).rows[0];
  expect(second.id).toBe(exhausted.id);
  expect((await db.query<{ reserved: boolean }>(`select public.reserve_serper_discovery_credits('${exhausted.id}','${second.lease_token}') as reserved`)).rows[0].reserved).toBe(false);
  await db.query(`select public.finish_serper_discovery_run('${exhausted.id}','${second.lease_token}',0,'DISCOVERY_CREDIT_CAP')`);
  expect((await db.query<{ reserved_credits: number }>(`select reserved_credits from public.research_credit_usage where org_id='${orgA}' and provider='serper'`)).rows[0].reserved_credits).toBe(62);
  await db.exec(`delete from public.leads where id='${observation.lead_id}';
    delete from public.discovery_runs where id in ('${run.id}','${exhausted.id}');
    delete from public.research_credit_usage where org_id='${orgA}' and provider='serper';
    update public.organizations set research_monthly_credit_cap=0 where id='${orgA}'`);
  await asUser(userA, `update public.discovery_targeting set serper_discovery_enabled=false,max_new_prospects=0,
    target_industries='{}',target_cities='{}',target_countries='{}',updated_by='${userA}' where org_id='${orgA}'`);
});

test.each([10, 50, 100])("bounded Serper campaign advances %i synthetic businesses through durable pages", async (target) => {
  await expect(asUser(userB, `select public.request_discovery_campaign('${orgA}','textiles','Pune','India',${target},70,15)`))
    .rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, "select * from public.lease_serper_discovery_runs(1)"))
    .rejects.toThrow(/permission denied/);
  await db.exec("begin");
  try {
    await db.exec(`insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,
      max_new_prospects,serper_discovery_enabled) values('${orgA}',array['textiles'],array['Pune'],array['India'],100,true)
      on conflict(org_id) do update set target_industries=excluded.target_industries,target_cities=excluded.target_cities,
      target_countries=excluded.target_countries,max_new_prospects=100,serper_discovery_enabled=true;
      update public.organizations set research_provider='serper',research_monthly_credit_cap=15 where id='${orgA}';`);
    const campaign = (await asUser(userA, `select public.request_discovery_campaign('${orgA}','textiles','Pune','India',${target},70,15) as id`))
      .rows[0] as { id: string };
    expect((await db.query("select id from public.lease_serper_discovery_runs(1)")).rows).toEqual([]);
    for (let page = 1; page <= target / 10; page++) {
      await db.exec(`update public.discovery_runs set next_run_at=now() where campaign_id='${campaign.id}' and state='queued'`);
      const run = (await db.query<{ id: string; lease_token: string; search_page: number; requested_limit: number }>(
        `select id,lease_token,search_page,requested_limit from public.lease_serper_campaign_page('${orgA}','${campaign.id}')`)) .rows[0];
      expect(run.search_page).toBe(page);
      expect(run.requested_limit).toBe(10);
      expect((await db.query<{ ok: boolean }>(`select public.reserve_serper_discovery_credits('${run.id}',
        '${run.lease_token}') as ok`)).rows[0].ok).toBe(true);
      await db.query(`select public.finish_discovery_campaign_page('${run.id}','${run.lease_token}',10,10,null)`);
    }
    expect((await asUser(userA, `select state,observations_count,new_businesses_count,credits_reserved,pages_completed
      from public.discovery_campaigns where id='${campaign.id}'`)).rows[0]).toEqual({
      state: "completed", observations_count: target, new_businesses_count: target,
      credits_reserved: target / 10, pages_completed: target / 10,
    });
    expect((await asUser(userB, `select id from public.discovery_campaigns where id='${campaign.id}'`)).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});

test("campaign pauses at its reserved budget and cancellation prevents a queued page", async () => {
  await expect(asUser(userB, `select public.cancel_discovery_campaign('${orgA}','${leadA}')`))
    .rejects.toThrow("FORBIDDEN");
  await db.exec("begin");
  try {
    await db.exec(`insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,
      max_new_prospects,serper_discovery_enabled) values('${orgA}',array['textiles'],array['Pune'],array['India'],100,true)
      on conflict(org_id) do update set target_industries=excluded.target_industries,target_cities=excluded.target_cities,
      target_countries=excluded.target_countries,max_new_prospects=100,serper_discovery_enabled=true;
      update public.organizations set research_provider='serper',research_monthly_credit_cap=2 where id='${orgA}';`);
    const campaign = (await asUser(userA, `select public.request_discovery_campaign('${orgA}','textiles','Pune','India',50,70,2) as id`))
      .rows[0] as { id: string };
    for (let page = 1; page <= 2; page++) {
      await db.exec(`update public.discovery_runs set next_run_at=now() where campaign_id='${campaign.id}' and state='queued'`);
      const run = (await db.query<{ id: string; lease_token: string }>(
        `select id,lease_token from public.lease_serper_campaign_page('${orgA}','${campaign.id}')` )).rows[0];
      await db.query(`select public.reserve_serper_discovery_credits('${run.id}','${run.lease_token}')`);
      await db.query(`select public.finish_discovery_campaign_page('${run.id}','${run.lease_token}',10,10,null)`);
    }
    expect((await db.query(`select state,last_error_code,credits_reserved from public.discovery_campaigns
      where id='${campaign.id}'`)).rows[0]).toEqual({ state: "paused", last_error_code: "CAMPAIGN_CREDIT_LIMIT", credits_reserved: 2 });
    expect((await db.query(`select count(*)::int as count from public.discovery_runs
      where campaign_id='${campaign.id}'`)).rows[0]).toEqual({ count: 2 });
    await asUser(userA, `select public.cancel_discovery_campaign('${orgA}','${campaign.id}')`);
    expect((await db.query(`select state from public.discovery_campaigns where id='${campaign.id}'`)).rows[0])
      .toEqual({ state: "cancelled" });
  } finally { await db.exec("rollback"); }
});
test("one mocked search page persists distinct review-only businesses and campaign progress", async () => {
  await db.exec("begin");
  try {
    await db.exec(`insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,
      max_new_prospects,serper_discovery_enabled) values('${orgA}',array['textiles'],array['Pune'],array['India'],2,true)
      on conflict(org_id) do update set target_industries=excluded.target_industries,target_cities=excluded.target_cities,
      target_countries=excluded.target_countries,max_new_prospects=2,serper_discovery_enabled=true;
      update public.organizations set research_provider='serper',research_monthly_credit_cap=1 where id='${orgA}';`);
    const campaign = (await asUser(userA, `select public.request_discovery_campaign('${orgA}','textiles','Pune','India',2,70,1) as id`))
      .rows[0] as { id: string };
    const run = (await db.query<{ id: string; lease_token: string }>(
      `select id,lease_token from public.lease_serper_campaign_page('${orgA}','${campaign.id}')`)).rows[0];
    expect((await db.query<{ ok: boolean }>(`select public.reserve_serper_discovery_credits('${run.id}',
      '${run.lease_token}') as ok`)).rows[0].ok).toBe(true);
    const candidates = await discoverSerperSearchCandidates({ industry: "textiles", city: "Pune", country: "India", page: 1 }, {
      search: async () => [
        { title: "Aster Textiles | Pune", url: "https://directory.example.org/aster",
          content: "Aster Textiles supplies fabric in Pune with listed business details.", score: 1 },
        { title: "Birch Textiles | Pune", url: "https://directory.example.org/birch",
          content: "Birch Textiles supplies fabric in Pune with listed business details.", score: 0.5 },
      ],
      extract: async () => { throw new Error("PAGED_SEARCH_MUST_NOT_SCRAPE"); },
    });
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.proposed_website_url).toBeNull();
      const intake = (await db.query<{ result: { state: string; lead_id: string } }>(
        `select public.ingest_serper_observation('${orgA}','${run.id}','${candidate.name}',
        '${candidate.city}','India','${candidate.source_url}','${candidate.observed_at}',
        '${candidate.category}','${candidate.evidence_quote}','${candidate.source_url}') as result`)).rows[0].result;
      expect(intake.state).toBe("created");
    }
    await db.query(`select public.finish_discovery_campaign_page('${run.id}','${run.lease_token}',2,2,null)`);
    expect((await db.query(`select state,observations_count,new_businesses_count,credits_reserved
      from public.discovery_campaigns where id='${campaign.id}'`)).rows[0]).toEqual({
      state: "completed", observations_count: 2, new_businesses_count: 2, credits_reserved: 1,
    });
    expect((await db.query(`select business_name,website_url from public.leads where org_id='${orgA}'
      and business_name in ('Aster Textiles','Birch Textiles') order by business_name`)).rows)
      .toEqual([{ business_name: "Aster Textiles", website_url: null },
        { business_name: "Birch Textiles", website_url: null }]);
    expect((await db.query(`select count(*)::int as count from public.lead_evidence e join public.lead_discovery_sources s
      on s.org_id=e.org_id and s.lead_id=e.lead_id and s.source_url=e.source_url
      where s.discovery_run_id='${run.id}' and e.reviewed_by is null`)).rows[0]).toEqual({ count: 2 });
  } finally { await db.exec("rollback"); }
});
test("Serper intake stores reviewable evidence atomically and preserves ambiguous excerpts", async () => {
  const run = "00000000-0000-4000-8000-000000000083";
  await asUser(userA, `update public.discovery_targeting set max_new_prospects=2,serper_discovery_enabled=true,updated_by='${userA}' where org_id='${orgA}'`);
  await db.exec(`insert into public.discovery_runs(id,org_id,provider,state,requested_limit) values('${run}','${orgA}','serper','leased',2)`);
  const observe = (city: string, quote: string) => `select public.ingest_serper_observation('${orgA}','${run}','Marigold Textiles','${city}','India',
    'https://marigold.example.org/',now(),'textiles','${quote}','https://marigold.example.org/') as result`;
  await expect(asUser(userA, observe("Pune", "Marigold Textiles makes cotton fabric in Pune."))).rejects.toThrow(/permission denied/);
  await expect(db.query(observe("Pune", "short"))).rejects.toThrow("INVALID_DISCOVERY_EVIDENCE");
  const created = (await db.query<{ result: { state: string; lead_id: string } }>(observe("Pune", "Marigold Textiles makes cotton fabric in Pune."))).rows[0].result;
  expect(created.state).toBe("created");
  expect((await db.query<{ website_url: string | null; business_category: string | null }>(`select website_url,business_category from public.leads where id='${created.lead_id}'`)).rows[0])
    .toEqual({ website_url: null, business_category: null });
  const fact = (await db.query<{ id: string; confidence: number; reviewed_by: string | null }>(`select id,confidence,reviewed_by from public.lead_evidence where lead_id='${created.lead_id}' and source_type='serper'`)).rows[0];
  expect(Number(fact.confidence)).toBe(0.5);
  expect(fact.reviewed_by).toBeNull();
  await expect(asUser(userB, `select public.review_discovery_evidence('${orgA}','${fact.id}','approve',0.8,'Checked the public source and confirmed the business name.')`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.review_discovery_evidence('${orgA}','${fact.id}','approve',0.8,'Checked the public source and confirmed the business name.')`);
  await expect(asUser(userA, `select public.review_discovery_evidence('${orgA}','${fact.id}','approve',0.8,'Checked the public source and confirmed the business name.')`)).rejects.toThrow("EVIDENCE_NOT_PENDING");
  const origin = (await db.query<{ id: string; proposed_category: string }>(`select id,proposed_category from public.lead_discovery_sources where lead_id='${created.lead_id}'`)).rows[0];
  expect(origin.proposed_category).toBe("textiles");
  await expect(asUser(userB, `select public.confirm_discovered_category('${orgA}','${created.lead_id}','${origin.id}','${fact.id}',
    'I checked that this business makes textiles.')`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.confirm_discovered_category('${orgA}','${created.lead_id}','${origin.id}','${fact.id}',
    'I checked that this business makes textiles.')`);
  expect((await db.query<{ business_category: string }>(`select business_category from public.leads where id='${created.lead_id}'`)).rows[0].business_category)
    .toBe("textiles");
  await expect(asUser(userB, `select public.confirm_discovered_website('${orgA}','${created.lead_id}','${fact.id}','https://marigold.example.org/',
    'I confirmed the page belongs to this business.')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.confirm_discovered_website('${orgA}','${created.lead_id}','${fact.id}','https://other.example.org/',
    'I confirmed the page belongs to this business.')`)).rejects.toThrow("WEBSITE_SOURCE_MISMATCH");
  await asUser(userA, `select public.confirm_discovered_website('${orgA}','${created.lead_id}','${fact.id}','https://marigold.example.org/',
    'I confirmed the page belongs to this business.')`);
  expect((await db.query<{ website_url: string }>(`select website_url from public.leads where id='${created.lead_id}'`)).rows[0].website_url)
    .toBe("https://marigold.example.org/");
  const ambiguous = (await db.query<{ result: { state: string; candidate_id: string } }>(observe("Jaipur", "Marigold Textiles makes cotton fabric in Jaipur."))).rows[0].result;
  expect(ambiguous.state).toBe("review_needed");
  expect((await db.query<{ evidence_quote: string; proposed_category: string; evidence_url: string }>(`select evidence_quote,proposed_category,evidence_url from public.discovery_candidates where id='${ambiguous.candidate_id}'`)).rows[0])
    .toEqual({ evidence_quote: "Marigold Textiles makes cotton fabric in Jaipur.", proposed_category: "textiles", evidence_url: "https://marigold.example.org/" });
  await asUser(userA, `select public.resolve_discovery_candidate('${orgA}','${ambiguous.candidate_id}','merge','${created.lead_id}')`);
  expect((await db.query(`select id from public.lead_evidence where lead_id='${created.lead_id}' and source_type='serper'`)).rows).toHaveLength(2);
  await db.exec(`delete from public.discovery_candidates where id='${ambiguous.candidate_id}'; delete from public.leads where id='${created.lead_id}'; delete from public.discovery_runs where id='${run}'`);
  await asUser(userA, `update public.discovery_targeting set max_new_prospects=0,serper_discovery_enabled=false,updated_by='${userA}' where org_id='${orgA}'`);
});
test("qualification requires an approved service, target fit, reviewed gap and verified contact", async () => {
  const lead = "00000000-0000-4000-8000-000000000071";
  const contact = "00000000-0000-4000-8000-000000000072";
  const evidence = "00000000-0000-4000-8000-000000000073";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,business_category,city) values('${lead}','${orgA}','Synthetic Clinic','manual','clinic','Pune');
    insert into public.contacts(id,org_id,lead_id,email,email_normalized) values('${contact}','${orgA}','${lead}','hello@synthetic.example','hello@synthetic.example');`);
  const service = ((await asUser(userA, `select id from public.service_catalog where org_id='${orgA}' and service_key='service_15'`)).rows[0] as { id: string }).id;
  await asUser(userA, `insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind) values('${evidence}','${orgA}','${lead}','manual','https://synthetic.example/booking','Synthetic business explicitly confirms appointments are handled by phone.',now(),0.9,'${userA}','observation')`);
  await expect(asUser(userA, `select public.record_service_match('${orgA}','${lead}','${service}','verified_gap','Manual booking confirmed from public page',array['${evidence}']::uuid[],0.9)`)).resolves.toBeDefined();
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect(((await asUser(userA, `select status from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0] as { status: string }).status).toBe("RESEARCH_NEEDED");
  await asUser(userA, `update public.service_catalog set status='active',reviewed_by='${userA}',reviewed_at=now() where id='${service}'`);
  await asUser(userA, `update public.discovery_targeting set target_industries=array['clinic'],target_cities=array['Pune'],
    target_states='{}',target_countries='{}',target_business_types='{}',excluded_industries='{}',excluded_businesses='{}',
    updated_by='${userA}' where org_id='${orgA}'`);
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect(((await asUser(userA, `select status from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0] as { status: string }).status).toBe("CONTACT_UNVERIFIED");
  await db.exec(`insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at) values('${orgA}','${contact}','hello@synthetic.example','valid','{}','synthetic',now()+interval '1 day')`);
  await db.exec(`insert into public.consent_records(org_id,contact_id,channel,state,purpose,source) values('${orgA}','${contact}','email','permitted','Synthetic test','test_fixture')`);
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect((await asUser(userA, `select status,primary_service_id from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0]).toEqual({ status: "QUALIFIED", primary_service_id: service });
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).resolves.toBeDefined();
  await db.exec(`update public.lead_evidence set observed_at=now()-interval '91 days' where id='${evidence}'`);
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).rejects.toThrow("CURRENT_SERVICE_GAP_REQUIRED");
  await db.exec(`update public.lead_evidence set observed_at=now() where id='${evidence}'`);
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).resolves.toBeDefined();
  const verification = (await db.query<{ id: string }>(`update public.email_verification_records set status='unknown',provider='basic_dns'
    where contact_id='${contact}' returning id`)).rows[0].id;
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect((await asUser(userA, `select status from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0])
    .toEqual({ status: "CONTACT_UNVERIFIED" });
  await expect(db.query(`select private.email_send_verification_gate('${orgA}','${contact}','hello@synthetic.example')`))
    .rejects.toThrow("EMAIL_VERIFICATION_REVIEW_REQUIRED");
  await asUser(userA, `select public.review_email_verification('${orgA}','${contact}','${verification}')`);
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect((await asUser(userA, `select status from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0])
    .toEqual({ status: "QUALIFIED" });
  await asUser(userA, `update public.discovery_targeting set target_cities=array['Jaipur'],updated_by='${userA}' where org_id='${orgA}'`);
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  expect(((await asUser(userA, `select status from public.lead_qualifications where lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0] as { status: string }).status).toBe("NOT_QUALIFIED");
  await expect(asUser(userB, `select public.evaluate_lead_qualification('${orgA}','${lead}')`)).rejects.toThrow("FORBIDDEN");
  await db.exec(`delete from public.leads where id='${lead}'`);
});
test("website status requires repeated supported checks and never equates search absence with a broken site", async () => {
  const lead = "00000000-0000-4000-8000-000000000091";
  const evidence = "00000000-0000-4000-8000-000000000092";
  await db.exec(`insert into public.leads(id,org_id,business_name,website_url,source_type) values('${lead}','${orgA}','Synthetic Repair','https://repair.example.org/','manual');
    insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
    values('${evidence}','${orgA}','${lead}','manual','https://repair.example.org/','Official site returned server errors during two checks.',now(),0.9,'${userA}','observation')`);
  const check = (ageHours: number, outcome = "http_5xx") => ({ url: "https://repair.example.org/", checked_at: new Date(Date.now() - ageHours * 3600000).toISOString(), outcome, redirect_checked: true });
  const record = (status: string, checks: object[]) => `select public.record_website_assessment('${orgA}','${lead}','${status}','https://repair.example.org/','${JSON.stringify(checks)}'::jsonb,array['${evidence}']::uuid[],'Synthetic reviewed website observations',0.9)`;
  await expect(asUser(userA, record("PERSISTENTLY_BROKEN", [check(1)]))).rejects.toThrow("PERSISTENT_FAILURE_NOT_VERIFIED");
  await expect(asUser(userA, record("PERSISTENTLY_BROKEN", [check(1), check(2)]))).rejects.toThrow("PERSISTENT_FAILURE_NOT_VERIFIED");
  await expect(asUser(userA, record("PERSISTENTLY_BROKEN", [check(1), check(30, "ok")]))).rejects.toThrow("PERSISTENT_FAILURE_NOT_VERIFIED");
  await asUser(userA, record("PERSISTENTLY_BROKEN", [check(1), check(30)]));
  const latest = (await asUser(userA, `select status,official_url from public.lead_website_assessments where lead_id='${lead}' order by observed_at desc,id desc limit 1`)).rows[0];
  expect(latest).toEqual({ status: "PERSISTENTLY_BROKEN", official_url: "https://repair.example.org/" });
  const searches = ["https://search.example.org/one", "https://directory.example.org/two"].map((url) => ({ url, checked_at: new Date().toISOString(), outcome: "not_found" }));
  await expect(asUser(userA, `select public.record_website_assessment('${orgA}','${lead}','NO_OFFICIAL_WEBSITE_DISCOVERED',null,'${JSON.stringify(searches)}'::jsonb,'{}'::uuid[],'Searches did not surface an official site',0.7)`)).rejects.toThrow("WEBSITE_STATUS_CONFLICT");
  await db.exec(`update public.leads set website_url=null,normalized_domain=null where id='${lead}'`);
  await expect(asUser(userA, `select public.record_website_assessment('${orgA}','${lead}','NO_OFFICIAL_WEBSITE_DISCOVERED',null,'${JSON.stringify(searches)}'::jsonb,'{}'::uuid[],'Searches did not surface an official site',0.7)`)).resolves.toBeDefined();
  await db.exec(`delete from public.leads where id='${lead}'`);
});
test("atomic import deduplicates 50 rows and never modifies suppression", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    business_name: `Synthetic ${i}`,
    website_url: `https://fixture${i}.example`,
    email: `owner${i}@example.org`,
    source_type: "csv",
  }));
  await db.exec(
    `insert into public.suppressions(org_id,channel,identifier_hash,reason) values('${orgA}','email','synthetic-hmac','opt-out')`,
  );
  const sql = `select public.import_leads('${orgA}','${JSON.stringify(rows)}'::jsonb) as result`;
  const first = ((await asUser(userA, sql)).rows[0] as { result: { added: number; skipped: number; created_lead_ids: string[] } }).result;
  expect(first).toMatchObject({ added: 50, skipped: 0 });
  expect(first.created_lead_ids).toHaveLength(50);
  expect((await asUser(userA, sql)).rows).toEqual([
    { result: { added: 0, skipped: 50, created_lead_ids: [] } },
  ]);
  expect(
    (await db.query("select * from public.suppressions")).rows,
  ).toHaveLength(1);
  await expect(asUser(userB, sql)).rejects.toThrow("FORBIDDEN");
});
test("sourced intake keeps country, evidence and distinct contacts on the correct tenant without approval", async () => {
  await db.exec("begin");
  try {
    const row = { business_name: "Synthetic Reno Jeweler", website_url: "https://reno-fixture.example/",
      email: "hello@reno-fixture.example", additional_emails: "sales@reno-fixture.example; HELLO@reno-fixture.example",
      phones: "+1555010013, +1555010013", city: "Reno", state_region: "Nevada", country: "United States",
      business_category: "jewelry", source_type: "approved_source",
      source_url: "https://reno-fixture.example/contact", source_observed_at: new Date().toISOString(),
      identity_claim: "Synthetic Reno Jeweler accepts appointment requests for jewelry repairs in Reno." };
    const invoke = `select public.import_leads('${orgA}','${JSON.stringify([row])}'::jsonb) as result`;
    const result = ((await asUser(userA, invoke)).rows[0] as { result: { created_lead_ids: string[] } }).result;
    expect(result.created_lead_ids).toHaveLength(1);
    const id = result.created_lead_ids[0];
    expect((await asUser(userA, `select city,state_region,country,source_url,source_observed_at,website_url from public.leads where id='${id}'`)).rows[0])
      .toMatchObject({ city: "Reno", state_region: "Nevada", country: "USA",
        source_url: row.source_url, website_url: row.website_url });
    expect((await asUser(userA, `select source_url,proposed_website_url,actual_provider from public.lead_discovery_sources where lead_id='${id}'`)).rows)
      .toEqual([{ source_url: row.source_url, proposed_website_url: row.website_url, actual_provider: "approved_source" }]);
    expect((await asUser(userA, `select claim,source_url,reviewed_by,confidence from public.lead_evidence where lead_id='${id}'`)).rows)
      .toEqual([{ claim: row.identity_claim, source_url: row.source_url, reviewed_by: null, confidence: "0.800" }]);
    expect((await asUser(userA, `select email_normalized,phone_e164,source_url,verified_at from public.contacts where lead_id='${id}' order by email_normalized nulls last,phone_e164`)).rows)
      .toEqual([{ email_normalized: "hello@reno-fixture.example", phone_e164: null, source_url: row.source_url, verified_at: null },
        { email_normalized: "sales@reno-fixture.example", phone_e164: null, source_url: row.source_url, verified_at: null },
        { email_normalized: null, phone_e164: "+1555010013", source_url: row.source_url, verified_at: null }]);
    const job = "79000000-0000-4000-8000-000000000001";
    const audit = "79000000-0000-4000-8000-000000000002";
    await db.exec(`insert into public.website_audit_jobs(id,org_id,lead_id,official_url,host_key,approved_hosts,permission_reference,requested_by)
      values('${job}','${orgA}','${id}','${row.website_url}','reno-fixture.example',array['reno-fixture.example'],
       'Synthetic permitted site check','${userA}');
      insert into public.website_audit_observations(id,org_id,lead_id,job_id,checked_url,outcome,http_status)
      values('${audit}','${orgA}','${id}','${job}','${row.website_url}','ok',200);
      insert into public.lead_evidence(org_id,lead_id,source_url,source_type,observed_at,claim,confidence)
      values('${orgA}','${id}','https://reno-directory.example/listing','manual',now(),
       'Local directory lists Synthetic Reno Jeweler as a Reno jewelry repair business.',0.8);`);
    const observed = await planAutomaticWebsiteObservation({ lead: {
      id, country: "USA", website_url: row.website_url, is_demo: false, status: "new",
    }, reviewedAssessmentObservedAt: null, audits: [{ id: audit, checked_url: row.website_url,
      checked_at: new Date().toISOString(), outcome: "ok", http_status: 200 }], proposals: [] });
    expect(observed?.state).toBe("recorded_url_reachable");
    expect(potentialPreviewService({ websiteUrl: row.website_url,
      assessment: { status: "WORKING", official_url: row.website_url, observed_at: observed!.observed_at } })).toBe("service_09");
    const facts = (await db.query<ReviewedPreviewEvidence>(`select id,source_url,claim,confidence,observed_at,reviewed_by,rejected_by
      from public.lead_evidence where org_id='${orgA}' and lead_id='${id}'`)).rows;
    const preview = buildEvidenceOnlyPreview({ businessName: row.business_name,
      fact: facts.find((fact) => fact.source_url === row.source_url)!, corroboration: facts,
      serviceKey: "service_09", serviceName: "AI receptionists", matchConfidence: 0.5,
      websiteStatus: "WORKING", requiredLocation: "Reno" });
    const service = (await db.query<{ id: string }>(`select id from public.service_catalog
      where org_id='${orgA}' and service_key='service_09'`)).rows[0].id;
    await db.query(`insert into public.research_draft_previews(org_id,lead_id,service_id,subjects,body,
      evidence_ids,confidence,generator,basis,fact_claim) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [orgA,id,service,preview.subjects,preview.body,preview.evidence_ids,preview.confidence,
      preview.generator,preview.basis,preview.fact_claim]);
    expect((await asUser(userA, `select state,generator from public.research_draft_previews where lead_id='${id}'`)).rows)
      .toEqual([{ state: "research_review", generator: "grounded_template" }]);
    expect((await asUser(userB, `select id from public.leads where id='${id}'`)).rows).toEqual([]);
    expect((await asUser(userB, `select id from public.research_draft_previews where lead_id='${id}'`)).rows).toEqual([]);
    expect((await db.query(`select id from public.outbound_drafts where lead_id='${id}'`)).rows).toEqual([]);
    expect(((await asUser(userA, invoke)).rows[0] as { result: unknown }).result).toMatchObject({ added: 0, skipped: 1, created_lead_ids: [] });
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userB}',false); savepoint foreign_intake;`);
    await expect(db.query(invoke)).rejects.toThrow("FORBIDDEN");
    await db.exec("rollback to savepoint foreign_intake; reset role");
  } finally { await db.exec("rollback"); }
});
test("intake rejects an unsourced country atomically", async () => {
  await db.exec("begin");
  try {
    const base = { business_name: "Synthetic Safeguard", website_url: "https://safeguard.example/",
      source_type: "approved_source", country: "USA", email: "public@safeguard.example" };
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userA}',false); savepoint unsourced_country;`);
    await expect(db.query(`select public.import_leads('${orgA}','${JSON.stringify([base])}'::jsonb)`))
      .rejects.toThrow("COUNTRY_SOURCE_REQUIRED");
    await db.exec("rollback to savepoint unsourced_country; reset role");
    expect((await db.query("select id from public.leads where business_name='Synthetic Safeguard'")).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});
test("server score uses only same-lead reviewed evidence and records provenance", async () => {
  const evidence = "00000000-0000-4000-8000-000000000041";
  await asUser(
    userA,
    `insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind) values('${evidence}','${orgA}','${leadA}','manual','https://example.org','Synthetic explicit request',now()-interval '1 minute',0.9,'${userA}','intent')`,
  );
  await asUser(userA, `select public.score_lead('${orgA}','${leadA}')`);
  const result = await db.query<{ score: number; evidence_ids: string[] }>(
    `select score,evidence_ids from public.lead_scores where lead_id='${leadA}'`,
  );
  expect(result.rows[0]).toEqual({ score: 50, evidence_ids: [evidence] });
  await expect(
    asUser(userB, `select public.score_lead('${orgA}','${leadA}')`),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    asUser(
      userA,
      `insert into public.lead_scores(org_id,lead_id,score,confidence,score_version) values('${orgA}','${leadA}',100,1,'forged')`,
    ),
  ).rejects.toThrow(/permission denied/);
});
test("AI quota reservation is atomic, disabled by default and unavailable to browsers", async () => {
  await expect(
    db.query(`select public.reserve_ai_usage('${orgA}',100)`),
  ).rejects.toThrow("AI_NOT_CONFIGURED");
  await expect(
    asUser(userA, `select public.reserve_ai_usage('${orgA}',100)`),
  ).rejects.toThrow(/permission denied/);
  await db.exec(
    `insert into public.ai_budgets(org_id,enabled,daily_requests,daily_tokens,free_tier_approved,model) values('${orgA}',true,1,100,true,'synthetic-model')`,
  );
  await db.query(`select public.reserve_ai_usage('${orgA}',100)`);
  await expect(
    db.query(`select public.reserve_ai_usage('${orgA}',1)`),
  ).rejects.toThrow("QUOTA_EXHAUSTED");
});
test("approval uses immutable snapshot; edits invalidate approval; stale review is rejected", async () => {
  const { rows } = await db.query<{ id: string }>(
    `select id from public.outbound_drafts where org_id='${orgA}' limit 1`,
  );
  const id = rows[0].id;
  const hash = createHash("sha256").update("\nSynthetic").digest("hex");
  await expect(
    asUser(
      userA,
      `select public.review_draft('${orgA}','${id}',true,true,'stale')`,
    ),
  ).rejects.toThrow("STALE_REVIEW");
  await expect(
    asUser(
      userA,
      `select public.review_draft('${orgA}','${id}',true,false,'${hash}')`,
    ),
  ).rejects.toThrow("FACTUAL_REVIEW_REQUIRED");
  await asUser(
    userA,
    `select public.review_draft('${orgA}','${id}',true,true,'${hash}')`,
  );
  expect(
    (
      await db.query(
        `select state from public.outbound_drafts where id='${id}'`,
      )
    ).rows,
  ).toEqual([{ state: "approved" }]);
  await asUser(
    userA,
    `select public.edit_draft('${orgA}','${id}','Changed','Synthetic edited')`,
  );
  expect(
    (
      await db.query(
        `select state,approved_sha256 from public.outbound_drafts where id='${id}'`,
      )
    ).rows,
  ).toEqual([{ state: "needs_review", approved_sha256: null }]);
  expect(
    (
      await db.query(
        `select body from public.draft_approvals where draft_id='${id}'`,
      )
    ).rows,
  ).toEqual([{ body: "Synthetic" }]);
  await expect(
    asUser(userA, "update public.draft_approvals set body='tampered'"),
  ).rejects.toThrow(/permission denied/);
});
test("lease tokens prevent stolen completion and repeated workers do not duplicate notification", async () => {
  await db.exec(
    `insert into public.jobs(org_id,kind,idempotency_key,payload) values('${orgA}','notification.create','notification-fixture','{"title":"Synthetic job alert"}')`,
  );
  const first = await db.query<{
    id: string;
    lease_token: string;
    kind: string;
  }>("select * from public.lease_jobs(25)");
  expect(first.rows.length).toBeGreaterThan(0);
  expect(
    (await db.query("select * from public.lease_jobs(25)")).rows,
  ).toHaveLength(0);
  const job = first.rows.find((j) => j.kind === "notification.create")!;
  await db.query(
    `select public.create_job_notification('${job.id}','${job.lease_token}')`,
  );
  await db.query(
    `select public.create_job_notification('${job.id}','${job.lease_token}')`,
  );
  expect(
    (
      await db.query(
        `select * from public.notifications where job_id='${job.id}'`,
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        `select public.finish_job('${job.id}','00000000-0000-4000-8000-000000000099','completed') as done`,
      )
    ).rows,
  ).toEqual([{ done: false }]);
  expect(
    (
      await db.query(
        `select public.finish_job('${job.id}','${job.lease_token}','completed') as done`,
      )
    ).rows,
  ).toEqual([{ done: true }]);
  await expect(
    asUser(userA, "select * from public.lease_jobs(10)"),
  ).rejects.toThrow(/permission denied/);
});
test("persisted pause suppresses already queued outbound and is admin-only", async () => {
  await db.exec(
    `insert into public.jobs(org_id,kind,idempotency_key) values('${orgA}','email.send','pause-fixture'); update public.organizations set outbound_paused=false where id='${orgA}'`,
  );
  await expect(
    asUser(userB, `select public.pause_outbound('${orgA}')`),
  ).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.pause_outbound('${orgA}')`);
  expect(
    (
      await db.query(
        `select state from public.jobs where idempotency_key='pause-fixture'`,
      )
    ).rows,
  ).toEqual([{ state: "suppressed" }]);
  expect(
    (
      await db.query(
        `select outbound_paused from public.organizations where id='${orgA}'`,
      )
    ).rows,
  ).toEqual([{ outbound_paused: true }]);
});
test("metrics exclude demo records and are scoped to caller organization", async () => {
  expect(
    (
      await asUser(
        userA,
        `select public.workspace_metrics('${orgA}') as metrics`,
      )
    ).rows,
  ).toMatchObject([
    {
      metrics: {
        total_leads: 50,
        won: 0,
        meetings_held: 0,
        confirmed_outbound_events: 0,
      },
    },
  ]);
  await expect(
    asUser(userB, `select public.workspace_metrics('${orgA}')`),
  ).rejects.toThrow("FORBIDDEN");
});
test("assigning foreign-organization owners is rejected even by privileged SQL", async () => {
  await expect(
    db.exec(
      `update public.leads set owner_user_id='${userB}' where id='${leadA}'`,
    ),
  ).rejects.toThrow(/foreign key/);
});
test("verified inbound opt-out is atomic, duplicate-safe and cancels pending follow-ups", async () => {
  const connection = "00000000-0000-4000-8000-000000000051";
  await db.exec(
    `insert into public.external_connections(id,org_id,provider,provider_account_id,state,verified_at) values('${connection}','${orgA}','whatsapp','fixture-number-id','connected',now())`,
  );
  const call = (event: string, classification: string) =>
    `select public.accept_whatsapp_inbound('${connection}','${event}','+910000000000',now(),'Synthetic inbound','${classification}','${"a".repeat(64)}') as result`;
  expect((await db.query(call("fixture-inbound", "unknown"))).rows).toEqual([
    { result: "created" },
  ]);
  const contact = (
    await db.query<{ id: string }>(
      `select id from public.contacts where phone_e164='+910000000000'`,
    )
  ).rows[0].id;
  await db.exec(
    `insert into public.sequence_enrollments(org_id,contact_id,state,approved_by) values('${orgA}','${contact}','active','${userA}'); insert into public.jobs(org_id,kind,idempotency_key,payload) values('${orgA}','whatsapp.send','wa-followup','{"contact_id":"${contact}"}')`,
  );
  expect((await db.query(call("fixture-optout", "unsubscribe"))).rows).toEqual([
    { result: "created" },
  ]);
  expect((await db.query(call("fixture-optout", "unsubscribe"))).rows).toEqual([
    { result: "duplicate" },
  ]);
  expect(
    (
      await db.query(
        `select state from public.sequence_enrollments where contact_id='${contact}'`,
      )
    ).rows,
  ).toEqual([{ state: "cancelled" }]);
  expect(
    (
      await db.query(
        `select state from public.jobs where idempotency_key='wa-followup'`,
      )
    ).rows,
  ).toEqual([{ state: "cancelled" }]);
  expect(
    (
      await db.query(
        `select state from public.consent_records where contact_id='${contact}'`,
      )
    ).rows,
  ).toEqual([{ state: "opted_out" }]);
  expect(
    (
      await db.query(
        `select * from public.communication_messages where provider_event_id='fixture-optout'`,
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    asUser(userA, call("forged-browser", "unknown")),
  ).rejects.toThrow(/permission denied/);
  await expect(
    asUser(userA, "select * from private.oauth_secrets"),
  ).rejects.toThrow(/permission denied/);
});
test("OAuth state is consumed once, expired states rejected and browser cannot read encrypted vault", async () => {
  const hash = "b".repeat(64);
  const iv = "\\x" + "00".repeat(12);
  const ciphertext = "\\x" + "11".repeat(30);
  await db.exec(
    `select public.store_oauth_state('${hash}','${orgA}','${userA}','mail','${ciphertext}','${iv}','https://example.org/callback')`,
  );
  expect(
    (await db.query(`select * from public.consume_oauth_state('${hash}')`))
      .rows,
  ).toHaveLength(1);
  expect(
    (await db.query(`select * from public.consume_oauth_state('${hash}')`))
      .rows,
  ).toHaveLength(0);
  await expect(
    asUser(userA, `select * from public.consume_oauth_state('${hash}')`),
  ).rejects.toThrow(/permission denied/);
  await expect(
    asUser(userA, "select * from private.oauth_states"),
  ).rejects.toThrow(/permission denied/);
  const expired = "c".repeat(64);
  await db.exec(
    `select public.store_oauth_state('${expired}','${orgA}','${userA}','mail','${ciphertext}','${iv}','https://example.org/callback'); update private.oauth_states set expires_at=now()-interval '1 minute' where state_hash='${expired}'`,
  );
  expect(
    (await db.query(`select * from public.consume_oauth_state('${expired}')`))
      .rows,
  ).toHaveLength(0);
});
test("embedded backup restores records and tenant RLS in a separate database", async () => {
  const before = (
    await db.query<{ count: number }>(
      "select count(*)::integer as count from public.leads",
    )
  ).rows[0].count;
  const backup = await db.dumpDataDir();
  const restored = new PGlite({ loadDataDir: backup });
  try {
    expect(
      (
        await restored.query<{ count: number }>(
          "select count(*)::integer as count from public.leads",
        )
      ).rows[0].count,
    ).toBe(before);
    await restored.exec(
      `set role authenticated;select set_config('request.jwt.claim.sub','${userB}',false)`,
    );
    const own = await restored.query<{ id: string }>(
      "select id from public.leads",
    );
    expect(own.rows).toEqual([{ id: leadB }]);
  } finally {
    await restored.close();
  }
});

test("Gmail accounts allow one through ten, block duplicates and eleventh, and disconnect independently", async () => {
  const iv = "\\x" + "00".repeat(12);
  const ciphertext = "\\x" + "11".repeat(30);
  const scopes = "array['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly']";
  const connect = (n: number) =>
    `select public.save_oauth_connection('${orgA}','gmail','mail${n}@example.org',${scopes},'${ciphertext}','${iv}',now()+interval '1 hour','${userA}') as id`;
  const ids: string[] = [];
  for (let n = 1; n <= 10; n++) {
    const result = await db.query<{ id: string }>(connect(n));
    ids.push(result.rows[0].id);
  }
  expect(new Set(ids).size).toBe(10);
  await expect(db.query(connect(11))).rejects.toThrow("GMAIL_CAPACITY_REACHED");
  await expect(db.query(connect(1))).rejects.toThrow("ACCOUNT_ALREADY_CONNECTED");
  await asUser(userA, `select public.disconnect_gmail_account('${orgA}','${ids[0]}')`);
  const statuses = await db.query<{ id: string; state: string }>(
    `select id,state from public.external_connections where provider='gmail' and org_id='${orgA}' order by provider_account_id`,
  );
  expect(statuses.rows.filter((row) => row.state === "connected")).toHaveLength(9);
  expect(statuses.rows.find((row) => row.id === ids[0])?.state).toBe("disconnected");
  expect((await db.query(`select connection_id from private.oauth_secrets where connection_id='${ids[0]}'`)).rows).toHaveLength(0);
  const eleventh = (await db.query<{ id: string }>(connect(11))).rows[0].id;
  await expect(db.query(`select public.reconnect_oauth_connection('${orgA}','${ids[0]}','mail1@example.org',${scopes},'${ciphertext}','${iv}',now()+interval '1 hour','${userA}')`)).rejects.toThrow("GMAIL_CAPACITY_REACHED");
  await asUser(userA, `select public.disconnect_gmail_account('${orgA}','${eleventh}')`);
  const reconnect = await db.query<{ id: string }>(
    `select public.reconnect_oauth_connection('${orgA}','${ids[0]}','mail1@example.org',${scopes},'${ciphertext}','${iv}',now()+interval '1 hour','${userA}') as id`,
  );
  expect(reconnect.rows[0].id).toBe(ids[0]);
  await expect(asUser(userB, `select * from public.gmail_account_summary('${orgA}')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, "select * from private.oauth_secrets")).rejects.toThrow(/permission denied/);
});

test("email queue enforces suppression and current qualification independently", async () => {
  const gateDb = new PGlite();
  const org = "00000000-0000-4000-8000-000000000003";
  const owner = "00000000-0000-4000-8000-000000000013";
  const service = "00000000-0000-4000-8000-000000000033";
  const hashes = ["a", "b", "c"].map((letter) => letter.repeat(64));
  const scheduled = new Date();
  scheduled.setUTCHours(12, 0, 0, 0);
  if (scheduled.getTime() <= Date.now()) scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  while ([0, 6].includes(scheduled.getUTCDay())) scheduled.setUTCDate(scheduled.getUTCDate() + 1);
  async function asOwner(sql: string) {
    await gateDb.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false)`);
    try { return await gateDb.query(sql); } finally { await gateDb.exec("reset role"); }
  }
  try {
    await gateDb.exec(`create role service_role bypassrls; create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated;`);
    for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
      await gateDb.exec(readFileSync(`supabase/migrations/${file}`, "utf8")
        .replace("create extension if not exists pgcrypto;", ""));
    }
    await gateDb.exec(`insert into auth.users(id) values('${owner}');
      insert into public.organizations(id,name,outbound_paused,email_live_approved,email_daily_cap,email_monthly_cap,email_timezone)
        values('${org}','Synthetic queue gate',false,true,10,20,'UTC');
      insert into public.memberships(org_id,user_id,role) values('${org}','${owner}','admin');
      insert into public.service_catalog(id,org_id,service_key,name,status,reviewed_by,reviewed_at)
        values('${service}','${org}','service_15','Synthetic booking system','active','${owner}',now());`);
    const campaign = (await gateDb.query<{ id: string }>(`insert into public.campaigns(org_id,name,channel,state,daily_send_cap,purpose)
      values('${org}','Synthetic queue policy','email','active',10,'Synthetic consent purpose') returning id`)).rows[0].id;
    const connection = (await gateDb.query<{ id: string }>(`insert into public.external_connections(org_id,provider,provider_account_id,state,verified_at,scopes)
      values('${org}','gmail','gate-fixture@example.org','connected',now(),array['https://www.googleapis.com/auth/gmail.send']) returning id`)).rows[0].id;
    await gateDb.exec(`insert into public.gmail_account_settings(org_id,connection_id,timezone,window_start,window_end,daily_cap,monthly_cap,send_enabled,paused)
      values('${org}','${connection}','UTC','00:00','23:59',10,20,true,false);
      insert into public.campaign_sender_policies(org_id,campaign_id,mode,single_connection_id,account_daily_cap)
      values('${org}','${campaign}','single','${connection}',10);`);
    const drafts: string[] = [];
    for (let n = 0; n < 3; n++) {
      const email = `gate${n}@example.org`;
      const lead = (await gateDb.query<{ id: string }>(`insert into public.leads(org_id,business_name,source_type,is_demo,business_category,city,country)
        values('${org}','Synthetic gate ${n}','manual',false,'fixture','Fixture City','United States') returning id`)).rows[0].id;
      const contact = (await gateDb.query<{ id: string }>(`insert into public.contacts(org_id,lead_id,email,email_normalized)
        values('${org}','${lead}','${email}','${email}') returning id`)).rows[0].id;
      const evidence = (await gateDb.query<{ id: string }>(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
        values('${org}','${lead}','manual','https://example.org/synthetic-gate-${n}',
          'Synthetic owner-reviewed booking workflow',now(),0.9,'${owner}','observation') returning id`)).rows[0].id;
      await gateDb.exec(`insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
        values('${org}','${contact}','${email}','valid','{"syntax":"valid","mx":"present"}'::jsonb,'test_fixture',now()+interval '1 day');
        insert into public.consent_records(org_id,contact_id,channel,state,purpose,source)
        values('${org}','${contact}','email','permitted','Synthetic consent purpose','test_fixture');
        insert into public.lead_service_matches(org_id,lead_id,service_id,status,reason,evidence_ids,confidence)
        values('${org}','${lead}','${service}','verified_gap','Synthetic owner reviewed this booking workflow',array['${evidence}']::uuid[],0.9);
        insert into public.lead_qualifications(org_id,lead_id,primary_service_id,status,score,confidence,reasons,evidence_ids)
        values('${org}','${lead}','${service}',
          '${n === 2 ? "QUALIFIED" : "RESEARCH_NEEDED"}',90,0.9,array['Synthetic fixture'],array['${evidence}']::uuid[]);`);
      const subject = `Synthetic gate ${n}`;
      const body = "Owner-reviewed synthetic message";
      const draft = (await gateDb.query<{ id: string }>(`insert into public.outbound_drafts(org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
        values('${org}','${campaign}','${lead}','${contact}','email','${subject}','${body}','needs_review') returning id`)).rows[0].id;
      const digest = createHash("sha256").update(`${subject}\n${body}`).digest("hex");
      await asOwner(`select public.review_draft('${org}','${draft}',true,true,'${digest}')`);
      drafts.push(draft);
    }
    await gateDb.exec(`insert into public.suppressions(org_id,channel,identifier_hash,reason)
      values('${org}','email','${hashes[0]}','Synthetic opt-out')`);
    const enqueueGate = (n: number) => `select public.enqueue_approved_email('${org}','${drafts[n]}',
      '${hashes[n]}','gate${n}@example.org','${scheduled.toISOString()}'::timestamptz,'${owner}') as id`;
    await expect(gateDb.query(enqueueGate(0))).rejects.toThrow("EMAIL_SUPPRESSED");
    expect((await gateDb.query<{ id: string }>(`select id from public.email_outbox where draft_id='${drafts[0]}'`)).rows).toEqual([]);
    await expect(gateDb.query(enqueueGate(1))).rejects.toThrow("CURRENT_QUALIFICATION_REQUIRED");
    expect((await gateDb.query<{ id: string }>(`select id from public.email_outbox where draft_id='${drafts[1]}'`)).rows).toEqual([]);
    expect((await gateDb.query<{ draft_id: string }>(`select draft_id from public.email_outbox where org_id='${org}'`)).rows).toEqual([]);
    const queued = (await gateDb.query<{ id: string }>(enqueueGate(2))).rows[0].id;
    expect((await gateDb.query<{ id: string }>(enqueueGate(2))).rows[0].id).toBe(queued);
    expect((await gateDb.query<{ draft_id: string }>(`select draft_id from public.email_outbox where org_id='${org}'`)).rows)
      .toEqual([{ draft_id: drafts[2] }]);
    await gateDb.exec(`update public.lead_qualifications set status='RESEARCH_NEEDED'
      where org_id='${org}' and lead_id=(select lead_id from public.outbound_drafts where id='${drafts[2]}')`);
    await expect(gateDb.query(enqueueGate(2))).rejects.toThrow("CURRENT_QUALIFICATION_REQUIRED");
    await gateDb.exec(`insert into public.suppressions(org_id,channel,identifier_hash,reason)
      values('${org}','email','${hashes[2]}','Synthetic opt-out')`);
    await expect(gateDb.query(enqueueGate(2))).rejects.toThrow("EMAIL_SUPPRESSED");
    expect((await gateDb.query<{ id: string }>(`select id from public.email_outbox where org_id='${org}'`)).rows)
      .toEqual([{ id: queued }]);
  } finally { await gateDb.close(); }
});

test("business-hours Gmail sender, cap and follow-up scenario", async () => {
  const openTimezone = (await db.query<{ name: string }>(`select name from pg_timezone_names
    where name in ('America/Los_Angeles','America/New_York','Europe/London','Asia/Dubai',
      'Asia/Kolkata','Australia/Sydney','Pacific/Auckland')
      and extract(isodow from now() at time zone name)<=5
      and (now() at time zone name)::time between time '09:00' and time '16:59'
    order by name limit 1`)).rows[0]?.name;
  if (!openTimezone) return;
  const catalogService = (await db.query<{ id: string }>(`select id from public.service_catalog where org_id='${orgA}' and service_key='service_15'`)).rows[0].id;
  await asUser(userA, `update public.discovery_targeting set target_industries=array['fixture'],target_cities=array['Fixture City'],updated_by='${userA}' where org_id='${orgA}'`);
  const connected = await db.query<{ id: string; provider_account_id: string }>(
    `select id,provider_account_id from public.external_connections where org_id='${orgA}' and provider='gmail' and state='connected' order by provider_account_id`,
  );
  const first = connected.rows.find((row) => row.provider_account_id === "mail1@example.org")!.id;
  const second = connected.rows.find((row) => row.provider_account_id === "mail2@example.org")!.id;
  await db.exec(`update public.organizations set outbound_paused=false,email_live_approved=true,email_daily_cap=2,email_monthly_cap=5,email_timezone='UTC' where id='${orgA}'`);
  for (const id of [first, second]) {
    await asUser(userA, `select public.configure_gmail_account('${orgA}','${id}','Fixture Sender','','UTC',1,5,'00:00','23:59',true,false)`);
  }
  await expect(asUser(userA, `select public.configure_gmail_cooldown('${orgA}','${first}',9)`)).rejects.toThrow("INVALID_COOLDOWN");
  await expect(asUser(userB, `select public.configure_gmail_cooldown('${orgA}','${first}',15)`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.configure_gmail_cooldown('${orgA}','${first}',15)`);
  expect((await db.query<{ cooldown_minutes: number }>(`select cooldown_minutes from public.gmail_account_settings where connection_id='${first}'`)).rows[0].cooldown_minutes).toBe(15);
  await asUser(userA, `select public.configure_gmail_cooldown('${orgA}','${first}',10)`);
  const campaign = (await asUser(userA,
    `select public.create_email_campaign('${orgA}','Fixture campaign','Explicit fixture purpose') as id`,
  )).rows[0] as { id: string };
  await asUser(userA, `select public.configure_campaign_senders('${orgA}','${campaign.id}','single','${first}','{}'::uuid[],1)`);
  await asUser(userA, `select public.set_email_campaign_state('${orgA}','${campaign.id}','active',2)`);
  const fixtureHash = "a".repeat(64);
  async function approvedDraft(n: number) {
    const lead = `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
    const contact = `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
    await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo,business_category,city) values('${lead}','${orgA}','Queue Fixture ${n}','manual',false,'fixture','Fixture City');
      insert into public.contacts(id,org_id,lead_id,email,email_normalized) values('${contact}','${orgA}','${lead}','fixture${n}@example.org','fixture${n}@example.org');
      insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at) values('${orgA}','${contact}','fixture${n}@example.org','valid','{"syntax":"valid","mx":"present"}'::jsonb,'test_fixture',now()+interval '1 day');
      insert into public.consent_records(org_id,contact_id,channel,state,purpose,source) values('${orgA}','${contact}','email','permitted','Explicit fixture purpose','test_fixture');`);
    await asUser(userA, `select public.review_lead_outreach_timezone('${orgA}','${lead}','${openTimezone}','Synthetic fixture location reviewed')`);
    const gapEvidence = (await db.query<{ id: string }>(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
      values('${orgA}','${lead}','manual','https://example.org/synthetic-${n}','Fixture owner confirms a manual appointment workflow',now(),0.9,'${userA}','observation') returning id`)).rows[0].id;
    await asUser(userA, `select public.record_service_match('${orgA}','${lead}','${catalogService}','verified_gap','Fixture owner reviewed manual appointment evidence',array['${gapEvidence}']::uuid[],0.9)`);
    await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
    const subject = `Fixture ${n}`, body = "Reviewed fixture content";
    const draft = (await db.query<{ id: string }>(`insert into public.outbound_drafts(org_id,campaign_id,lead_id,contact_id,channel,subject,body,state) values('${orgA}','${campaign.id}','${lead}','${contact}','email','${subject}','${body}','needs_review') returning id`)).rows[0].id;
    const digest = createHash("sha256").update(`${subject}\n${body}`).digest("hex");
    await asUser(userA, `select public.review_draft('${orgA}','${draft}',true,true,'${digest}')`);
    return { lead, contact, draft };
  }
  const one = await approvedDraft(1);
  const enqueue = (draft: string, recipient: string, hash = fixtureHash) =>
    `select public.enqueue_approved_email('${orgA}','${draft}','${hash}','${recipient}',now(),'${userA}') as id`;
  await db.exec("begin");
  try {
    await db.exec(`update public.leads set country='IN' where id='${one.lead}'`);
    await expect(db.query(enqueue(one.draft, "fixture1@example.org"))).rejects.toThrow("INDIA_MANUAL_CALL_ONLY");
  } finally { await db.exec("rollback"); }
  const firstOutbox = (await db.query<{ id: string }>(enqueue(one.draft, "fixture1@example.org"))).rows[0].id;
  expect((await db.query<{ sender_connection_id: string }>(`select sender_connection_id from public.email_outbox where id='${firstOutbox}'`)).rows[0].sender_connection_id).toBe(first);
  expect((await db.query<{ id: string }>(enqueue(one.draft, "fixture1@example.org"))).rows[0].id).toBe(firstOutbox);
  const two = await approvedDraft(2);
  await expect(db.query(enqueue(two.draft, "fixture2@example.org"))).rejects.toThrow("NO_ELIGIBLE_SENDER");
  await asUser(userA, `select public.set_email_campaign_state('${orgA}','${campaign.id}','paused',2)`);
  await asUser(userA, `select public.configure_campaign_senders('${orgA}','${campaign.id}','selected',null,array['${first}','${second}']::uuid[],1)`);
  await asUser(userA, `select public.set_email_campaign_state('${orgA}','${campaign.id}','active',2)`);
  const secondOutbox = (await db.query<{ id: string }>(enqueue(two.draft, "fixture2@example.org", "b".repeat(64)))).rows[0].id;
  expect((await db.query<{ sender_connection_id: string }>(`select sender_connection_id from public.email_outbox where id='${secondOutbox}'`)).rows[0].sender_connection_id).toBe(second);
  const three = await approvedDraft(3);
  await expect(db.query(enqueue(three.draft, "fixture3@example.org", "c".repeat(64)))).rejects.toThrow("ORGANIZATION_DAILY_CAP");
  const four = await approvedDraft(4);
  await db.exec(`update public.email_verification_records set status='invalid' where org_id='${orgA}' and contact_id='${four.contact}'`);
  await expect(db.query(enqueue(four.draft, "fixture4@example.org", "d".repeat(64)))).rejects.toThrow("EMAIL_VERIFICATION_BLOCKED");
  await expect(db.query(enqueue(four.draft, "changed@example.org", "d".repeat(64)))).rejects.toThrow("CONTACT_EMAIL_CHANGED");
  const lease = await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_email_outbox(10)");
  expect(lease.rows).toHaveLength(1);
  const firstLease = lease.rows[0];
  expect(firstLease.id).toBe(firstOutbox);
  await expect(asUser(userA, `select public.configure_email_org_limits('${orgA}',2,5,'Asia/Kolkata')`))
    .rejects.toThrow("REPORTING_TIMEZONE_CHANGE_REQUIRES_REVIEW");
  expect((await db.query("select id from public.lease_email_outbox(10)")).rows).toHaveLength(0);
  await db.exec("begin");
  try {
    await db.exec(`update public.organizations set email_daily_cap=500 where id='${orgA}';
      insert into public.email_send_attempts(org_id,outbox_id,sender_connection_id,attempted_at)
      select '${orgA}','${firstOutbox}','${first}',now() from generate_series(1,499)`);
    const summary = (await asUser(userA, `select public.gmail_dispatch_summary('${orgA}') as data`)).rows[0] as { data: { remaining_capacity: number; attempt_reservations_today: number } };
    expect(summary.data).toMatchObject({ remaining_capacity: 0, attempt_reservations_today: 500 });
    expect((await db.query("select id from public.lease_email_outbox(10)")).rows).toHaveLength(0);
    await db.exec(`insert into public.leads(org_id,business_name,source_type,is_demo,country)
      values('${orgA}','Research continues after dispatch cap','manual',false,'United States')`);
    expect((await asUser(userA, `select id from public.leads where org_id='${orgA}'
      and business_name='Research continues after dispatch cap'`)).rows).toHaveLength(1);
  } finally { await db.exec("rollback"); }
  await expect(asUser(userB, `select public.gmail_dispatch_summary('${orgA}')`)).rejects.toThrow("FORBIDDEN");
  await db.exec(`update public.email_send_attempts set attempted_at=now()-interval '2 minutes' where outbox_id='${firstOutbox}'`);
  const secondLease = await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_email_outbox(10)");
  expect(secondLease.rows.map((row) => row.id)).toEqual([secondOutbox]);
  expect((await db.query<{ attempted_at: string }>(`select attempted_at from public.email_send_attempts where outbox_id='${firstOutbox}'`)).rows).toHaveLength(1);
  await db.exec("begin");
  try {
    await db.exec(`update public.organizations set email_daily_cap=500 where id='${orgA}';
      update public.gmail_account_settings set daily_cap=5 where connection_id='${first}';
      update public.email_send_attempts set attempted_at=now()-interval '2 minutes' where outbox_id='${secondOutbox}';
      insert into public.email_outbox(org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,
        recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at)
      select org_id,campaign_id,'${four.draft}','${four.lead}','${four.contact}','${first}',
        'fixture4@example.org',subject,body,approved_sha256,sender_name,'cooldown-fixture',now()
      from public.email_outbox where id='${firstOutbox}';`);
    expect((await db.query("select id from public.lease_email_outbox(10)")).rows).toHaveLength(0);
    await db.exec(`update public.email_send_attempts set attempted_at=now()-interval '11 minutes' where outbox_id='${firstOutbox}'`);
    expect((await db.query<{ sender_connection_id: string }>("select sender_connection_id from public.lease_email_outbox(10)")).rows)
      .toEqual([{ sender_connection_id: first }]);
  } finally { await db.exec("rollback"); }
  await db.exec("begin");
  try {
    await db.exec(`update public.leads set country='India' where id='${one.lead}'`);
    expect((await db.query<{ check_email_send_policy: string }>(`select public.check_email_send_policy('${firstOutbox}','${firstLease.lease_token}','${fixtureHash}')`)).rows[0].check_email_send_policy).toBe("held");
    expect((await db.query<{ state: string; last_error_code: string }>(`select state,last_error_code from public.email_outbox where id='${firstOutbox}'`)).rows[0]).toEqual({ state: "held", last_error_code: "INDIA_MANUAL_CALL_ONLY" });
  } finally { await db.exec("rollback"); }
  await db.exec("begin");
  try {
    await db.exec(`update public.leads set outreach_timezone=null where id='${one.lead}'`);
    expect((await db.query<{ check_email_send_policy: string }>(`select public.check_email_send_policy('${firstOutbox}','${firstLease.lease_token}','${fixtureHash}')`)).rows[0].check_email_send_policy).toBe("held");
  } finally { await db.exec("rollback"); }
  expect((await db.query<{ check_email_send_policy: string }>(`select public.check_email_send_policy('${firstOutbox}','${firstLease.lease_token}','${fixtureHash}')`)).rows[0].check_email_send_policy).toBe("eligible");
  await db.query(`select public.finish_email_outbox('${firstOutbox}','${firstLease.lease_token}','sent',null,'provider-1','thread-1')`);
  await db.exec("begin");
  try {
    await db.exec(`delete from public.email_send_attempts where outbox_id='${firstOutbox}';
      update public.organizations set email_daily_cap=1 where id='${orgA}'`);
    const legacy = (await asUser(userA, `select public.gmail_dispatch_summary('${orgA}') as data`)).rows[0] as { data: { sent_today: number; remaining_capacity: number } };
    expect(legacy.data).toMatchObject({ sent_today: 1, remaining_capacity: 0 });
  } finally { await db.exec("rollback"); }
  const syncLease = (await db.query<{ lease_token: string }>(`update public.gmail_sync_cursors
    set initial_inbox_complete=true,initial_sent_complete=true,history_id='history-1',
      last_inbox_sync_at=now()-interval '1 day',lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute'
    where connection_id='${first}' returning lease_token`)).rows[0].lease_token;
  await db.query(`select public.advance_gmail_sync('${first}','${syncLease}','history',null,'history-2',null)`);
  expect((await db.query<{ ready: string | null }>(`select private.gmail_followup_block_reason('${orgA}','${first}','thread-1',now()) as ready`)).rows[0].ready).toBeNull();
  expect((await db.query<{ fresh: boolean }>(`select last_inbox_sync_at>now()-interval '1 minute' as fresh from public.gmail_sync_cursors where connection_id='${first}'`)).rows[0].fresh).toBe(true);
  const planBody = "One separately approved follow-up fixture";
  const planDraft = (await db.query<{ id: string }>(`insert into public.outbound_drafts(org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
    values('${orgA}','${campaign.id}','${one.lead}','${one.contact}','email','Fixture 1','${planBody}','needs_review') returning id`)).rows[0].id;
  const planDigest = createHash("sha256").update(`Fixture 1\n${planBody}`).digest("hex");
  await asUser(userA, `select public.review_draft('${orgA}','${planDraft}',true,true,'${planDigest}')`);
  const planDue = (await db.query<{ due: string }>("select private.followup_earliest(now(),2::smallint,'UTC','00:00'::time) as due")).rows[0].due;
  const plan = (await asUser(userA, `select public.create_email_sequence('${orgA}','${firstOutbox}','${planDraft}',
    '${new Date(planDue).toISOString()}'::timestamptz,null,null) as id`)).rows[0] as { id: string };
  await asUser(userA, `select public.set_email_sequence_state('${orgA}','${plan.id}','active')`);
  // Reply branch from the same approved plan: owner work is created, the step
  // stops, and an attempted reactivation remains blocked by the stored reply.
  await db.exec("begin");
  try {
    await db.query(`select public.accept_gmail_message('${first}','normal-reply-1','thread-1','<normal-reply@example.org>',
      '<original@example.org>','inbound','fixture1@example.org','Re: Fixture 1','Please tell me more','question',now(),'${fixtureHash}')`);
    expect((await db.query<{ state: string }>(`select state from public.sequence_enrollments where id='${plan.id}'`)).rows[0].state).toBe("paused");
    expect((await db.query<{ title: string }>(`select title from public.tasks where org_id='${orgA}' and lead_id='${one.lead}' and title='OWNER_REPLY_REQUIRED'`)).rows).toHaveLength(1);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userA}',false)`);
    await expect(db.query(`select public.set_email_sequence_state('${orgA}','${plan.id}','active')`))
      .rejects.toThrow("REPLY_RECEIVED");
  } finally {
    await db.exec("rollback");
  }
  // Advance the synthetic clock and simulate the provider receipt inside a
  // rollback-only transaction. No mailbox or durable send is touched.
  await db.exec("begin");
  try {
    await db.exec(`update public.organizations set email_daily_cap=3 where id='${orgA}';
      update public.campaigns set daily_send_cap=3 where id='${campaign.id}';
      update public.gmail_account_settings set daily_cap=2 where connection_id='${first}';
      update public.campaign_sender_policies set account_daily_cap=2 where campaign_id='${campaign.id}';
      update public.campaign_sender_accounts set daily_cap=2 where campaign_id='${campaign.id}' and connection_id='${first}';
      update public.email_sequence_steps set due_at=now()-interval '1 minute' where enrollment_id='${plan.id}';
      update public.sequence_enrollments set next_run_at=now()-interval '1 minute' where id='${plan.id}'`);
    const due = (await db.query<{ enrollment_id: string; lease_token: string }>("select enrollment_id,lease_token from public.lease_due_email_sequences(10)"))
      .rows.find((row) => row.enrollment_id === plan.id)!;
    const advanced = (await db.query<{ result: string }>(`select public.advance_email_sequence('${plan.id}','${due.lease_token}','${fixtureHash}','fixture1@example.org') as result`)).rows[0].result;
    const advanceError = (await db.query<{ last_error_code: string | null }>(`select last_error_code from public.email_sequence_plans where enrollment_id='${plan.id}'`)).rows[0].last_error_code;
    expect(`${advanced}:${advanceError ?? "none"}`).toBe("queued:none");
    const queuedFollowup = (await db.query<{ id: string; sender_connection_id: string; provider_thread_id: string }>(
      `select o.id,o.sender_connection_id,o.provider_thread_id from public.email_sequence_steps s
       join public.email_outbox o on o.id=s.outbox_id where s.enrollment_id='${plan.id}'`)).rows[0];
    expect(queuedFollowup.sender_connection_id).toBe(first);
    expect(queuedFollowup.provider_thread_id).toBe("thread-1");
    await db.exec(`update public.email_outbox set state='sent',provider_message_id='mock-followup',updated_at=now()
      where id='${queuedFollowup.id}';
      update public.sequence_enrollments set next_run_at=now()-interval '1 minute' where id='${plan.id}'`);
    const completionLease = (await db.query<{ enrollment_id: string; lease_token: string }>("select enrollment_id,lease_token from public.lease_due_email_sequences(10)"))
      .rows.find((row) => row.enrollment_id === plan.id)!;
    expect((await db.query<{ result: string }>(`select public.advance_email_sequence('${plan.id}','${completionLease.lease_token}','${fixtureHash}','fixture1@example.org') as result`)).rows[0].result)
      .toBe("completed");
    expect((await db.query<{ state: string; followups_sent: number }>(`select state,followups_sent from public.sequence_enrollments where id='${plan.id}'`)).rows[0])
      .toEqual({ state: "completed", followups_sent: 1 });
    expect((await db.query(`select step_number from public.email_sequence_steps where enrollment_id='${plan.id}'`)).rows).toHaveLength(1);
  } finally {
    await db.exec("rollback");
  }
  await db.exec(`update public.gmail_sync_cursors set history_page_token='unfinished-page' where connection_id='${first}'`);
  expect((await db.query<{ reason: string }>(`select private.gmail_followup_block_reason('${orgA}','${first}','thread-1',now()) as reason`)).rows[0].reason).toBe("INBOX_SYNC_REVIEW_REQUIRED");
  await db.exec(`update public.sequence_enrollments set next_run_at=now()-interval '1 minute' where id='${plan.id}'`);
  const duePlan = (await db.query<{ enrollment_id: string; lease_token: string }>("select enrollment_id,lease_token from public.lease_due_email_sequences(10)")).rows.find((row) => row.enrollment_id === plan.id)!;
  expect((await db.query<{ result: string }>(`select public.advance_email_sequence('${plan.id}','${duePlan.lease_token}','${fixtureHash}','fixture1@example.org') as result`)).rows[0].result).toBe("paused");
  expect((await db.query<{ state: string }>(`select state from public.sequence_enrollments where id='${plan.id}'`)).rows[0].state).toBe("paused");
  await db.exec(`delete from public.sequence_enrollments where id='${plan.id}';
    update public.gmail_sync_cursors set history_page_token=null where connection_id='${first}'`);
  await db.query(`select public.accept_gmail_message('${first}','reply-1','thread-1','<reply@example.org>','<original@example.org>','inbound','fixture1@example.org','Re: Fixture 1','Please unsubscribe me','opt_out',now(),'${fixtureHash}')`);
  expect((await db.query<{ title: string }>(`select title from public.tasks where org_id='${orgA}' and lead_id='${one.lead}' and title='OWNER_REPLY_REQUIRED'`)).rows).toHaveLength(1);
  expect((await db.query<{ status: string }>(`select status from public.lead_qualifications where lead_id='${one.lead}' order by evaluated_at desc,id desc limit 1`)).rows[0].status).toBe("SUPPRESSED");
  const wrongPeerHash = "8".repeat(64);
  expect((await db.query<{ result: string }>(`select public.accept_gmail_message('${first}','reply-ambiguous','thread-1','<other@example.org>','<original@example.org>','inbound','stranger@example.org','Re: Fixture 1','Could you clarify?','question',now(),'${wrongPeerHash}') as result`)).rows[0].result).toBe("review_needed");
  expect((await db.query(`select id from public.suppressions where org_id='${orgA}' and identifier_hash='${wrongPeerHash}'`)).rows).toHaveLength(0);
  expect((await db.query(`select message_id from public.gmail_message_reviews where org_id='${orgA}' and reason='peer_mismatch'`)).rows).toHaveLength(1);
  expect((await db.query<{ reason: string }>(`select private.gmail_followup_block_reason('${orgA}','${first}','other-thread',now()) as reason`)).rows[0].reason).toBe("AMBIGUOUS_INBOUND_REVIEW_REQUIRED");
  const ambiguousMessage = (await db.query<{ message_id: string }>(`select message_id from public.gmail_message_reviews where org_id='${orgA}' and reason='peer_mismatch'`)).rows[0].message_id;
  await expect(asUser(userB, `select public.dismiss_unrelated_gmail_review('${orgA}','${ambiguousMessage}','This unrelated test message was checked in Gmail.')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.dismiss_unrelated_gmail_review('${orgA}','${ambiguousMessage}','short')`)).rejects.toThrow("REVIEW_REASON_REQUIRED");
  await asUser(userA, `select public.dismiss_unrelated_gmail_review('${orgA}','${ambiguousMessage}','This unrelated test message was checked in Gmail.')`);
  expect((await db.query<{ state: string }>(`select state from public.gmail_message_reviews where message_id='${ambiguousMessage}'`)).rows[0].state).toBe("dismissed");
  expect((await db.query<{ reason: string | null }>(`select private.gmail_followup_block_reason('${orgA}','${first}','other-thread',now()) as reason`)).rows[0].reason).toBeNull();
  const followupSubject = "Fixture 1";
  const followupBody = "Another reviewed fixture message";
  const followup = (await db.query<{ id: string }>(`insert into public.outbound_drafts(org_id,campaign_id,lead_id,contact_id,channel,subject,body,state) values('${orgA}','${campaign.id}','${one.lead}','${one.contact}','email','${followupSubject}','${followupBody}','needs_review') returning id`)).rows[0].id;
  const followupHash = createHash("sha256").update(`${followupSubject}\n${followupBody}`).digest("hex");
  await asUser(userA, `select public.review_draft('${orgA}','${followup}',true,true,'${followupHash}')`);
  await expect(db.query(enqueue(followup, "fixture1@example.org"))).rejects.toThrow("EMAIL_SUPPRESSED");
  expect((await db.query(`select id from public.email_outbox where draft_id='${followup}'`)).rows).toHaveLength(0);
  // Reuse the already-valid business-day due time so this assertion reaches
  // the reply gate on weekdays, weekends and across timezone boundaries.
  await expect(asUser(userA, `select public.create_email_sequence('${orgA}','${firstOutbox}','${followup}','${new Date(planDue).toISOString()}'::timestamptz,null,null)`))
    .rejects.toThrow("REPLY_REVIEW_REQUIRED");
  expect((await db.query(`select * from public.suppressions where org_id='${orgA}' and channel='email' and identifier_hash='${fixtureHash}'`)).rows).toHaveLength(1);
  expect((await db.query<{ connection_id: string; contact_id: string }>(`select connection_id,contact_id from public.gmail_threads where provider_thread_id='thread-1'`)).rows).toEqual([{ connection_id: first, contact_id: one.contact }]);
  await expect(asUser(userA, "select * from public.lease_email_outbox(1)")).rejects.toThrow(/permission denied/);
  await expect(asUser(userA, `select * from public.get_gmail_oauth_secret('${first}')`)).rejects.toThrow(/permission denied/);
  await expect(asUser(userA, "select * from public.email_outbox")).resolves.toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ id: firstOutbox })]) });
  expect((await asUser(userB, `select id from public.email_outbox where org_id='${orgA}'`)).rows).toHaveLength(0);
  await db.exec(`update public.email_outbox set lease_until=now()-interval '1 second' where id='${secondOutbox}'`);
  expect((await db.query("select id from public.lease_email_outbox(10)")).rows).toHaveLength(0);
  expect((await db.query<{ state: string }>(`select state from public.email_outbox where id='${secondOutbox}'`)).rows[0].state).toBe("uncertain");
  await expect(asUser(userA, `select public.record_gmail_parse_review('${first}','multi-recipient','thread-unsafe','RECIPIENT_REVIEW_REQUIRED')`))
    .rejects.toThrow(/permission denied/);
  await db.query(`select public.record_gmail_parse_review('${first}','multi-recipient','thread-unsafe','RECIPIENT_REVIEW_REQUIRED')`);
  await db.query(`select public.record_gmail_parse_review('${first}','multi-recipient','thread-unsafe','RECIPIENT_REVIEW_REQUIRED')`);
  const parseReview = (await db.query<{ id: string }>(`select id from public.gmail_parse_reviews where connection_id='${first}' and provider_message_id='multi-recipient'`)).rows;
  expect(parseReview).toHaveLength(1);
  expect((await db.query<{ reason: string }>(`select private.gmail_followup_block_reason('${orgA}','${first}','other-thread',now()) as reason`)).rows[0].reason)
    .toBe("UNPARSED_GMAIL_REVIEW_REQUIRED");
  expect((await db.query<{ paused: boolean; send_enabled: boolean }>(`select paused,send_enabled from public.gmail_account_settings where connection_id='${first}'`)).rows[0])
    .toEqual({ paused: true, send_enabled: false });
  await expect(asUser(userB, `select public.dismiss_unrelated_gmail_parse_review('${orgA}','${parseReview[0].id}','I inspected this unrelated synthetic message in Gmail.')`))
    .rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.dismiss_unrelated_gmail_parse_review('${orgA}','${parseReview[0].id}','I inspected this unrelated synthetic message in Gmail.')`);
  expect((await db.query<{ reason: string | null }>(`select private.gmail_followup_block_reason('${orgA}','${first}','other-thread',now()) as reason`)).rows[0].reason)
    .toBeNull();
  await db.exec(`update public.leads set is_demo=true where org_id='${orgA}' and business_name like 'Queue Fixture %'`);
});

test("email verification jobs deduplicate, reuse cache and require review for duplicates", async () => {
  const first = "30000000-0000-4000-8000-000000000001";
  const duplicate = "30000000-0000-4000-8000-000000000002";
  const hash = "e".repeat(64);
  await db.exec(`insert into public.contacts(id,org_id,lead_id,email,email_normalized) values
    ('${first}','${orgA}','${leadA}','verify@example.org','verify@example.org'),
    ('${duplicate}','${orgA}','${leadA}','verify@example.org','verify@example.org')`);
  const request = (contact: string) => `select public.request_email_verification('${orgA}','${contact}','verify@example.org','${hash}','${userA}',false) as result`;
  const queued = (await db.query<{ result: { state: string; job_id: string } }>(request(first))).rows[0].result;
  expect(queued.state).toBe("queued");
  const pending = (await db.query<{ result: { state: string; job_id: string } }>(request(first))).rows[0].result;
  expect(pending).toEqual({ state: "pending", job_id: queued.job_id });
  const lease = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_email_verification_jobs(10)")).rows[0];
  expect(lease.id).toBe(queued.job_id);
  const result = JSON.stringify({ status: "valid", provider: "mock_dns", evidence: { syntax: "pass", mx: "present" } });
  expect((await db.query<{ finish_email_verification_job: string }>(`select public.finish_email_verification_job('${lease.id}','${lease.lease_token}','${hash}','${result}'::jsonb)`)).rows[0].finish_email_verification_job).toBe("risky");
  const cached = (await db.query<{ result: { state: string; status: string } }>(request(duplicate))).rows[0].result;
  expect(cached).toMatchObject({ state: "cached", status: "risky" });
  const record = (await db.query<{ id: string }>(`select id from public.email_verification_records where contact_id='${duplicate}' order by checked_at desc,id desc limit 1`)).rows[0].id;
  await expect(db.query(`select private.email_send_verification_gate('${orgA}','${duplicate}','verify@example.org')`)).rejects.toThrow("EMAIL_VERIFICATION_REVIEW_REQUIRED");
  await expect(asUser(userB, `select public.review_email_verification('${orgA}','${duplicate}','${record}')`)).rejects.toThrow("FORBIDDEN");
  await asUser(userA, `select public.review_email_verification('${orgA}','${duplicate}','${record}')`);
  await expect(db.query(`select private.email_send_verification_gate('${orgA}','${duplicate}','verify@example.org')`)).resolves.toBeDefined();
  await db.exec(`insert into public.suppressions(org_id,channel,identifier_hash,reason) values('${orgA}','email','${hash}','fixture suppression')`);
  const suppressed = (await db.query<{ result: { state: string } }>(request(first))).rows[0].result;
  expect(suppressed.state).toBe("suppressed");
  await expect(db.query(`select private.email_send_verification_gate('${orgA}','${first}','verify@example.org')`)).rejects.toThrow("EMAIL_VERIFICATION_BLOCKED");
  await expect(asUser(userA, "select * from public.email_verification_cache")).rejects.toThrow(/permission denied/);
  expect((await asUser(userB, `select id from public.email_verification_records where org_id='${orgA}'`)).rows).toHaveLength(0);
});

test("public business research can precede contact discovery without weakening suppression", async () => {
  const lead = "39000000-0000-4000-8000-000000000001";
  const contact = "39000000-0000-4000-8000-000000000002";
  await db.exec(`insert into public.leads(id,org_id,business_name,website_url,business_category,city,source_type,is_demo)
    values('${lead}','${orgA}','Birch Studio','https://birch.example.org/','furniture','Pune','manual',false);
    update public.organizations set research_provider='serper',research_monthly_credit_cap=0 where id='${orgA}'`);
  const request = `select public.request_lead_research('${orgA}','${lead}','${userA}',false) as result`;
  await expect(asUser(userA, request)).rejects.toThrow(/permission denied/);
  await expect(db.query(request)).rejects.toThrow("RESEARCH_CREDIT_CAP");
  await db.exec(`update public.organizations set research_monthly_credit_cap=42 where id='${orgA}'`);
  const queued = (await db.query<{ result: { state: string; job_id: string } }>(request)).rows[0].result;
  expect(queued.state).toBe("queued");
  expect((await db.query<{ contact_id: string | null }>(`select contact_id from public.business_research_jobs where id='${queued.job_id}'`)).rows[0].contact_id).toBeNull();
  const lease = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_business_research_jobs(1,'serper')")).rows[0];
  await db.query(`select public.reserve_research_credits('${lease.id}','${lease.lease_token}',42)`);
  const report = JSON.stringify({ state: "manual_review", website: { status: "not_verified", url: null }, evidence: [], competitors: [],
    opportunity: "website_presence_review", confidence: 0.2, reason: "Synthetic source did not confirm identity" });
  const reportId = (await db.query<{ id: string }>(`select public.finish_business_research_job('${lease.id}','${lease.lease_token}','${report}'::jsonb) as id`)).rows[0].id;
  expect((await db.query<{ contact_id: string | null }>(`select contact_id from public.business_research_reports where id='${reportId}'`)).rows[0].contact_id).toBeNull();
  expect((await db.query<{ result: { state: string; report_id: string } }>(request)).rows[0].result)
    .toEqual({ state: "cached", report_id: reportId });
  await db.exec(`insert into public.contacts(id,org_id,lead_id,email,email_normalized)
    values('${contact}','${orgA}','${lead}','birch@example.org','birch@example.org');
    insert into public.consent_records(org_id,contact_id,channel,state,source)
    values('${orgA}','${contact}','email','opted_out','synthetic_fixture')`);
  await expect(db.query(`select public.request_lead_research('${orgA}','${lead}','${userA}',true)`)).rejects.toThrow("LEAD_SUPPRESSED");
  await db.exec(`delete from public.leads where id='${lead}'; delete from public.business_research_jobs where id='${queued.job_id}';
    delete from public.research_credit_usage where org_id='${orgA}' and provider='serper';
    update public.organizations set research_monthly_credit_cap=0 where id='${orgA}'`);
});

test("research jobs are gated by verification and a zero-default credit budget, then cache evidence", async () => {
  const lead = "40000000-0000-4000-8000-000000000001";
  const contact = "41000000-0000-4000-8000-000000000001";
  const hash = "f".repeat(64);
  await db.exec(`insert into public.leads(id,org_id,business_name,website_url,business_category,city,source_type,is_demo)
    values('${lead}','${orgA}','Oak Studio','https://oak.example.org','furniture','Pune','manual',false);
    insert into public.contacts(id,org_id,lead_id,email,email_normalized) values('${contact}','${orgA}','${lead}','oak@example.org','oak@example.org');`);
  const request = () => `select public.request_business_research('${orgA}','${lead}','${contact}','oak@example.org','${hash}','${userA}',false) as result`;
  await expect(db.query(request())).rejects.toThrow("EMAIL_VERIFICATION_REQUIRED");
  await db.exec(`insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
    values('${orgA}','${contact}','oak@example.org','valid','{"syntax":"pass","mx":"present"}'::jsonb,'mock_dns',now()+interval '1 day')`);
  await expect(db.query(request())).rejects.toThrow("RESEARCH_CREDIT_CAP");
  await db.exec(`update public.organizations set research_provider='tavily',research_monthly_credit_cap=4 where id='${orgA}'`);
  const queued = (await db.query<{ result: { state: string; job_id: string } }>(request())).rows[0].result;
  expect(queued.state).toBe("queued");
  expect((await db.query<{ result: { state: string; job_id: string } }>(request())).rows[0].result).toEqual({ state: "pending", job_id: queued.job_id });
  const leased = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_business_research_jobs(2,'tavily')")).rows[0];
  expect((await db.query<{ reserve_research_credits: boolean }>(`select public.reserve_research_credits('${leased.id}','${leased.lease_token}',4)`)).rows[0].reserve_research_credits).toBe(true);
  expect((await db.query<{ reserve_research_credits: boolean }>(`select public.reserve_research_credits('${leased.id}','${leased.lease_token}',4)`)).rows[0].reserve_research_credits).toBe(true);
  const factId = "42000000-0000-4000-8000-000000000001";
  const observed = new Date().toISOString();
  const report = JSON.stringify({ state: "ready", website: { status: "verified", url: "https://oak.example.org/" },
    evidence: [{ id: factId, kind: "business_fact", claim: "Oak Studio creates handcrafted furniture for homes in Pune.", url: "https://oak.example.org/", observed_at: observed, confidence: 0.8 }],
    competitors: [], opportunity: "website_improvement_review", confidence: 0.8, reason: "Mock source verified" });
  const saved = (await db.query<{ id: string }>(`select public.finish_business_research_job('${leased.id}','${leased.lease_token}','${report}'::jsonb) as id`)).rows[0].id;
  expect(saved).toBeTruthy();
  expect((await db.query(`select id from public.lead_evidence where id='${factId}'`)).rows).toHaveLength(1);
  expect((await db.query<{ result: { state: string; report_id: string } }>(request())).rows[0].result).toEqual({ state: "cached", report_id: saved });
  await expect(db.query(`select public.request_business_research('${orgA}','${lead}','${contact}','oak@example.org','${hash}','${userA}',true)`)).rejects.toThrow("RESEARCH_CREDIT_CAP");
  await expect(db.query(`select public.save_personalized_email_draft('${orgA}','${saved}','${contact}','${hash}',array['An idea for your website','A clearer path to enquiries'],'Unsupported pitch',array['${factId}']::uuid[],'en','openai/gpt-oss-120b','${userA}')`)).rejects.toThrow("SOURCE_EVIDENCE_NOT_REVIEWED");
  const service = (await db.query<{ id: string }>(`select id from public.service_catalog where org_id='${orgA}' and service_key='service_15'`)).rows[0].id;
  const gap = (await db.query<{ id: string }>(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
    values('${orgA}','${lead}','manual','https://oak.example.org/appointments','Oak Studio handles workshop appointment requests by phone.',now(),0.9,'${userA}','observation') returning id`)).rows[0].id;
  await asUser(userA, `update public.discovery_targeting set target_industries=array['furniture'],target_cities=array['Pune'],updated_by='${userA}' where org_id='${orgA}'`);
  await asUser(userA, `select public.record_service_match('${orgA}','${lead}','${service}','verified_gap','Owner reviewed the public appointment workflow',array['${gap}']::uuid[],0.9)`);
  await db.exec(`insert into public.consent_records(org_id,contact_id,channel,state,purpose,source) values('${orgA}','${contact}','email','permitted','Synthetic test','test_fixture')`);
  await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}')`);
  const subjects = "array['An idea for your bookings','A practical appointment suggestion']";
  const saveDraft = (evidence: string) => `select public.save_personalized_email_draft('${orgA}','${saved}','${contact}','${hash}',${subjects},'I saw the handcrafted furniture on your site. Your workshop bookings are by phone. Could an appointment system help?',array['${evidence}']::uuid[],'en','openai/gpt-oss-120b','${userA}') as id`;
  await expect(db.query(saveDraft(factId))).rejects.toThrow("SOURCE_EVIDENCE_NOT_REVIEWED");
  await asUser(userA, `select public.review_discovery_evidence('${orgA}','${factId}','approve',0.8,'I checked the source page and confirmed this business fact.')`);
  await expect(db.query(saveDraft("42000000-0000-4000-8000-000000000002"))).rejects.toThrow("SOURCE_EVIDENCE_NOT_REVIEWED");
  const personalized = (await db.query<{ id: string }>(saveDraft(factId))).rows[0].id;
  expect((await db.query<{ state: string; subject: string }>(`select state,subject from public.outbound_drafts where id='${personalized}'`)).rows[0]).toEqual({ state: "needs_review", subject: "An idea for your bookings" });
  expect((await db.query(`select subject_options from public.personalized_email_drafts where draft_id='${personalized}'`)).rows).toHaveLength(1);
  const personalizedDigest = createHash("sha256").update(`An idea for your bookings\nI saw the handcrafted furniture on your site. Your workshop bookings are by phone. Could an appointment system help?`).digest("hex");
  await expect(asUser(userA, `select public.review_draft('${orgA}','${personalized}',true,false,'${personalizedDigest}')`)).rejects.toThrow("FACTUAL_REVIEW_REQUIRED");
  await asUser(userA, `select public.review_draft('${orgA}','${personalized}',true,true,'${personalizedDigest}')`);
  expect((await db.query<{ state: string; approved_sha256: string }>(`select state,approved_sha256 from public.outbound_drafts where id='${personalized}'`)).rows[0])
    .toEqual({ state: "approved", approved_sha256: personalizedDigest });
  expect((await db.query(`select id from public.email_outbox where draft_id='${personalized}'`)).rows).toHaveLength(0);
  const leadOnlyJob = (await db.query<{ id: string }>(`insert into public.business_research_jobs(org_id,lead_id,contact_id,provider,source_snapshot,state)
    select org_id,lead_id,null,provider,source_snapshot,'completed' from public.business_research_jobs where id='${leased.id}' returning id`)).rows[0].id;
  const leadOnlyReport = (await db.query<{ id: string }>(`insert into public.business_research_reports(org_id,lead_id,contact_id,job_id,source_snapshot,state,website,evidence,competitors,opportunity,confidence,reason,provider,expires_at)
    select org_id,lead_id,null,'${leadOnlyJob}',source_snapshot,state,website,evidence,competitors,opportunity,confidence,reason,provider,expires_at
    from public.business_research_reports where id='${saved}' returning id`)).rows[0].id;
  const otherContact = "41000000-0000-4000-8000-000000000002";
  await db.exec(`insert into public.contacts(id,org_id,lead_id,email,email_normalized)
    values('${otherContact}','${orgA}','${lead}','other-oak@example.org','other-oak@example.org');
    insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
    values('${orgA}','${otherContact}','other-oak@example.org','valid','{"syntax":"pass","mx":"present"}'::jsonb,'mock_dns',now()+interval '1 day')`);
  const otherDraft = saveDraft(factId).replace(`'${saved}'`, `'${leadOnlyReport}'`).replace(`'${contact}'`, `'${otherContact}'`);
  await expect(asUser(userA, `select public.preflight_personalized_draft('${orgA}','${leadOnlyReport}','${contact}')`))
    .rejects.toThrow(/permission denied/);
  await expect(db.query(`select public.preflight_personalized_draft('${orgA}','${leadOnlyReport}','${otherContact}')`))
    .rejects.toThrow("EMAIL_PERMISSION_REQUIRED");
  await expect(db.query(otherDraft)).rejects.toThrow("EMAIL_PERMISSION_REQUIRED");
  expect((await db.query<{ contact_id: string | null }>(`select contact_id from public.business_research_reports where id='${leadOnlyReport}'`)).rows[0].contact_id).toBeNull();
  expect((await db.query<{ eligible: boolean }>(`select public.preflight_personalized_draft('${orgA}','${leadOnlyReport}','${contact}') as eligible`)).rows[0].eligible).toBe(true);
  const boundDraft = (await db.query<{ id: string }>(saveDraft(factId).replace(`'${saved}'`, `'${leadOnlyReport}'`))).rows[0].id;
  expect(boundDraft).toBeTruthy();
  expect((await db.query<{ contact_id: string }>(`select contact_id from public.business_research_reports where id='${leadOnlyReport}'`)).rows[0].contact_id)
    .toBe(contact);
  await db.exec(`insert into public.suppressions(org_id,channel,identifier_hash,reason) values('${orgA}','email','${hash}','fixture opt-out')`);
  await expect(db.query(request())).rejects.toThrow("CONTACT_SUPPRESSED");
  await expect(db.query(saveDraft(factId))).rejects.toThrow("CONTACT_SUPPRESSED");
  await db.exec(`insert into public.consent_records(org_id,contact_id,channel,state,source)
    values('${orgA}','${contact}','email','opted_out','synthetic_fixture')`);
  await expect(db.query(saveDraft(factId))).rejects.toThrow("EMAIL_PERMISSION_REQUIRED");
  expect((await asUser(userB, `select id from public.business_research_reports where org_id='${orgA}'`)).rows).toHaveLength(0);
  await expect(asUser(userA, "select * from public.research_credit_usage")).resolves.toBeDefined();
});

test("Serper is preferred with a separate conservative credit reservation", async () => {
  const lead = "43000000-0000-4000-8000-000000000001";
  const contact = "44000000-0000-4000-8000-000000000001";
  const hash = "1".repeat(64);
  await db.exec(`update public.organizations set research_provider='serper',research_monthly_credit_cap=0 where id='${orgA}';
    insert into public.leads(id,org_id,business_name,website_url,business_category,city,source_type,is_demo)
    values('${lead}','${orgA}','Pine Workshop','https://pine.example.org','furniture','Pune','manual',false);
    insert into public.contacts(id,org_id,lead_id,email,email_normalized) values('${contact}','${orgA}','${lead}','pine@example.org','pine@example.org');
    insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
    values('${orgA}','${contact}','pine@example.org','valid','{"syntax":"pass","mx":"present"}'::jsonb,'mock_dns',now()+interval '1 day')`);
  const request = `select public.request_business_research('${orgA}','${lead}','${contact}','pine@example.org','${hash}','${userA}',false) as result`;
  await expect(db.query(request)).rejects.toThrow("RESEARCH_CREDIT_CAP");
  await db.exec(`update public.organizations set research_monthly_credit_cap=42 where id='${orgA}'`);
  const queued = (await db.query<{ result: { job_id: string } }>(request)).rows[0].result;
  expect((await db.query<{ provider: string }>(`select provider from public.business_research_jobs where id='${queued.job_id}'`)).rows[0].provider).toBe("serper");
  expect((await db.query("select id from public.lease_business_research_jobs(2,'tavily')")).rows).toHaveLength(0);
  const lease = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_business_research_jobs(2,'serper')")).rows[0];
  await expect(db.query(`select public.reserve_research_credits('${lease.id}','${lease.lease_token}',4)`)).rejects.toThrow("INVALID_CREDIT_RESERVATION");
  expect((await db.query<{ reserved: boolean }>(`select public.reserve_research_credits('${lease.id}','${lease.lease_token}',42) as reserved`)).rows[0].reserved).toBe(true);
  expect((await db.query<{ provider: string; reserved_credits: number }>(`select provider,reserved_credits from public.research_credit_usage where org_id='${orgA}' and provider='serper'`)).rows[0]).toEqual({ provider: "serper", reserved_credits: 42 });
  expect((await db.query<{ reserved_credits: number }>(`select reserved_credits from public.research_credit_usage where org_id='${orgA}' and provider='tavily'`)).rows[0].reserved_credits).toBe(4);
  await expect(db.query(`select public.request_business_research('${orgA}','${lead}','${contact}','pine@example.org','${hash}','${userA}',true)`)).resolves.toBeDefined();
});

test("public email candidates require source review and enter CRM without verification or consent", async () => {
  const lead = "45000000-0000-4000-8000-000000000001";
  const token = "45000000-0000-4000-8000-000000000002";
  const source = "https://cedar.example.org/";
  await db.exec(`insert into public.leads(id,org_id,business_name,website_url,business_category,city,source_type,is_demo)
    values('${lead}','${orgA}','Cedar Studio','${source}','furniture','Pune','manual',false)`);
  const job = (await db.query<{ id: string }>(`insert into public.business_research_jobs(org_id,lead_id,provider,source_snapshot,state,lease_token,lease_until)
    select org_id,id,'serper',private.research_snapshot(l),'leased','${token}',now()+interval '5 minutes'
    from public.leads l where id='${lead}' returning id`)).rows[0].id;
  const observed = new Date().toISOString();
  const websiteEvidence = "45000000-0000-4000-8000-000000000003";
  const report = { state: "ready", website: { status: "verified", url: source }, evidence: [
    { id: websiteEvidence, kind: "website", claim: "Cedar Studio's supplied website returned readable content during research.", url: source, observed_at: observed, confidence: 0.85 },
  ], competitors: [], contact_candidates: [{ email: "hello@cedar.example.org", source_url: source, observed_at: observed, confidence: 0.65 }],
  opportunity: "website_improvement_review", confidence: 0.8, reason: "Synthetic evidence" };
  const finish = (payload: unknown) => `select public.finish_business_research_job('${job}','${token}','${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb) as id`;
  await expect(db.query(finish({ ...report, contact_candidates: [{ ...report.contact_candidates[0], email: "stranger@example.com" }] }))).rejects.toThrow("INVALID_CONTACT_CANDIDATES");
  const reportId = (await db.query<{ id: string }>(finish(report))).rows[0].id;
  expect((await db.query<{ count: number }>(`select count(*)::integer as count from public.contacts where lead_id='${lead}'`)).rows[0].count).toBe(0);
  const approve = (email: string, note = "I reviewed the business site and confirmed the published address.") =>
    `select public.approve_public_contact_candidate('${orgA}','${reportId}','${email}','${note}') as id`;
  await expect(asUser(userA, approve("hello@cedar.example.org"))).rejects.toThrow("REVIEWED_WEBSITE_EVIDENCE_REQUIRED");
  await expect(asUser(userB, approve("hello@cedar.example.org"))).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, approve("other@cedar.example.org"))).rejects.toThrow("CONTACT_CANDIDATE_NOT_FOUND");
  await asUser(userA, `select public.review_discovery_evidence('${orgA}','${websiteEvidence}','approve',0.85,'I checked the readable business website and its identity.')`);
  const contact = (await asUser(userA, approve("hello@cedar.example.org"))).rows[0] as { id: string };
  expect((await asUser(userA, approve("hello@cedar.example.org"))).rows[0]).toEqual(contact);
  const stored = (await db.query<{ email_normalized: string; verified_at: string | null; source_url: string }>(`select email_normalized,verified_at,source_url from public.contacts where id='${contact.id}'`)).rows[0];
  expect(stored).toEqual({ email_normalized: "hello@cedar.example.org", verified_at: null, source_url: source });
  expect((await db.query(`select id from public.consent_records where contact_id='${contact.id}'`)).rows).toHaveLength(0);
  const qualification = (await asUser(userA, `select public.evaluate_lead_qualification('${orgA}','${lead}') as id`)).rows[0] as { id: string };
  expect((await db.query<{ status: string }>(`select status from public.lead_qualifications where id='${qualification.id}'`)).rows[0].status).not.toBe("QUALIFIED");
});

test("Vibe contact review preserves tenant, evidence, consent and verification boundaries", async () => {
  const lead = "45100000-0000-4000-8000-000000000001";
  const token = "45100000-0000-4000-8000-000000000002";
  const source = "https://aster.example.org/";
  await db.exec(`insert into public.leads(id,org_id,business_name,website_url,business_category,city,source_type,is_demo)
    values('${lead}','${orgA}','Aster Jewellery','${source}','jewellery','Surat','manual',false)`);
  const job = (await db.query<{ id: string }>(`insert into public.business_research_jobs(org_id,lead_id,provider,source_snapshot,state,lease_token,lease_until)
    select org_id,id,'serper',private.research_snapshot(l),'leased','${token}',now()+interval '5 minutes'
    from public.leads l where id='${lead}' returning id`)).rows[0].id;
  const observed = new Date().toISOString();
  const evidenceId = "45100000-0000-4000-8000-000000000003";
  const candidate = { full_name: "Priya Shah", role: "Founder", email: "asterstudio@example.com",
    email_status: "publicly_sourced", source_url: source, observed_at: observed,
    evidence_excerpt: "Priya Shah — Founder — asterstudio@example.com", confidence: 0.7 };
  const report = { state: "ready", website: { status: "verified", url: source }, evidence: [
    { id: evidenceId, kind: "website", claim: "The supplied Aster Jewellery website returned readable content.", url: source, observed_at: observed, confidence: 0.85 },
  ], competitors: [], contact_candidates: [], decision_maker_candidates: [candidate],
  contact_observations: ["hello@aster.example.org", "sales@aster.example.org", "asterstudio@example.com"].map((value) => ({
    kind: "email", value, source_url: source, observed_at: observed,
    evidence_excerpt: `Public address ${value}`, confidence: 0.7,
  })),
  opportunity: "website_improvement_review", confidence: 0.8, reason: "Synthetic evidence" };
  const finish = (payload: unknown) => `select public.finish_business_research_job('${job}','${token}','${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb) as id`;
  await expect(db.query(finish({ ...report, decision_maker_candidates: [{ ...candidate, evidence_excerpt: "Priya Shah — Founder" }] })))
    .rejects.toThrow("INVALID_DECISION_MAKERS");
  const reportId = (await db.query<{ id: string }>(finish(report))).rows[0].id;
  expect((await db.query<{ normalized_value: string }>(`select normalized_value from public.vibe_contact_points where org_id='${orgA}' and lead_id='${lead}' order by normalized_value`)).rows.map((row) => row.normalized_value))
    .toEqual(["asterstudio@example.com", "hello@aster.example.org", "sales@aster.example.org"]);
  const approve = (name = candidate.full_name, email = candidate.email) =>
    `select public.approve_vibe_contact_candidate('${orgA}','${reportId}','${name}','${email}','I reviewed the official source and person-email association.') as id`;
  await expect(asUser(userB, approve())).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, approve())).rejects.toThrow("REVIEWED_OFFICIAL_WEBSITE_REQUIRED");
  await expect(asUser(userA, approve("Other Person"))).rejects.toThrow("SOURCED_DECISION_MAKER_NOT_FOUND");
  await asUser(userA, `select public.review_discovery_evidence('${orgA}','${evidenceId}','approve',0.85,'I checked the official website identity and source.')`);
  const contactId = (await asUser(userA, approve())).rows[0] as { id: string };
  const stored = (await db.query<{ contact_name: string; role: string; email_normalized: string; verified_at: string | null }>(
    `select contact_name,role,email_normalized,verified_at from public.contacts where id='${contactId.id}'`)).rows[0];
  expect(stored).toEqual({ contact_name: "Priya Shah", role: "Founder", email_normalized: "asterstudio@example.com", verified_at: null });
  expect((await db.query(`select id from public.consent_records where contact_id='${contactId.id}'`)).rows).toHaveLength(0);
  expect((await db.query(`select id from public.email_verification_records where contact_id='${contactId.id}'`)).rows).toHaveLength(0);
  await expect(asUser(userA, approve())).rejects.toThrow("CONTACT_DUPLICATE_REVIEW_REQUIRED");
  expect((await asUser(userB, `select id from public.business_research_reports where id='${reportId}'`)).rows).toHaveLength(0);
});

test("optional Harvey-derived OSM jobs require approved targets and keep listing URLs proposed", async () => {
  const request = `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2) as id`;
  await expect(asUser(userA, request)).rejects.toThrow("DISCOVERY_DISABLED");
  await asUser(userA, `update public.discovery_targeting set target_industries=array['dentist'],target_cities=array['Pune'],
    target_countries=array['India'],max_new_prospects=2,harvey_discovery_enabled=true,updated_by='${userA}' where org_id='${orgA}'`);
  await expect(asUser(userA, request.replace("'dentist'", "'unknown'"))).rejects.toThrow("INVALID_OSM_TARGET");
  await expect(asUser(userA, request.replace("18.52,73.85,5", "91,73.85,5"))).rejects.toThrow("INVALID_OSM_TARGET");
  const run = (await asUser(userA, request)).rows[0] as { id: string };
  await expect(asUser(userA, request)).rejects.toThrow("DISCOVERY_ALREADY_PENDING");
  const lease = (await db.query<{ id: string; lease_token: string }>("select id,lease_token from public.lease_harvey_osm_discovery_runs(1)")).rows[0];
  expect(lease.id).toBe(run.id);
  const listing = (await new HarveyOsmCollector(async () => Response.json({ elements: [
    { type: "node", id: 112, tags: { name: "Cedar Dental", website: "https://cedar.example.org/" } },
  ] })).collect({ category: "dentist", latitude: 18.52, longitude: 73.85, radiusKm: 5, limit: 2 }))[0];
  const observed = (await db.query<{ result: { state: string; lead_id: string } }>(`select public.ingest_discovered_business('${orgA}','${run.id}','harvey','harvey_osm',
    '${listing.name}','${listing.proposed_website_url}','Pune',null,'India','${listing.source_url}',
    '${listing.provider_record_id}','${listing.observed_at}'::timestamptz) as result`)).rows[0].result;
  expect(observed.state).toBe("created");
  expect((await db.query<{ website_url: string | null }>(`select website_url from public.leads where id='${observed.lead_id}'`)).rows[0].website_url).toBeNull();
  expect((await db.query<{ proposed_website_url: string }>(`select proposed_website_url from public.lead_discovery_sources where lead_id='${observed.lead_id}'`)).rows[0].proposed_website_url).toBe("https://cedar.example.org/");
  await db.query(`select public.finish_harvey_osm_discovery_run('${run.id}','${lease.lease_token}',1,null)`);
  expect((await db.query<{ state: string }>(`select state from public.discovery_runs where id='${run.id}'`)).rows[0].state).toBe("completed");
  expect((await asUser(userA, request)).rows[0]).toEqual(run);
  await expect(asUser(userA, request.replace("18.52,73.85,5", "18.53,73.85,5"))).rejects.toThrow("OSM_RATE_LIMITED");
  await db.exec(`delete from public.leads where id='${observed.lead_id}'; delete from public.discovery_runs where id='${run.id}'`);
  await asUser(userA, `update public.discovery_targeting set harvey_discovery_enabled=false,max_new_prospects=0,updated_by='${userA}' where org_id='${orgA}'`);
});

test("owner-stepped Harvey lease takes only the requested tenant run", async () => {
  await asUser(userA, `insert into public.discovery_targeting(org_id,updated_by,target_industries,target_cities,
    target_countries,max_new_prospects,harvey_discovery_enabled) values('${orgA}','${userA}',
    array['plumber'],array['Modesto'],array['United States'],1,true)
    on conflict(org_id) do update set target_industries=excluded.target_industries,target_cities=excluded.target_cities,
    target_countries=excluded.target_countries,max_new_prospects=1,harvey_discovery_enabled=true,updated_by='${userA}'`);
  const runId = (await db.query<{ id: string }>(`insert into public.discovery_runs(org_id,provider,state,requested_limit,
    target_industry,target_city,target_country,target_latitude,target_longitude,target_radius_km)
    values('${orgA}','harvey','queued',1,'plumber','Modesto','United States',37.6391,-120.9969,5)
    returning id`)).rows[0];
  await db.exec("update private.harvey_osm_rate_state set last_started_at=null where singleton=true");
  await expect(asUser(userA, `select * from public.lease_harvey_osm_owner_run('${orgA}','${runId.id}')`))
    .rejects.toThrow(/permission denied/);
  expect((await db.query(`select id from public.lease_harvey_osm_owner_run('${orgB}','${runId.id}')`)).rows).toHaveLength(0);
  expect((await db.query(`select id from public.lease_harvey_osm_owner_run('${orgA}','${orgB}')`)).rows).toHaveLength(0);
  const leased = (await db.query<{ id: string; org_id: string; lease_token: string }>(
    `select id,org_id,lease_token from public.lease_harvey_osm_owner_run('${orgA}','${runId.id}')`)).rows;
  expect(leased).toHaveLength(1);
  expect(leased[0]).toMatchObject({ id: runId.id, org_id: orgA });
  expect((await db.query(`select id from public.lease_harvey_osm_owner_run('${orgA}','${runId.id}')`)).rows).toHaveLength(0);
  await db.query(`select public.finish_harvey_osm_discovery_run('${runId.id}','${leased[0].lease_token}',0,null)`);
  await db.exec(`delete from public.discovery_runs where id='${runId.id}'`);
  await asUser(userA, `update public.discovery_targeting set harvey_discovery_enabled=false,max_new_prospects=0,updated_by='${userA}' where org_id='${orgA}'`);
});

test("contact endpoint is immutable while safe profile edits preserve consent", async () => {
  const lead = "00000000-0000-4000-8000-000000000193";
  const contact = "00000000-0000-4000-8000-000000000194";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type) values('${lead}','${orgA}','Profile Fixture','manual');
    insert into public.contacts(id,org_id,lead_id,email,email_normalized) values('${contact}','${orgA}','${lead}','before@example.org','before@example.org');
    insert into public.consent_records(org_id,contact_id,channel,state,source) values('${orgA}','${contact}','email','permitted','fixture');`);
  await expect(asUser(userA, `update public.contacts set email='after@example.org',email_normalized='after@example.org' where id='${contact}'`))
    .rejects.toThrow("CONTACT_ENDPOINT_IMMUTABLE");
  await expect(asUser(userA, `select public.edit_lead('${orgA}','${lead}','{"business_name":"Changed","email":"after@example.org"}'::jsonb)`))
    .rejects.toThrow("CONTACT_ENDPOINT_EDIT_REVIEW_REQUIRED");
  await asUser(userA, `select public.update_contact_profile('${orgA}','${lead}','${contact}','Alex','Manager','https://example.org/contact')`);
  await asUser(userA, `select public.edit_lead('${orgA}','${lead}','{"business_name":"Changed","website_url":"","city":"Test","business_category":"Test","source_url":""}'::jsonb)`);
  const rows = await db.query<{ email: string; contact_name: string; role: string; count: number }>(
    `select c.email,c.contact_name,c.role,(select count(*)::integer from public.consent_records r where r.contact_id=c.id) as count from public.contacts c where c.id='${contact}'`);
  expect(rows.rows).toEqual([{ email: "before@example.org", contact_name: "Alex", role: "Manager", count: 1 }]);
  await expect(asUser(userB, `select public.update_contact_profile('${orgA}','${lead}','${contact}','Mallory','Manager','')`))
    .rejects.toThrow(/FORBIDDEN/);
});

test("manual contact intake requires source review and grants no verification or permission", async () => {
  const lead = "00000000-0000-4000-8000-000000000195";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type) values('${lead}','${orgA}','Contact Fixture','manual')`);
  const request = `select public.add_reviewed_contact('${orgA}','${lead}','owner@sample.example','https://sample.example/contact','Reviewed business contact page') as id`;
  await expect(asUser(userB, request)).rejects.toThrow(/FORBIDDEN/);
  await expect(asUser(userA, request.replace("Reviewed business contact page", "too short"))).rejects.toThrow("CONTACT_REVIEW_REQUIRED");
  const created = (await asUser(userA, request)).rows[0] as { id: string };
  await expect(asUser(userA, request)).rejects.toThrow("CONTACT_DUPLICATE_REVIEW_REQUIRED");
  const counts = (await db.query<{ verification: number; consent: number }>(
    `select (select count(*)::integer from public.email_verification_records where contact_id='${created.id}') as verification,
      (select count(*)::integer from public.consent_records where contact_id='${created.id}') as consent`)).rows[0];
  expect(counts).toEqual({ verification: 0, consent: 0 });
});

test("search misses alone cannot qualify a new-website offer", async () => {
  const lead = "00000000-0000-4000-8000-000000000196";
  const gap = "00000000-0000-4000-8000-000000000197";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,business_category,city)
    values('${lead}','${orgA}','No Site Fixture','manual','clinic','Pune');
    insert into public.lead_evidence(id,org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
    values('${gap}','${orgA}','${lead}','manual','https://directory.example.org/listing',
      'Two reviewed directory results listed no official website for this business.',now(),0.8,'${userA}','observation')`);
  const service = ((await asUser(userA, `select id from public.service_catalog where org_id='${orgA}' and service_key='service_01'`)).rows[0] as { id: string }).id;
  await asUser(userA, `update public.service_catalog set status='active',reviewed_by='${userA}',reviewed_at=now() where id='${service}'`);
  await asUser(userA, `update public.discovery_targeting set target_industries=array['clinic'],target_cities=array['Pune'],
    target_states='{}',target_countries='{}',target_business_types='{}',excluded_industries='{}',excluded_businesses='{}',
    updated_by='${userA}' where org_id='${orgA}'`);
  await asUser(userA, `select public.record_service_match('${orgA}','${lead}','${service}','verified_gap',
    'Owner reviewed the current public listings',array['${gap}']::uuid[],0.8)`);
  const checks = ["https://directory.example.org/one", "https://search.example.org/two"].map((url) => ({ url, checked_at: new Date().toISOString(), outcome: "not_found" }));
  const assess = (ids: string) => `select public.record_website_assessment('${orgA}','${lead}','NO_OFFICIAL_WEBSITE_DISCOVERED',null,
    '${JSON.stringify(checks)}'::jsonb,${ids},'Two current public searches found no official site',0.8)`;
  await asUser(userA, assess("'{}'::uuid[]"));
  const evaluate = `select public.evaluate_lead_qualification('${orgA}','${lead}') as id`;
  const first = (await asUser(userA, evaluate)).rows[0] as { id: string };
  expect((await db.query<{ status: string }>(`select status from public.lead_qualifications where id='${first.id}'`)).rows[0].status)
    .toBe("RESEARCH_NEEDED");
  await expect(asUser(userB, `select public.record_business_website_statement('${orgA}','${lead}',
    'https://social.example.org/fixture','We currently do not have a website for our clinic.',
    'I checked that this is the business-owned public page.')`)).rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.record_business_website_statement('${orgA}','${lead}',
    'https://social.example.org/fixture','We offer appointments throughout the week.',
    'I checked that this is the business-owned public page.')`)).rejects.toThrow("BUSINESS_STATEMENT_REVIEW_REQUIRED");
  const statement = (await asUser(userA, `select public.record_business_website_statement('${orgA}','${lead}',
    'https://social.example.org/fixture','We currently do not have a website for our clinic.',
    'I checked that this is the business-owned public page.') as id`)).rows[0] as { id: string };
  await asUser(userA, assess(`array['${statement.id}']::uuid[]`));
  const second = (await asUser(userA, evaluate)).rows[0] as { id: string };
  expect((await db.query<{ status: string }>(`select status from public.lead_qualifications where id='${second.id}'`)).rows[0].status)
    .toBe("CONTACT_UNVERIFIED");
  const contact = "00000000-0000-4000-8000-000000000198";
  await db.exec(`insert into public.contacts(id,org_id,lead_id,email,email_normalized)
    values('${contact}','${orgA}','${lead}','clinic@example.org','clinic@example.org');
    insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
    values('${orgA}','${contact}','clinic@example.org','valid','{}'::jsonb,'synthetic',now()+interval '1 day');
    insert into public.consent_records(org_id,contact_id,channel,state,purpose,source)
    values('${orgA}','${contact}','email','permitted','Synthetic test','test_fixture')`);
  const qualified = (await asUser(userA, evaluate)).rows[0] as { id: string };
  expect((await db.query<{ status: string }>(`select status from public.lead_qualifications where id='${qualified.id}'`)).rows[0].status)
    .toBe("QUALIFIED");
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).resolves.toBeDefined();
  await db.exec(`update public.leads set website_url='https://clinic.example.org/' where id='${lead}'`);
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).rejects.toThrow("CURRENT_WEBSITE_ASSESSMENT_REQUIRED");
  await db.exec(`update public.leads set website_url=null where id='${lead}'`);
  const ecommerce = ((await asUser(userA, `select id from public.service_catalog where org_id='${orgA}' and service_key='service_04'`)).rows[0] as { id: string }).id;
  await asUser(userA, `update public.service_catalog set status='active',reviewed_by='${userA}',reviewed_at=now() where id='${ecommerce}'`);
  const orderingGap = (await db.query<{ id: string }>(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
    values('${orgA}','${lead}','manual','https://social.example.org/ordering',
      'The clinic says patients currently order its products by phone instead of online.',now(),0.9,'${userA}','observation') returning id`)).rows[0].id;
  await asUser(userA, `select public.record_service_match('${orgA}','${lead}','${ecommerce}','verified_gap',
    'Owner reviewed the public manual-ordering statement',array['${orderingGap}']::uuid[],0.9)`);
  const ecommerceQualification = (await asUser(userA, evaluate)).rows[0] as { id: string };
  expect((await db.query<{ status: string; primary_service_id: string }>(`select status,primary_service_id from public.lead_qualifications where id='${ecommerceQualification.id}'`)).rows[0])
    .toEqual({ status: "QUALIFIED", primary_service_id: ecommerce });
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).resolves.toBeDefined();
  await asUser(userA, `select public.record_website_assessment('${orgA}','${lead}','UNKNOWN',null,'[]'::jsonb,'{}'::uuid[],
    'A later review could not confirm whether an official website exists',0.3)`);
  await expect(db.query(`select private.require_current_qualification('${orgA}','${lead}')`)).rejects.toThrow("CURRENT_WEBSITE_ASSESSMENT_REQUIRED");
  await asUser(userA, `update public.service_catalog set status='disabled',reviewed_by=null,reviewed_at=null where id='${service}'`);
  await asUser(userA, `update public.service_catalog set status='disabled',reviewed_by=null,reviewed_at=null where id='${ecommerce}'`);
  await asUser(userA, `update public.discovery_targeting set target_industries='{}',target_cities='{}',updated_by='${userA}' where org_id='${orgA}'`);
});

test("owner-requested website checks are tenant-scoped, durable and never auto-qualify", async () => {
  const websiteLead = "00000000-0000-4000-8000-0000000000a5";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,website_url,is_demo)
    values('${websiteLead}','${orgA}','Synthetic Audit Business','manual','https://example.org/',false)`);
  await expect(asUser(userB, `select public.request_website_audit('${orgA}','${websiteLead}','Reviewed public site policy',array['example.org'])`))
    .rejects.toThrow("FORBIDDEN");
  await expect(asUser(userA, `select public.request_website_audit('${orgA}','${websiteLead}','Reviewed public site policy',array['127.0.0.1'])`))
    .rejects.toThrow("INVALID_APPROVED_HOSTS");
  await db.exec(`update public.leads set website_url='https://example.org/?private=token' where id='${websiteLead}'`);
  await expect(asUser(userA, `select public.request_website_audit('${orgA}','${websiteLead}','Reviewed public site policy',array['example.org'])`))
    .rejects.toThrow("INVALID_AUDIT_REQUEST");
  await db.exec(`update public.leads set website_url='https://example.org/' where id='${websiteLead}'`);
  const requested = await asUser(userA, `select public.request_website_audit('${orgA}','${websiteLead}','Reviewed public site policy',array['example.org']) as id`);
  const jobId = (requested.rows[0] as { id: string }).id;
  await expect(asUser(userA, "select public.lease_website_audit_job()"))
    .rejects.toThrow(/permission denied/);
  const leased = await db.query<{ id: string }>("select (public.lease_website_audit_job()).id as id");
  expect(leased.rows[0].id).toBe(jobId);
  await db.query(`select public.finish_website_audit_job('${jobId}','http_5xx','https://example.org/',503,'{"httpStatus":503}'::jsonb,null)`);
  const observations = await asUser(userA, `select outcome,http_status from public.website_audit_observations where job_id='${jobId}'`);
  expect(observations.rows).toEqual([{ outcome: "http_5xx", http_status: 503 }]);
  const observationId = (await asUser(userA, `select id from public.website_audit_observations where job_id='${jobId}'`)).rows[0] as { id: string };
  await expect(asUser(userB, `select public.review_website_audit_observation('${orgA}','${observationId.id}','Reviewed the synthetic server response')`)).rejects.toThrow("FORBIDDEN");
  const evidenceId = (await asUser(userA, `select public.review_website_audit_observation('${orgA}','${observationId.id}','Reviewed the synthetic server response') as id`)).rows[0] as { id: string };
  expect((await asUser(userA, `select claim,source_type from public.lead_evidence where id='${evidenceId.id}'`)).rows[0]).toMatchObject({ source_type: "website_audit" });
  expect((await asUser(userA, `select claim from public.lead_evidence where id='${evidenceId.id}'`)).rows[0]).toMatchObject({ claim: expect.stringContaining("HTTP 503") });
  expect((await asUser(userB, `select id from public.website_audit_observations where job_id='${jobId}'`)).rows).toEqual([]);
  expect((await asUser(userA, `select id from public.lead_qualifications where lead_id='${websiteLead}'`)).rows).toEqual([]);
  await expect(asUser(userA, `insert into public.website_audit_observations(org_id,lead_id,job_id,checked_url,outcome)
    values('${orgA}','${websiteLead}','${jobId}','https://example.org/','ok')`)).rejects.toThrow(/permission denied/);
  const second = await asUser(userA, `select public.request_website_audit('${orgA}','${websiteLead}','Reviewed public site policy',array['example.org']) as id`);
  const secondId = (second.rows[0] as { id: string }).id;
  expect((await db.query<{ id: string | null }>("select (public.lease_website_audit_job()).id as id")).rows[0].id).toBeNull();
  await db.exec("update private.website_audit_host_slots set next_allowed_at=now()-interval '1 second' where host_key='example.org'");
  await db.query("select public.lease_website_audit_job()");
  await expect(asUser(userA, `select public.close_expired_website_audit_job('${orgA}','${secondId}','Investigated uncertain synthetic lease')`))
    .rejects.toThrow("EXPIRED_AUDIT_REVIEW_REQUIRED");
  await db.exec(`update public.website_audit_jobs set lease_until=now()-interval '1 minute' where id='${secondId}'`);
  await asUser(userA, `select public.close_expired_website_audit_job('${orgA}','${secondId}','Investigated uncertain synthetic lease')`);
  expect((await db.query<{ state: string }>(`select state from public.website_audit_jobs where id='${secondId}'`)).rows[0].state).toBe("failed");
  await expect(db.query(`select public.finish_website_audit_job('${secondId}','ok','https://example.org/',200,'{}'::jsonb,null)`))
    .rejects.toThrow("AUDIT_LEASE_REQUIRED");
});

test("scrapling contact provider is admitted with identity checks intact", async () => {
  const lead = "00000000-0000-4000-8000-000000000031";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,website_url,is_demo)
    values('${lead}','${orgA}','Scrapling Fixture Site','manual','https://scrapling-fixture.example/',false)`);
  const observation = JSON.stringify([{ kind: "email", value: "hello@scrapling-fixture.example",
    source_url: "https://scrapling-fixture.example/contact", observed_at: new Date().toISOString(),
    evidence_excerpt: "Email hello@scrapling-fixture.example appears on the public contact page.",
    confidence: 0.8, source_provider: "scrapling" }]);
  const saved = await db.query<{ n: number }>(
    "select public.record_vibe_contact_observations($1,$2,$3,$4) as n", [orgA, lead, "scrapling", observation]);
  expect(saved.rows[0].n).toBe(1);
  expect((await db.query<{ id: string }>(
    "select id from public.vibe_contact_sources where source_provider='scrapling'")).rows).toHaveLength(1);
  // A repeated identical batch keeps a single source row: deduplication by
  // (org,point,provider,url,excerpt) never erases the recorded evidence.
  await db.query("select public.record_vibe_contact_observations($1,$2,$3,$4) as n", [orgA, lead, "scrapling", observation]);
  expect((await db.query<{ id: string }>(
    "select id from public.vibe_contact_sources where source_provider='scrapling'")).rows).toHaveLength(1);
  // A page outside the recorded official domain is refused for this provider.
  const foreign = JSON.stringify([{ kind: "email", value: "other@unrelated-directory.example",
    source_url: "https://unrelated-directory.example/listing", observed_at: new Date().toISOString(),
    evidence_excerpt: "Email other@unrelated-directory.example appears on the public contact page.",
    confidence: 0.8, source_provider: "scrapling" }]);
  await expect(db.query("select public.record_vibe_contact_observations($1,$2,$3,$4) as n",
    [orgA, lead, "scrapling", foreign])).rejects.toThrow("CONTACT_SOURCE_IDENTITY_UNCONFIRMED");
  // Unknown providers remain refused; overture still writes through its own reviewed path.
  await expect(db.query("select public.record_vibe_contact_observations($1,$2,$3,$4) as n",
    [orgA, lead, "scrapling_2", observation])).rejects.toThrow("INVALID_CONTACT_BATCH");
  await expect(db.query("select public.record_vibe_contact_observations($1,$2,$3,$4) as n",
    [orgA, lead, "overture", observation])).rejects.toThrow("INVALID_CONTACT_BATCH");
  await expect(db.query(`insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,evidence_excerpt,observed_at,confidence)
    select org_id,lead_id,id,'malicious','https://scrapling-fixture.example/','excerpt text here',now(),0.5
    from public.vibe_contact_points where lead_id='${lead}' limit 1`)).rejects.toThrow(/check constraint/);
});

test("record_vibe_contact_observations accepts parenthesized phone numbers", async () => {
  // Regression: 0073 briefly dropped parens from the phone strip class, which
  // would abort whole batches on values like +1 (555) 010-010.
  const lead = "00000000-0000-4000-8000-000000000032";
  const page = "https://paren-fixture.example/contact";
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,website_url,is_demo)
    values('${lead}','${orgA}','Paren Fixture Site','manual','${page}',false)`);
  const observation = JSON.stringify([{ kind: "phone", value: "+1 (555) 010-010",
    source_url: page, observed_at: new Date().toISOString(),
    evidence_excerpt: "Call +1 (555) 010-010 on the public contact page.",
    confidence: 0.65 }]);
  const saved = await db.query<{ n: number }>(
    "select public.record_vibe_contact_observations($1,$2,$3,$4) as n", [orgA, lead, "official_website", observation]);
  expect(saved.rows[0].n).toBe(1);
  const point = await db.query<{ normalized_value: string }>(
    "select normalized_value from public.vibe_contact_points where lead_id=$1", [lead]);
  expect(point.rows[0].normalized_value).toBe("+1555010010");
});


