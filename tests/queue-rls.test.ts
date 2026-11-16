// RLS tests for discovery queue tables: cross-org access denied, anon denied,
// service_role allowed. Runs against PGlite with migrations 0001-0072 plus
// locally-applied 0074 and 0075.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";

let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000001";
const orgB = "00000000-0000-4000-8000-000000000002";
const userA = "00000000-0000-4000-8000-000000000011";
const userB = "00000000-0000-4000-8000-000000000012";

async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role");
  }
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

  await db.exec(
    `insert into auth.users values('${userA}'),('${userB}');
     insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
       values('${orgA}','Org A','serper',100),('${orgB}','Org B','serper',100);
     insert into public.memberships(org_id,user_id,role) values
       ('${orgA}','${userA}','admin'),('${orgB}','${userB}','admin');
     insert into public.discovery_targeting(org_id,serper_discovery_enabled,harvey_discovery_enabled,
       max_new_prospects,target_industries,target_cities,target_countries)
       values('${orgA}',true,false,10,ARRAY['plumber'],ARRAY['Phoenix'],ARRAY['United States']),
              ('${orgB}',true,false,10,ARRAY['electrician'],ARRAY['Austin'],ARRAY['United States']);
     insert into public.research_credit_usage(org_id,provider,month_start,reserved_credits)
       values('${orgA}','serper',date_trunc('month',now())::date,0),
              ('${orgB}','serper',date_trunc('month',now())::date,0);
     insert into public.discovery_runs(id,org_id,provider,state,requested_limit,target_industry,
       target_city,target_country,next_run_at,reserved_credits,attempts,max_attempts)
     values
       ('00000000-0000-4000-8000-000000000051','${orgA}','serper','queued',1,'plumber','Phoenix','United States',now(),0,0,3),
       ('00000000-0000-4000-8000-000000000052','${orgB}','serper','queued',1,'electrician','Austin','United States',now(),0,0,3);`,
  );
});

afterAll(async () => { await db.close(); });

test("authenticated user can only see own org's discovery runs", async () => {
  const { rows: rowsA } = await asUser(userA,
    `select id from public.discovery_runs where org_id='${orgA}'`);
  const { rows: rowsB } = await asUser(userB,
    `select id from public.discovery_runs where org_id='${orgB}'`);
  expect((rowsA as { id: string }[]).length).toBe(1);
  expect((rowsB as { id: string }[]).length).toBe(1);
  expect((rowsA as { id: string }[])[0].id).toBe("00000000-0000-4000-8000-000000000051");
  expect((rowsB as { id: string }[])[0].id).toBe("00000000-0000-4000-8000-000000000052");
});

test("authenticated user cannot read another org's discovery run", async () => {
  const { rows } = await asUser(userA,
    `select id from public.discovery_runs where id='00000000-0000-4000-8000-000000000052'`);
  expect((rows as { id: string }[]).length).toBe(0);
});

test("lease is org-scoped: userA leases orgA's run only", async () => {
  const { rows } = await asUser(userA,
    `select id,org_id from public.lease_serper_discovery_runs(1)`);
  const leased = rows as { id: string; org_id: string }[];
  expect(leased.length).toBe(1);
  expect(leased[0].org_id).toBe(orgA);
});

test("anon has no access to discovery_runs", async () => {
  await db.exec("set role anon;");
  try {
    await expect(db.query(`select count(*) from public.discovery_runs`))
      .rejects.toThrow();
  } finally {
    await db.exec("reset role");
  }
});
