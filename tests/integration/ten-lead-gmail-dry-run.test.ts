import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { advanceLeadWorkflow } from "../../packages/server/lead-workflow.ts";
import { renderPersonalizedEmail } from "../../packages/shared/personalization.ts";
import type { ResearchReport } from "../../packages/server/research.ts";

// All provider work stops at PostgreSQL. These are synthetic approved-copy fixtures.
let db: PGlite;
const org = "a0000000-0000-4000-8000-000000000001";
const otherOrg = "a0000000-0000-4000-8000-000000000002";
const owner = "a0000000-0000-4000-8000-000000000003";
const outsider = "a0000000-0000-4000-8000-000000000004";
const campaign = "a0000000-0000-4000-8000-000000000005";
const senders = ["a0000000-0000-4000-8000-000000000006", "a0000000-0000-4000-8000-000000000007"];
const id = (section: number, n: number) => `a${section}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
  try { return await db.query(sql); }
  finally { await db.exec("reset role; reset request.jwt.claim.sub"); }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role service_role bypassrls; create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;");
  await db.exec("alter default privileges in schema public grant execute on functions to anon,authenticated,service_role; alter default privileges in schema public grant all on tables to anon,authenticated;");
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    try { await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace("create extension if not exists pgcrypto;", "")); }
    catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
});

test("ten connected synthetic accounts rotate 1–10 then wrap without sending", async () => {
  const tenant = "c0000000-0000-4000-8000-000000000001";
  const runCampaign = "c0000000-0000-4000-8000-000000000002";
  const fixtureId = (section: number, n: number) =>
    `c${section}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const accounts = Array.from({ length: 10 }, (_, i) => fixtureId(1, i + 1));
  await db.exec("begin");
  try {
    await db.exec(`insert into auth.users values('${owner}') on conflict do nothing;
      insert into public.organizations(id,name,email_timezone,email_daily_cap,email_monthly_cap,email_live_approved,outbound_paused)
      values('${tenant}','Synthetic ten account rotation','UTC',500,1000,true,false);
      insert into public.memberships(org_id,user_id,role) values('${tenant}','${owner}','admin');
      insert into public.campaigns(id,org_id,name,channel,state,daily_send_cap,purpose)
      values('${runCampaign}','${tenant}','Synthetic rotation','email','active',500,'Synthetic fixture purpose');
      insert into public.campaign_sender_policies(org_id,campaign_id,mode,account_daily_cap)
      values('${tenant}','${runCampaign}','all_enabled',50);
      insert into public.discovery_targeting(org_id,target_industries,target_cities)
      values('${tenant}',array['fixture'],array['Fixture City']);`);
    await asUser(owner, `select public.ensure_service_catalog('${tenant}')`);
    const service = (await db.query<{ id: string }>(`update public.service_catalog
      set status='active',reviewed_by='${owner}',reviewed_at=now()
      where org_id='${tenant}' and service_key='service_15' returning id`)).rows[0].id;
    for (let i = 0; i < accounts.length; i++) {
      await db.exec(`insert into public.external_connections(id,org_id,provider,provider_account_id,state,verified_at,scopes,created_at)
        values('${accounts[i]}','${tenant}','gmail','synthetic${i + 1}@example.org','connected',now(),
          array['https://www.googleapis.com/auth/gmail.send'],now()+make_interval(secs=>${i}));
        insert into public.gmail_account_settings(org_id,connection_id,timezone,window_start,window_end,daily_cap,monthly_cap,paused,send_enabled)
        values('${tenant}','${accounts[i]}','UTC','00:00','23:59',50,100,false,true);`);
    }
    const queued: string[] = [];
    const before: string[] = [];
    for (let n = 1; n <= 14; n++) {
      if (n === 13) await db.exec(`update public.gmail_account_settings set paused=true
        where connection_id='${accounts[2]}'`);
      if (n === 14) await db.exec(`update public.gmail_account_settings set daily_cap=1
        where connection_id='${accounts[4]}'`);
      const lead = fixtureId(2, n), contact = fixtureId(3, n), draft = fixtureId(4, n);
      const subject = `Synthetic subject ${n}`, body = `Synthetic factual copy ${n}`;
      const hash = createHash("sha256").update(`${subject}\n${body}`).digest("hex");
      await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo,country,business_category,city,outreach_timezone,outreach_timezone_reviewed_at)
        values('${lead}','${tenant}','Synthetic business ${n}','manual',false,'United States','fixture','Fixture City','UTC',now());
        insert into public.contacts(id,org_id,lead_id,email,email_normalized)
        values('${contact}','${tenant}','${lead}','synthetic-lead${n}@example.org','synthetic-lead${n}@example.org');
        insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
        values('${tenant}','${contact}','synthetic-lead${n}@example.org','valid','{"synthetic":true}'::jsonb,'test_fixture',now()+interval '1 day');
        insert into public.consent_records(org_id,contact_id,channel,state,purpose,source)
        values('${tenant}','${contact}','email','permitted','Synthetic fixture purpose','test_fixture');
        insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
        values('${draft}','${tenant}','${runCampaign}','${lead}','${contact}','email','${subject}','${body}','needs_review');`);
      const evidence = (await db.query<{ id: string }>(`insert into public.lead_evidence
        (org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
        values('${tenant}','${lead}','manual','https://example.org/rotation-fixture-${n}',
          'Synthetic owner-reviewed appointment workflow',now(),0.9,'${owner}','observation') returning id`)).rows[0].id;
      await asUser(owner, `select public.record_service_match('${tenant}','${lead}','${service}',
        'verified_gap','Synthetic owner-reviewed appointment opportunity',array['${evidence}']::uuid[],0.9)`);
      await asUser(owner, `select public.evaluate_lead_qualification('${tenant}','${lead}')`);
      expect((await db.query<{ status: string }>(`select status from public.lead_qualifications
        where org_id='${tenant}' and lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0].status)
        .toBe('QUALIFIED');
      await asUser(owner, `select public.review_draft('${tenant}','${draft}',true,true,'${hash}')`);
      const result = (await db.query<{ id: string }>(`select public.enqueue_approved_email('${tenant}','${draft}',
        '${"a".repeat(64)}','synthetic-lead${n}@example.org',now()+interval '10 minutes','${owner}') as id`)).rows[0].id;
      expect((await db.query<{ id: string }>(`select public.enqueue_approved_email('${tenant}','${draft}',
        '${"a".repeat(64)}','synthetic-lead${n}@example.org',now()+interval '10 minutes','${owner}') as id`)).rows[0].id)
        .toBe(result);
      queued.push(result);
      before.push((await db.query<{ sender_connection_id: string }>(`select sender_connection_id
        from public.email_outbox where id='${result}'`)).rows[0].sender_connection_id);
      if (n === 1) expect((await db.query<{ n: number }>(`select count(*)::int as n
        from public.email_outbox where org_id='${tenant}'`)).rows[0].n).toBe(1);
    }
    expect(before.slice(0, 12)).toEqual([...accounts, accounts[0], accounts[1]]);
    expect(before.slice(12)).toEqual([accounts[3], accounts[5]]);
    expect(queued).toHaveLength(14);
    await db.exec(`update public.gmail_account_settings set paused=false
      where connection_id='${accounts[2]}'`);
    await db.exec(`update public.email_outbox set scheduled_at=now()-interval '2 days' where org_id='${tenant}';
      update public.organizations set email_daily_cap=2 where id='${tenant}';
      update public.campaigns set daily_send_cap=2 where id='${runCampaign}';
      update public.gmail_account_settings set daily_cap=1,window_start='09:00',window_end='17:00'
      where org_id='${tenant}';`);
    expect((await db.query<{ moved: number }>(`select public.rollover_email_backlog('${tenant}',25) as moved`)).rows[0].moved).toBe(14);
    const after: Array<{ sender_connection_id: string; state: string }> = [];
    for (const outboxId of queued) after.push((await db.query<{ sender_connection_id: string; state: string }>(
      `select sender_connection_id,state from public.email_outbox where id='${outboxId}'`)).rows[0]);
    expect(after.map((row) => row.sender_connection_id)).toEqual(before);
    expect(after.every((row) => row.state === "queued")).toBe(true);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from public.email_send_attempts
      where org_id='${tenant}'`)).rows[0].n).toBe(0);
  } finally { await db.exec("rollback"); }
});
afterAll(async () => { await db.close(); });

test("ten approved-copy leads roll into bounded business days without changing sender or entering dispatch", async () => {
  await db.exec(`insert into auth.users values('${owner}'),('${outsider}');
    insert into public.organizations(id,name,email_timezone,email_daily_cap,email_monthly_cap,email_live_approved,outbound_paused)
      values('${org}','Synthetic dry run','UTC',20,50,true,false),('${otherOrg}','Other synthetic tenant','UTC',0,0,false,true);
    insert into public.memberships(org_id,user_id,role) values('${org}','${owner}','admin'),('${otherOrg}','${outsider}','admin');
    insert into public.campaigns(id,org_id,name,channel,state,daily_send_cap,purpose)
      values('${campaign}','${org}','Dry-run approved copy','email','active',20,'Synthetic fixture purpose');
    insert into public.external_connections(id,org_id,provider,provider_account_id,state,verified_at,scopes)
      values('${senders[0]}','${org}','gmail','sender-one@example.org','connected',now(),array['https://www.googleapis.com/auth/gmail.send']),
        ('${senders[1]}','${org}','gmail','sender-two@example.org','connected',now(),array['https://www.googleapis.com/auth/gmail.send']);
    insert into public.gmail_account_settings(org_id,connection_id,timezone,window_start,window_end,daily_cap,monthly_cap,paused,send_enabled)
      values('${org}','${senders[0]}','UTC','00:00','23:59',20,30,false,true),
        ('${org}','${senders[1]}','UTC','00:00','23:59',20,30,false,true);
    insert into public.campaign_sender_policies(org_id,campaign_id,mode,account_daily_cap)
      values('${org}','${campaign}','all_enabled',20);
    insert into public.discovery_targeting(org_id,target_industries,target_cities)
      values('${org}',array['fixture'],array['Fixture City']);`);
  await asUser(owner, `select public.ensure_service_catalog('${org}')`);
  const service = (await db.query<{ id: string }>(`update public.service_catalog
    set status='active',reviewed_by='${owner}',reviewed_at=now()
    where org_id='${org}' and service_key='service_15' returning id`)).rows[0].id;
  for (let n = 1; n <= 10; n++) {
    const lead = id(1, n), contact = id(2, n), draft = id(3, n);
    const sender = senders[(n - 1) % 2];
    await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo,country,outreach_timezone,outreach_timezone_reviewed_at)
      values('${lead}','${org}','Synthetic lead ${n}','manual',false,'United States','UTC',now());
      insert into public.contacts(id,org_id,lead_id,email,email_normalized)
      values('${contact}','${org}','${lead}','lead${n}@example.org','lead${n}@example.org');
      update public.leads set business_category='fixture',city='Fixture City' where id='${lead}';
      insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
      values('${org}','${contact}','lead${n}@example.org','valid','{"synthetic":true}'::jsonb,'test_fixture',now()+interval '1 day');
      insert into public.consent_records(org_id,contact_id,channel,state,purpose,source)
      values('${org}','${contact}','email','permitted','Synthetic fixture purpose','test_fixture');`);
    const evidence = (await db.query<{ id: string }>(`insert into public.lead_evidence(org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
      values('${org}','${lead}','manual','https://example.org/synthetic-${n}',
        'Synthetic owner-reviewed appointment workflow',now(),0.9,'${owner}','observation') returning id`)).rows[0].id;
    const website = `https://synthetic-${n}.example.org/`;
    const report: ResearchReport = { state: "ready", website: { status: "verified", url: website },
      evidence: [{ id: id(4, n), kind: "business_fact", claim: `Synthetic lead ${n} provides scheduled repair visits to local customers.`,
        url: website, observed_at: new Date().toISOString(), confidence: 0.9 }],
      competitors: [], opportunity: "appointment_workflow_review", confidence: 0.9,
      reason: "Synthetic public fact for a local-only factual-rendering test" };
    const rendered = renderPersonalizedEmail(`Synthetic lead ${n}`, report,
      { fact_id: id(4, n), competitor_id: null, language: "en" },
      { service_name: "Appointment and booking systems",
        gap_claim: "Synthetic owner-reviewed appointment workflow", gap_evidence_id: evidence,
        benefit: "easier appointment requests", confidence: 0.9 });
    const subject = rendered.subjects[0], body = rendered.body;
    expect(rendered.word_count).toBeLessThanOrEqual(90);
    const hash = createHash("sha256").update(`${subject}\n${body}`).digest("hex");
    await asUser(owner, `select public.record_service_match('${org}','${lead}','${service}',
      'verified_gap','Synthetic owner-reviewed appointment opportunity',array['${evidence}']::uuid[],0.9)`);
    await asUser(owner, `select public.evaluate_lead_qualification('${org}','${lead}')`);
    expect((await db.query<{ status: string }>(`select status from public.lead_qualifications
      where org_id='${org}' and lead_id='${lead}' order by evaluated_at desc,id desc limit 1`)).rows[0].status).toBe("QUALIFIED");
    const step = await advanceLeadWorkflow({
      country: "United States", leadStatus: "qualified", identityReviewed: true, websiteStatus: "WORKING", serviceGapReviewed: true,
      qualificationStatus: "QUALIFIED", sourcedEmailCount: 1, contactId: contact, verificationStatus: "valid",
      verificationReviewed: false,
      reportId: `synthetic-report-${n}`, reportReady: true, permissionRecorded: true, draftId: null,
    }, {
      requestVibe: async () => { throw new Error("UNEXPECTED_VIBE_REQUEST"); },
      evaluateQualification: async () => { throw new Error("UNEXPECTED_QUALIFICATION_REQUEST"); },
      requestVerification: async () => { throw new Error("UNEXPECTED_VERIFICATION_REQUEST"); },
      requestResearch: async () => { throw new Error("UNEXPECTED_RESEARCH_REQUEST"); },
      createDraft: async (report, selectedContact) => {
        expect(report).toBe(`synthetic-report-${n}`);
        expect(selectedContact).toBe(contact);
        await db.query(`insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
          values($1,$2,$3,$4,$5,'email',$6,$7,'needs_review')`, [draft, org, campaign, lead, contact, subject, body]);
        return draft;
      },
    }, { vibe: false, verification: false, research: false, ai: true });
    expect(step).toMatchObject({ state: "draft_review", reason: "OWNER_DRAFT_APPROVAL_REQUIRED", draftId: draft });
    expect((await db.query<{ count: number }>(`select count(*)::int as count from public.email_outbox where draft_id='${draft}'`)).rows[0].count).toBe(0);
    await asUser(owner, `select public.review_draft('${org}','${draft}',true,true,'${hash}')`);
    expect((await db.query<{ approval_by: string; approved_sha256: string; state: string }>(
      `select approval_by,approved_sha256,state from public.outbound_drafts where id='${draft}'`)).rows[0])
      .toMatchObject({ approval_by: owner, approved_sha256: hash, state: "approved" });
    const queued = (await db.query<{ id: string }>(`select public.enqueue_approved_email('${org}','${draft}',
      '${"a".repeat(64)}','lead${n}@example.org',now()+interval '10 minutes','${owner}') as id`)).rows[0].id;
    expect((await db.query<{ id: string }>(`select public.enqueue_approved_email('${org}','${draft}',
      '${"a".repeat(64)}','lead${n}@example.org',now()+interval '10 minutes','${owner}') as id`)).rows[0].id)
      .toBe(queued);
    expect((await db.query<{ sender_connection_id: string; approved_sha256: string }>(
      `select sender_connection_id,approved_sha256 from public.email_outbox where id='${queued}'`)).rows[0])
      .toMatchObject({ sender_connection_id: sender, approved_sha256: hash });
  }
  expect((await db.query(`select draft_id from public.email_backlog_candidates('${org}',10)`)).rows).toHaveLength(0);
  await expect(asUser(owner, `select draft_id from public.email_backlog_candidates('${org}',10)`)).rejects.toThrow(/permission denied/);
  await db.exec(`update public.email_outbox set scheduled_at=now()-interval '2 days' where org_id='${org}';
    update public.organizations set email_daily_cap=2 where id='${org}';
    update public.campaigns set daily_send_cap=2 where id='${campaign}';
    update public.gmail_account_settings set daily_cap=1,window_start='09:00',window_end='17:00'
    where org_id='${org}';`);
  const before = (await db.query<{ id: string; sender_connection_id: string; subject: string; body: string }>(
    `select id,sender_connection_id,subject,body from public.email_outbox where org_id='${org}' order by id`)).rows;
  expect(before).toHaveLength(10);
  expect((await db.query<{ moved: number }>(`select public.rollover_email_backlog('${org}',25) as moved`)).rows[0].moved).toBe(10);
  expect((await db.query<{ moved: number }>(`select public.rollover_email_backlog('${org}',25) as moved`)).rows[0].moved).toBe(0);
  const after = (await db.query<{ id: string; sender_connection_id: string; subject: string; body: string; state: string; country: string; scheduled_at: string }>(
    `select o.id,o.sender_connection_id,o.subject,o.body,o.state,l.country,o.scheduled_at
       from public.email_outbox o join public.leads l on l.id=o.lead_id where o.org_id='${org}' order by o.id`)).rows;
  for (let n = 0; n < 10; n++) {
    expect(after[n]).toMatchObject(before[n]);
    expect(after[n].state).toBe("queued");
  }
  const overseas = after;
  const perDay = new Map<string, number>();
  const perAccountDay = new Map<string, number>();
  for (const row of overseas) {
    const scheduled = new Date(row.scheduled_at);
    expect(scheduled.getTime()).toBeGreaterThan(Date.now());
    expect([0, 6]).not.toContain(scheduled.getUTCDay());
    expect(scheduled.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(scheduled.getUTCHours()).toBeLessThan(17);
    const day = scheduled.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    const accountDay = `${row.sender_connection_id}:${day}`;
    perAccountDay.set(accountDay, (perAccountDay.get(accountDay) ?? 0) + 1);
  }
  expect(perDay.size).toBeGreaterThanOrEqual(5);
  expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
  expect(Math.max(...perAccountDay.values())).toBe(1);
  const today = new Date().toISOString().slice(0, 10);
  const futureCount = overseas.filter((row) => new Date(row.scheduled_at).toISOString().slice(0, 10) > today).length;
  expect((await asUser(owner, `select public.gmail_backlog_summary('${org}') as result`)).rows[0])
    .toEqual({ result: expect.objectContaining({ approved_backlog: 0, future_queued: futureCount }) });
  expect((await asUser(outsider, `select id from public.email_outbox where org_id='${org}'`)).rows).toEqual([]);
  await expect(asUser(owner, `select public.rollover_email_backlog('${org}',1)`)).rejects.toThrow(/permission denied/);
  expect((await db.query<{ count: number }>(`select count(*)::int as count from public.email_send_attempts where org_id='${org}'`)).rows[0].count).toBe(0);
  expect((await db.query<{ count: number }>(`select count(*)::int as count from public.email_outbox where org_id='${org}'`)).rows[0].count).toBe(10);
  await expect(db.query(`insert into public.email_outbox(org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,
    recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at)
    select org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,recipient_email,subject,body,
      approved_sha256,sender_name,idempotency_key,scheduled_at from public.email_outbox where id='${before[0].id}'`))
    .rejects.toThrow(/duplicate key/);
  const laterDraft = id(3, 12), laterSubject = "Synthetic later subject", laterBody = "Synthetic later factual draft";
  await db.query(`insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
    values($1,$2,$3,$4,$5,'email',$6,$7,'needs_review')`,
    [laterDraft, org, campaign, id(1, 1), id(2, 1), laterSubject, laterBody]);
  await asUser(owner, `select public.review_draft('${org}','${laterDraft}',true,true,'${createHash("sha256").update(`${laterSubject}\n${laterBody}`).digest("hex")}')`);
  expect((await db.query<{ draft_id: string }>(`select draft_id from public.email_backlog_candidates('${org}',10)`)).rows)
    .toEqual([{ draft_id: laterDraft }]);
  await db.exec(`update public.organizations set email_daily_cap=500 where id='${org}';
    insert into public.email_send_attempts(org_id,outbox_id,sender_connection_id)
    select '${org}','${before[0].id}','${senders[0]}' from generate_series(1,500)`);
  const dispatch = (await asUser(owner, `select public.gmail_dispatch_summary('${org}') as result`)).rows[0] as
    { result: { attempt_reservations_today: number; remaining_capacity: number } };
  expect(dispatch.result).toMatchObject({ attempt_reservations_today: 500, remaining_capacity: 0 });
  expect((await db.query(`select id from public.lease_email_outbox(1)`)).rows).toEqual([]);
  expect((await db.query<{ count: number }>(`select count(*)::int as count from public.email_outbox where org_id='${org}'`)).rows[0].count).toBe(10);
  const indiaLead = id(1, 11), indiaContact = id(2, 11), indiaDraft = id(3, 11);
  await db.exec(`insert into public.leads(id,org_id,business_name,source_type,is_demo,country)
    values('${indiaLead}','${org}','Synthetic India lead','manual',false,'India');
    insert into public.contacts(id,org_id,lead_id,email,email_normalized)
    values('${indiaContact}','${org}','${indiaLead}','india@example.org','india@example.org');
    insert into public.outbound_drafts(id,org_id,campaign_id,lead_id,contact_id,channel,subject,body,state)
    values('${indiaDraft}','${org}','${campaign}','${indiaLead}','${indiaContact}','email','India fixture','Synthetic copy','queued');`);
  await expect(db.query(`insert into public.email_outbox(org_id,campaign_id,draft_id,lead_id,contact_id,sender_connection_id,
    recipient_email,subject,body,approved_sha256,sender_name,idempotency_key,scheduled_at)
    values('${org}','${campaign}','${indiaDraft}','${indiaLead}','${indiaContact}','${senders[0]}',
      'india@example.org','India fixture','Synthetic copy','${"a".repeat(64)}','Synthetic sender','india-rejected',now())`))
    .rejects.toThrow("INDIA_MANUAL_CALL_ONLY");
});

test("one synthetic lead traverses persisted contact, verification, qualification, research and factual draft gates", async () => {
  const tenant = "b0000000-0000-4000-8000-000000000001";
  const lead = "b0000000-0000-4000-8000-000000000002";
  const reportFact = "b0000000-0000-4000-8000-000000000003";
  const hash = "b".repeat(64);
  const website = "https://connected.example.org/";
  await db.exec("begin");
  try {
    await db.exec(`insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
      values('${tenant}','Synthetic connected workflow','tavily',4);
      insert into public.memberships(org_id,user_id,role) values('${tenant}','${owner}','admin');
      insert into public.leads(id,org_id,business_name,source_type,is_demo,country,website_url,business_category,city)
      values('${lead}','${tenant}','Connected Fixture','manual',false,'United States','${website}','fixture','Fixture City');
      insert into public.discovery_targeting(org_id,target_industries,target_cities)
      values('${tenant}',array['fixture'],array['Fixture City']);`);
    await asUser(owner, `select public.ensure_service_catalog('${tenant}')`);
    const service = (await db.query<{ id: string }>(`update public.service_catalog
      set status='active',reviewed_by='${owner}',reviewed_at=now()
      where org_id='${tenant}' and service_key='service_15' returning id`)).rows[0].id;
    const facts = (await db.query<{ id: string }>(`insert into public.lead_evidence
      (org_id,lead_id,source_type,source_url,claim,observed_at,confidence,reviewed_by,kind)
      values('${tenant}','${lead}','manual','${website}','Connected Fixture offers scheduled repair visits.',now(),0.9,'${owner}','observation'),
      ('${tenant}','${lead}','manual','https://listing.example.org/connected','Connected Fixture operates in Fixture City.',now(),0.9,'${owner}','observation')
      returning id`)).rows;
    await db.exec(`insert into public.lead_website_assessments(org_id,lead_id,status,official_url,reason,confidence)
      values('${tenant}','${lead}','WORKING','${website}','Synthetic reviewed site',0.9)`);
    await asUser(owner, `select public.record_service_match('${tenant}','${lead}','${service}',
      'verified_gap','Synthetic reviewed appointment workflow',array['${facts[0].id}']::uuid[],0.9)`);
    const saved = {
      country: "United States", leadStatus: "new", identityReviewed: true, websiteStatus: "WORKING",
      serviceGapReviewed: true, qualificationStatus: null as string | null, sourcedEmailCount: 0,
      contactId: null as string | null, verificationStatus: null as string | null,
      verificationReviewed: false, reportId: null as string | null, reportReady: false,
      permissionRecorded: false, draftId: null as string | null,
    };
    const stages: string[] = [];
    const ports = {
      evaluateQualification: async () => {
        const result = (await asUser(owner, `select public.evaluate_lead_qualification('${tenant}','${lead}') as id`)).rows[0] as { id: string };
        const status = (await db.query<{ status: string }>(`select status from public.lead_qualifications where id='${result.id}'`)).rows[0].status;
        saved.qualificationStatus = status; stages.push("qualification"); return status;
      },
      requestVibe: async () => {
        const observations = JSON.stringify([{ kind: "email", value: "team@connected.example.org", source_url: website,
          evidence_excerpt: "Email team@connected.example.org", observed_at: new Date().toISOString(), confidence: 0.9 }]);
        await db.query(`select public.record_vibe_contact_observations($1,$2,'official_website',$3::jsonb)`, [tenant, lead, observations]);
        stages.push("vibe"); return "queued" as const;
      },
      requestVerification: async (contactId: string) => {
        const request = (await db.query<{ result: { state: string } }>(`select public.request_email_verification(
          '${tenant}','${contactId}','team@connected.example.org','${hash}','${owner}',false) as result`)).rows[0].result;
        expect(request.state).toBe("queued"); stages.push("verification"); return "queued" as const;
      },
      requestResearch: async (contactId: string) => {
        const request = (await db.query<{ result: { state: string } }>(`select public.request_business_research(
          '${tenant}','${lead}','${contactId}','team@connected.example.org','${hash}','${owner}',false) as result`)).rows[0].result;
        expect(request.state).toBe("queued"); stages.push("research"); return { state: "queued" as const };
      },
      createDraft: async (reportId: string, contactId: string) => {
        const report = { state: "ready" as const, website: { status: "verified" as const, url: website },
          evidence: [{ id: reportFact, kind: "business_fact" as const,
            claim: "Connected Fixture offers scheduled repair visits.", url: website,
            observed_at: new Date(Date.now() - 60_000).toISOString(), confidence: 0.9 }], competitors: [],
          opportunity: "appointment_workflow_review" as const, confidence: 0.9,
          reason: "Synthetic evidence for a local connected test" };
        const copy = renderPersonalizedEmail("Connected Fixture", report,
          { fact_id: reportFact, competitor_id: null, language: "en" },
          { service_name: "Appointment and booking systems", gap_claim: "Synthetic reviewed appointment workflow",
            gap_evidence_id: facts[0].id, benefit: "easier appointment requests", confidence: 0.9 });
        expect(copy.word_count).toBeLessThanOrEqual(90);
        const result = await db.query<{ id: string }>(`select public.save_personalized_email_draft(
          $1,$2,$3,$4,$5::text[],$6,$7::uuid[],'en','mock-selection',$8) as id`,
        [tenant, reportId, contactId, hash, copy.subjects, copy.body, [reportFact], owner]);
        stages.push("draft"); return result.rows[0].id;
      },
    };
    const enabled = { vibe: true, verification: true, research: true, ai: true };
    expect((await advanceLeadWorkflow(saved, ports, enabled)).reason).toBe("VIBE_DISCOVERY_PENDING");
    const point = (await db.query<{ id: string }>(`select id from public.vibe_contact_points where org_id='${tenant}' and lead_id='${lead}'`)).rows[0];
    expect(point.id).toBeTruthy();
    expect((await asUser(outsider, `select id from public.vibe_contact_points where org_id='${tenant}'`)).rows).toEqual([]);
    await asUser(owner, `select public.review_vibe_contact_point('${tenant}','${point.id}','approve','general',
      'Synthetic official page confirms the exact business email.')`);
    saved.sourcedEmailCount = 1;
    saved.contactId = (await db.query<{ id: string }>(`select id from public.contacts where org_id='${tenant}' and lead_id='${lead}'`)).rows[0].id;
    expect((await advanceLeadWorkflow(saved, ports, enabled)).reason).toBe("EMAIL_VERIFICATION_PENDING");
    const verificationJob = (await db.query<{ id: string; lease_token: string }>(
      "select id,lease_token from public.lease_email_verification_jobs(1)")).rows[0];
    expect((await db.query<{ status: string }>(`select public.finish_email_verification_job(
      '${verificationJob.id}','${verificationJob.lease_token}','${hash}',
      '{"status":"valid","provider":"mock_reacher","evidence":{"synthetic":true,"mailbox_check":"mocked"}}'::jsonb) as status`)).rows[0].status).toBe("valid");
    saved.verificationStatus = (await db.query<{ status: string }>(`select status from public.email_verification_records
      where org_id='${tenant}' and contact_id='${saved.contactId}' order by checked_at desc limit 1`)).rows[0].status;
    expect((await advanceLeadWorkflow(saved, ports, enabled)).reason).toBe("RECIPIENT_PERMISSION_REQUIRED");
    await db.exec(`insert into public.consent_records(org_id,contact_id,channel,state,purpose,source)
      values('${tenant}','${saved.contactId}','email','permitted','Synthetic local test','test_fixture')`);
    saved.permissionRecorded = true;
    expect((await advanceLeadWorkflow(saved, ports, enabled)).reason).toBe("BUSINESS_RESEARCH_PENDING");
    const researchJob = (await db.query<{ id: string; lease_token: string }>(
      "select id,lease_token from public.lease_business_research_jobs(1,'tavily')")).rows[0];
    await db.query(`select public.reserve_research_credits('${researchJob.id}','${researchJob.lease_token}',4)`);
    const payload = { state: "ready", website: { status: "verified", url: website },
      evidence: [{ id: reportFact, kind: "business_fact", claim: "Connected Fixture offers scheduled repair visits.",
        url: website, observed_at: new Date(Date.now() - 60_000).toISOString(), confidence: 0.9 }],
      competitors: [], opportunity: "appointment_workflow_review", confidence: 0.9, reason: "Synthetic mock research" };
    saved.reportId = (await db.query<{ id: string }>(`select public.finish_business_research_job($1,$2,$3::jsonb) as id`,
      [researchJob.id, researchJob.lease_token, JSON.stringify(payload)])).rows[0].id;
    await asUser(owner, `select public.review_discovery_evidence('${tenant}','${reportFact}','approve',0.9,
      'Synthetic source and exact business statement checked for this fixture.')`);
    saved.reportReady = true;
    const outcome = await advanceLeadWorkflow(saved, ports, enabled);
    expect(outcome).toMatchObject({ state: "draft_review", reason: "OWNER_DRAFT_APPROVAL_REQUIRED" });
    expect(stages).toEqual(["vibe", "verification", "qualification", "research", "draft"]);
    expect((await db.query<{ state: string }>(`select state from public.outbound_drafts where id='${outcome.draftId}'`)).rows[0].state)
      .toBe("needs_review");
    expect((await db.query(`select id from public.email_outbox where org_id='${tenant}'`)).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});
