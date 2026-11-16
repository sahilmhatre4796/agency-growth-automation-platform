// Harvey discovery run creation tests (PGlite, no live APIs).
// Tests request_harvey_osm_discovery RPC (migration 0044): org eligibility,
// targeting, duplicate prevention, rate limits. No Serper credits consumed.
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

async function insertRun(
  runId: string,
  provider: string = "harvey",
  state: string = "queued",
  requestedLimit: number = 3,
  industry: string = "dentist",
  city: string = "Pune",
  country: string = "India",
  lat: number = 18.52,
  lon: number = 73.85,
  radius: number = 5,
) {
  await db.exec(
    `insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,target_latitude,target_longitude,target_radius_km,next_run_at,attempts,max_attempts)
     values('${runId}','${orgA}','${provider}','${state}',${requestedLimit},'${industry}','${city}','${country}',
       ${lat},${lon},${radius},now(),0,3)`);
}

async function cleanupRuns() {
  await db.exec(`delete from public.discovery_runs where org_id='${orgA}' and provider='harvey'`);
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
    if (["0073_scrapling_contact_provider.sql"].includes(file)) continue;
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  await db.exec(
    `grant execute on function public.request_harvey_osm_discovery(uuid,text,text,text,numeric,numeric,numeric,integer) to authenticated;
     grant execute on function public.lease_harvey_osm_discovery_runs(integer) to authenticated;
     grant execute on function public.finish_harvey_osm_discovery_run(uuid,uuid,integer,text) to authenticated;
     grant all on public.discovery_runs to authenticated;`,
  );

  await db.exec(
    `insert into auth.users values('${userA}');
     insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
       values('${orgA}','Test Org','serper',100);
     insert into public.memberships(org_id,user_id,role) values('${orgA}','${userA}','admin');
     insert into public.discovery_targeting(org_id,serper_discovery_enabled,harvey_discovery_enabled,
       max_new_prospects,target_industries,target_cities,target_countries)
       values('${orgA}',false,true,10,ARRAY['dentist'],ARRAY['Pune'],ARRAY['India']);
     insert into public.research_credit_usage(org_id,provider,month_start,reserved_credits)
       values('${orgA}','serper',date_trunc('month',now())::date,0);`,
  );
});

afterAll(async () => { await db.close(); });

test("request_harvey_osm_discovery creates queued Harvey run", async () => {
  await cleanupRuns();
  const { rows } = await asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2) as id`);
  expect(rows.length).toBe(1);
  const runId = (rows[0] as { id: string }).id;
  const { rows: runs } = await db.query(
    `select id,provider,state,requested_limit,target_industry,target_city,target_country
     from public.discovery_runs where id='${runId}'`);
  expect(runs.length).toBe(1);
  expect((runs[0] as { provider: string }).provider).toBe("harvey");
  expect((runs[0] as { state: string }).state).toBe("queued");
  expect((runs[0] as { requested_limit: number }).requested_limit).toBe(2);
  expect((runs[0] as { target_industry: string }).target_industry).toBe("dentist");
  expect((runs[0] as { target_city: string }).target_city).toBe("Pune");
  expect((runs[0] as { target_country: string }).target_country).toBe("India");
});

test("request_harvey_osm_discovery rejects non-admin", async () => {
  await cleanupRuns();
  const nonAdmin = "00000000-0000-4000-8000-000000000099";
  await db.exec(`insert into auth.users values('${nonAdmin}');`);
  await expect(asUser(nonAdmin,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/FORBIDDEN/);
});

test("request_harvey_osm_discovery rejects invalid category", async () => {
  await cleanupRuns();
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','invalid_cat','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/INVALID_OSM_TARGET/);
});

test("request_harvey_osm_discovery rejects invalid latitude", async () => {
  await cleanupRuns();
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',91,73.85,5,2)`))
    .rejects.toThrow(/INVALID_OSM_TARGET/);
});

test("request_harvey_osm_discovery rejects limit out of range", async () => {
  await cleanupRuns();
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,0)`))
    .rejects.toThrow(/INVALID_OSM_TARGET/);
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,4)`))
    .rejects.toThrow(/INVALID_OSM_TARGET/);
});

test("request_harvey_osm_discovery rejects when harvey_discovery_enabled is false", async () => {
  await cleanupRuns();
  await db.exec(
    `update public.discovery_targeting set harvey_discovery_enabled=false where org_id='${orgA}'`);
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/DISCOVERY_DISABLED/);
});

test("request_harvey_osm_discovery rejects targeting mismatch", async () => {
  await cleanupRuns();
  await db.exec(`update public.discovery_targeting set harvey_discovery_enabled=true where org_id='${orgA}'`);
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','plumber','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/DISCOVERY_TARGET_NOT_APPROVED/);
});

test("request_harvey_osm_discovery rejects DISCOVERY_ALREADY_PENDING", async () => {
  await cleanupRuns();
  await db.exec(`update public.discovery_targeting set harvey_discovery_enabled=true where org_id='${orgA}'`);
  await insertRun("00000000-0000-4000-8000-000000000101", "harvey", "queued", 2, "dentist", "Pune", "India", 18.52, 73.85, 5);
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/DISCOVERY_ALREADY_PENDING/);
});

test("request_harvey_osm_discovery returns existing run for duplicate within 14 days", async () => {
  await cleanupRuns();
  await db.exec(`update public.discovery_targeting set harvey_discovery_enabled=true where org_id='${orgA}'`);
  await insertRun("00000000-0000-4000-8000-000000000102", "harvey", "completed", 2, "dentist", "Pune", "India", 18.52, 73.85, 5);
  await db.exec(
    `update public.discovery_runs set completed_at = now() - interval '1 day'
     where id = '00000000-0000-4000-8000-000000000102'`);
  const { rows } = await asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2) as id`);
  expect((rows[0] as { id: string }).id).toBe("00000000-0000-4000-8000-000000000102");
});

test("request_harvey_osm_discovery rejects OSM_RATE_LIMITED within 2 minutes", async () => {
  await cleanupRuns();
  await db.exec(`update public.discovery_targeting set harvey_discovery_enabled=true where org_id='${orgA}'`);
  // Insert a completed run with DIFFERENT radius so the 14-day duplicate check
  // does not match, but the 2-minute rate limit still fires.
  await insertRun("00000000-0000-4000-8000-000000000103", "harvey", "completed", 2, "dentist", "Pune", "India", 18.52, 73.85, 10);
  await db.exec(
    `update public.discovery_runs set created_at = now() - interval '1 minute', completed_at = now() - interval '1 minute'
     where id = '00000000-0000-4000-8000-000000000103'`);
  await expect(asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2)`))
    .rejects.toThrow(/OSM_RATE_LIMITED/);
});

test("Harvey request does not consume Serper credits", async () => {
  await cleanupRuns();
  await db.exec(`update public.discovery_targeting set harvey_discovery_enabled=true where org_id='${orgA}'`);
  await asUser(userA,
    `select public.request_harvey_osm_discovery('${orgA}','dentist','Pune','India',18.52,73.85,5,2)`);
  const { rows } = await db.query(
    `select reserved_credits from public.research_credit_usage where org_id='${orgA}' and provider='serper'`);
  expect(rows.length).toBe(1);
  expect((rows[0] as { reserved_credits: number }).reserved_credits).toBe(0);
});
