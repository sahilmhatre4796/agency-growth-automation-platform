// Integration tests for the queue-backed discovery worker retry state machine.
// Runs against PGlite with migrations 0001-0072 plus locally-applied 0074 and 0075.
// Migration 0073 is skipped (pending authorization). Migrations 0074 and 0075
// are applied locally only — never to remote Supabase.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";

let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000001";
const userA = "00000000-0000-4000-8000-000000000011";

async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role");
  }
}

async function insertRun(runId: string, attempts: number = 0, maxAttempts: number = 3, state: string = "queued") {
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts)
     values('${runId}','${orgA}','serper','${state}',1,'plumber','Phoenix','United States',now(),0,${attempts},${maxAttempts})`);
}

async function cleanupRuns() {
  await db.exec(`delete from public.lead_discovery_sources where org_id='${orgA}'`);
  await db.exec(`delete from public.discovery_runs where org_id='${orgA}' and provider='serper'`);
  await db.exec(`delete from public.discovery_runs where org_id='${orgA}' and provider='harvey'`);
  await db.exec(`delete from public.leads where org_id='${orgA}' and id='${'00000000-0000-0000-0000-000000000060'}'`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `create role service_role bypassrls; create role anon; create role authenticated;
     create schema auth; create table auth.users(id uuid primary key);
     create function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
     grant usage on schema auth,public to authenticated,anon;
     grant execute on function auth.uid() to authenticated,anon;`,
  );
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;alter default privileges in schema public grant all on tables to anon,authenticated;",
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (["0073_scrapling_contact_provider.sql", "0074_bounded_retries_discovery_runs.sql",
      "0075_restore_serper_campaign_invariants.sql",
      "0079_serper_finish_diagnostics.sql"].includes(file)) continue;
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  try {
    await db.exec(readFileSync("supabase/migrations/0074_bounded_retries_discovery_runs.sql", "utf8").replace(
      "create extension if not exists pgcrypto;", ""));
  } catch (cause) { throw new Error("Migration 0074 failed", { cause }); }
  try {
    await db.exec(readFileSync("supabase/migrations/0075_restore_serper_campaign_invariants.sql", "utf8").replace(
      "create extension if not exists pgcrypto;", ""));
  } catch (cause) { throw new Error("Migration 0075 failed", { cause }); }
  try {
    await db.exec(readFileSync("supabase/migrations/0079_serper_finish_diagnostics.sql", "utf8").replace(
      "create extension if not exists pgcrypto;", ""));
  } catch (cause) { throw new Error("Migration 0079 failed", { cause }); }
  await db.exec(
    `grant execute on function public.lease_serper_discovery_runs(integer) to authenticated;
     grant execute on function public.finish_serper_discovery_run(uuid,uuid,integer,text,jsonb) to authenticated;
     grant execute on function public.lease_harvey_osm_discovery_runs(integer) to authenticated;
     grant execute on function public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text) to authenticated;
     grant execute on all functions in schema public to authenticated;
     grant all on public.discovery_runs to authenticated;
     grant all on public.leads to authenticated;
     grant all on public.lead_discovery_sources to authenticated;
     grant all on public.vibe_contact_points to authenticated;
     grant all on public.vibe_contact_sources to authenticated;`,
  );

  await db.exec(
    `insert into auth.users values('${userA}');
     insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
       values('${orgA}','Test Org','serper',100);
     insert into public.memberships(org_id,user_id,role) values('${orgA}','${userA}','admin');
     insert into public.discovery_targeting(org_id,serper_discovery_enabled,harvey_discovery_enabled,
       max_new_prospects,target_industries,target_cities,target_countries)
       values('${orgA}',true,true,10,ARRAY['plumber'],ARRAY['Phoenix'],ARRAY['United States']);
     insert into public.research_credit_usage(org_id,provider,month_start,reserved_credits)
       values('${orgA}','serper',date_trunc('month',now())::date,0);`,
  );
});

afterAll(async () => { await db.close(); });

test("lease increments attempts atomically and returns leased run", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000041", 0, 3, "queued");
  const { rows } = await asUser(userA,
    `select id,state,attempts,max_attempts,lease_token,lease_until,org_id
     from public.lease_serper_discovery_runs(1)`);
  expect(rows.length).toBe(1);
  const run = rows[0] as { state: string; attempts: number; max_attempts: number; org_id: string; lease_token: string; lease_until: string };
  expect(run.state).toBe("leased");
  expect(run.attempts).toBe(1);
  expect(run.max_attempts).toBe(3);
  expect(run.lease_token).toBeTruthy();
  expect(run.lease_until).toBeTruthy();
  expect(run.org_id).toBe(orgA);
});

test("expired lease recovery requeues when attempts remain", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000042", 0, 3, "queued");
  // First lease (attempts=1)
  await asUser(userA, `select * from public.lease_serper_discovery_runs(1)`);
  // Expire the lease (superuser to avoid any permission edge cases)
  await db.exec(
    `update public.discovery_runs set lease_until = now() - interval '1 minute'
     where id = '00000000-0000-4000-8000-000000000042' and state = 'leased'`);
  // Second lease call triggers recovery: attempts=1 < max_attempts=3 -> requeued with backoff
  await asUser(userA, `select * from public.lease_serper_discovery_runs(1)`);
  // Verify recovery state directly
  const { rows } = await asUser(userA,
    `select state,attempts,next_run_at,lease_token,lease_until from public.discovery_runs where id='00000000-0000-4000-8000-000000000042'`);
  expect(rows.length).toBe(1);
  const run = rows[0] as { state: string; attempts: number; next_run_at: Date; lease_token: string | null; lease_until: string | null };
  expect(run.state).toBe("queued");
  expect(run.attempts).toBe(1); // recovery does NOT increment attempts (only lease does)
  expect(run.next_run_at).toBeInstanceOf(Date);
  expect(new Date(run.next_run_at).getTime()).toBeGreaterThan(Date.now());
  expect(run.lease_token).toBeNull();
  expect(run.lease_until).toBeNull();
});

test("expired lease recovery fails after max_attempts exhausted", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000043", 2, 3, "queued");
  await db.exec(
    `update public.discovery_runs set lease_token = gen_random_uuid(), lease_until = now() + interval '3 minutes'
     where id = '00000000-0000-4000-8000-000000000043'`);
  // Lease it (attempts becomes 3 = max_attempts)
  await asUser(userA, `select * from public.lease_serper_discovery_runs(1)`);
  // Expire it (superuser)
  await db.exec(
    `update public.discovery_runs set lease_until = now() - interval '1 minute'
     where id = '00000000-0000-4000-8000-000000000043' and state = 'leased'`);
  // Trigger recovery via second lease call: attempts=3 >= max_attempts=3 -> failed
  await asUser(userA, `select * from public.lease_serper_discovery_runs(1)`);
  const { rows } = await asUser(userA,
    `select state,last_error_code,completed_at from public.discovery_runs where id='00000000-0000-4000-8000-000000000043'`);
  const row = rows[0] as { state: string; last_error_code: string; completed_at: Date };
  expect(row.state).toBe("failed");
  expect(row.last_error_code).toBe("LEASE_EXPIRED_MAX_ATTEMPTS");
  expect(row.completed_at).toBeInstanceOf(Date);
});

test("finish with error requeues with backoff when attempts remain", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000044", 0, 3, "queued");
  const { rows: leased } = await asUser(userA,
    `select id,lease_token,attempts from public.lease_serper_discovery_runs(1)`);
  expect(leased.length).toBe(1);
  const lease = leased[0] as { id: string; lease_token: string; attempts: number };
  expect(lease.attempts).toBe(1);
  // Finish with error: attempts=1 < max_attempts=3 -> requeued
  await asUser(userA,
    `select public.finish_serper_discovery_run('${lease.id}','${lease.lease_token}',0,'PROVIDER_ERROR')`);
  const { rows: after } = await asUser(userA,
    `select state,attempts,last_error_code,next_run_at from public.discovery_runs where id='00000000-0000-4000-8000-000000000044'`);
  const row = after[0] as { state: string; attempts: number; last_error_code: string; next_run_at: Date };
  expect(row.state).toBe("queued");
  expect(row.attempts).toBe(1); // finish does NOT increment
  expect(row.last_error_code).toBe("PROVIDER_ERROR");
  expect(row.next_run_at).toBeInstanceOf(Date);
  expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
});

test("finish with error after max_attempts marks failed", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000045", 3, 3, "queued");
  const { rows: leased } = await asUser(userA,
    `select id,lease_token from public.lease_serper_discovery_runs(1)`);
  expect(leased.length).toBe(1);
  const lease = leased[0] as { id: string; lease_token: string };
  await asUser(userA,
    `select public.finish_serper_discovery_run('${lease.id}','${lease.lease_token}',0,'FINAL_ERROR')`);
  const { rows: after } = await asUser(userA,
    `select state,last_error_code from public.discovery_runs where id='00000000-0000-4000-8000-000000000045'`);
  const row = after[0] as { state: string; last_error_code: string };
  expect(row.state).toBe("failed");
  expect(row.last_error_code).toBe("FINAL_ERROR");
});

test("finish with success marks completed", async () => {
  await cleanupRuns();
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts)
     values('00000000-0000-4000-8000-000000000046','${orgA}','serper','queued',1,'plumber','Phoenix','United States',now(),31,0,3)`);
  const { rows: leased } = await asUser(userA,
    `select id,lease_token from public.lease_serper_discovery_runs(1)`);
  expect(leased.length).toBe(1);
  const lease = leased[0] as { id: string; lease_token: string };
  await asUser(userA,
    `select public.finish_serper_discovery_run('${lease.id}','${lease.lease_token}',1,null)`);
  const { rows: after } = await asUser(userA,
    `select state,observations_count,last_error_code from public.discovery_runs where id='00000000-0000-4000-8000-000000000046'`);
  const row = after[0] as { state: string; observations_count: number; last_error_code: string | null };
  expect(row.state).toBe("completed");
  expect(row.observations_count).toBe(1);
  expect(row.last_error_code).toBeNull();
});

test("finish with wrong token on finish is rejected", async () => {
  await cleanupRuns();
  await insertRun("00000000-0000-4000-8000-000000000047", 0, 3, "queued");
  await asUser(userA, `select * from public.lease_serper_discovery_runs(1)`);
  await expect(asUser(userA,
    `select public.finish_serper_discovery_run('00000000-0000-4000-8000-000000000047','00000000-0000-0000-0000-000000000000',0,null)`)
  ).rejects.toThrow();
});

test("ingest_discovered_business accepts harvey OSM provider", async () => {
  await cleanupRuns();
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts,lease_token,lease_until)
     values('00000000-0000-0000-0000-000000000050','${orgA}','harvey','leased',1,'dentist','Pune','India',now(),0,1,3,
       gen_random_uuid(),now() + interval '3 minutes')`);
  const { rows } = await asUser(userA, `select id,lease_token from public.discovery_runs where id='00000000-0000-0000-0000-000000000050'`);
  expect(rows.length).toBe(1);
  const { id } = rows[0] as { id: string };
  const { rows: osmRows } = await asUser(userA,
    `select public.ingest_discovered_business('${orgA}','${id}','harvey','harvey_osm','Test Dentist',
      'https://example.org/dentist','Pune',null,'India','https://www.openstreetmap.org/node/123','osm:node/123',now()) as result`);
  expect(osmRows.length).toBe(1);
  const osmResult = (osmRows[0] as { result: { state: string; lead_id: string } }).result;
  expect(osmResult.state).toBe("created");
  expect(osmResult.lead_id).toBeTruthy();
  const { rows: sources } = await asUser(userA,
    `select source,actual_provider,provider_record_id from public.lead_discovery_sources where org_id='${orgA}' and provider_record_id='osm:node/123'`);
  expect(sources.length).toBe(1);
  expect((sources[0] as { source: string; actual_provider: string }).source).toBe("harvey");
  expect((sources[0] as { source: string; actual_provider: string }).actual_provider).toBe("harvey_osm");
});

test("ingest_serper_observation accepts Serper-sourced run", async () => {
  await cleanupRuns();
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts,lease_token,lease_until)
     values('00000000-0000-0000-0000-000000000051','${orgA}','serper','leased',1,'plumber','Phoenix','United States',now(),31,1,3,
       gen_random_uuid(),now() + interval '3 minutes')`);
  const { rows } = await asUser(userA, `select id,lease_token from public.discovery_runs where id='00000000-0000-0000-0000-000000000051'`);
  expect(rows.length).toBe(1);
  const { id } = rows[0] as { id: string };
  const { rows: serperRows } = await asUser(userA,
    `select public.ingest_serper_observation('${orgA}','${id}','Test Plumber','Phoenix','United States',
      'https://example.org/plumber',now(),'plumber','This is a test evidence quote','https://example.org/plumber') as result`);
  expect(serperRows.length).toBe(1);
  const serperResult = (serperRows[0] as { result: { state: string; lead_id: string } }).result;
  expect(serperResult.state).toBe("created");
  expect(serperResult.lead_id).toBeTruthy();
});

test("record_vibe_contact_observations accepts harvey provider for OSM contacts", async () => {
  await cleanupRuns();
  const leadId = "00000000-0000-0000-0000-000000000060";
  const observedAt = new Date().toISOString();
  await db.exec(
    `insert into public.leads(id,org_id,business_name,source_type,is_demo,normalized_domain)
     values('${leadId}','${orgA}','Test Lead','harvey',false,'test.example.org');
     insert into public.lead_discovery_sources(org_id,lead_id,discovery_run_id,source,actual_provider,source_url,observed_at)
     values('${orgA}','${leadId}',null,'harvey','harvey_osm','https://example.org/lead','${observedAt}');`);
  const { rows } = await asUser(userA,
    `select public.record_vibe_contact_observations('${orgA}','${leadId}','harvey',
      '[{"kind":"email","value":"test@example.org","source_url":"https://example.org/lead",
        "observed_at":"${observedAt}","evidence_excerpt":"Email: test@example.org","confidence":0.5}]') as result`);
  expect(rows.length).toBe(1);
  expect((rows[0] as { result: number }).result).toBe(1);
});
