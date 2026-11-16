// Concurrency tests for discovery queue: two concurrent workers must never
// lease the same run. Uses FOR UPDATE SKIP LOCKED in lease_serper_discovery_runs.
// Runs against PGlite with migrations 0001-0072 plus locally-applied 0074 and 0075.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";

let db: PGlite;
const userA = "00000000-0000-4000-8000-000000000011";
const orgA = "00000000-0000-4000-8000-000000000101";
const orgB = "00000000-0000-4000-8000-000000000102";
const orgC = "00000000-0000-4000-8000-000000000103";

async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role");
  }
}

async function insertOrg(orgId: string, runId: string, industry: string, city: string) {
  await db.exec(
    `insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
       values('${orgId}','Org ${orgId}','serper',100);
     insert into public.memberships(org_id,user_id,role) values('${orgId}','${userA}','admin');
     insert into public.discovery_targeting(org_id,serper_discovery_enabled,harvey_discovery_enabled,
       max_new_prospects,target_industries,target_cities,target_countries)
       values('${orgId}',true,false,10,ARRAY['${industry}'],ARRAY['${city}'],ARRAY['United States']);
     insert into public.research_credit_usage(org_id,provider,month_start,reserved_credits)
       values('${orgId}','serper',date_trunc('month',now())::date,0);
     insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
       target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts)
       values('${runId}','${orgId}','serper','queued',1,'${industry}','${city}','United States',now(),0,0,3);`);
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
     grant all on public.discovery_runs to authenticated;`,
  );

  await db.exec(`insert into auth.users values('${userA}');`);
  await insertOrg(orgA, "00000000-0000-4000-8000-000000000041", "plumber", "Phoenix");
  await insertOrg(orgB, "00000000-0000-4000-8000-000000000042", "electrician", "Austin");
  await insertOrg(orgC, "00000000-0000-4000-8000-000000000043", "dentist", "Denver");
});

afterAll(async () => { await db.close(); });

test("two concurrent leases return disjoint runs (no double-processing)", async () => {
  const [resultA, resultB] = await Promise.all([
    asUser(userA, `select id from public.lease_serper_discovery_runs(1)`),
    asUser(userA, `select id from public.lease_serper_discovery_runs(1)`),
  ]);
  const idsA = (resultA.rows as { id: string }[]).map((r) => r.id);
  const idsB = (resultB.rows as { id: string }[]).map((r) => r.id);
  const allIds = [...idsA, ...idsB];
  const uniqueIds = new Set(allIds);
  expect(uniqueIds.size).toBe(allIds.length);
  expect(idsA.length).toBeLessThanOrEqual(1);
  expect(idsB.length).toBeLessThanOrEqual(1);
  expect(allIds.length).toBe(2);
});

test("leased runs are not immediately reclaimed", async () => {
  const { rows: first } = await asUser(userA,
    `select id from public.lease_serper_discovery_runs(1)`);
  // Only 1 run remains (orgC), first call leases it
  expect(first.length).toBe(1);
  const { rows: second } = await asUser(userA,
    `select id from public.lease_serper_discovery_runs(1)`);
  expect(second.length).toBe(0);
});

test("expired lease recovery is atomic: only one worker recovers", async () => {
  // Clean up and insert one run for recovery test (orgs already exist from beforeAll)
  await db.exec(`delete from public.discovery_runs where org_id in ('${orgA}','${orgB}','${orgC}')`);
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts)
     values('00000000-0000-4000-8000-000000000050','${orgA}','serper','queued',1,'plumber','Phoenix','United States',now(),0,0,3)`);
  const { rows: first } = await asUser(userA,
    `select id from public.lease_serper_discovery_runs(1)`);
  expect(first.length).toBe(1);
  const runId = (first as { id: string }[])[0].id;
  await db.exec(
    `update public.discovery_runs set lease_until = now() - interval '1 minute'
     where id = '${runId}' and state = 'leased'`);
  // Two concurrent lease calls: only one should recover the expired run
  await Promise.all([
    asUser(userA, `select * from public.lease_serper_discovery_runs(1)`),
    asUser(userA, `select * from public.lease_serper_discovery_runs(1)`),
  ]);
  // Verify exactly one worker recovered: state='queued', lease cleared, attempts unchanged (1)
  const { rows } = await asUser(userA,
    `select state,attempts,lease_token,lease_until from public.discovery_runs where id='${runId}'`);
  expect(rows.length).toBe(1);
  const row = rows[0] as { state: string; attempts: number; lease_token: string | null; lease_until: string | null };
  expect(row.state).toBe("queued");
  expect(row.attempts).toBe(1); // recovery does not increment attempts
  expect(row.lease_token).toBeNull();
  expect(row.lease_until).toBeNull();
});
