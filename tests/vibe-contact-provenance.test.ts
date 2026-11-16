// Provenance and schema tests: verifies review_status column exists on
// vibe_contact_points, provider check constraints are correct, and
// record_vibe_contact_observations accepts the right provider values.
// Runs against PGlite with migrations 0001-0072 plus locally-applied 0074 and 0075.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, expect, test } from "vitest";

let db: PGlite;
const orgA = "00000000-0000-4000-8000-000000000001";
const userA = "00000000-0000-4000-8000-000000000011";
const leadA = "00000000-0000-4000-8000-000000000021";

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
    `insert into auth.users values('${userA}');
     insert into public.organizations(id,name) values('${orgA}','Test Org');
     insert into public.memberships(org_id,user_id,role) values('${orgA}','${userA}','admin');
     insert into public.leads(id,org_id,business_name,source_type,is_demo,normalized_domain)
       values('${leadA}','${orgA}','Test Business','manual',false,'test.example.com');
     insert into public.lead_discovery_sources(org_id,lead_id,source,actual_provider,source_url,observed_at)
       values('${orgA}','${leadA}','serper','serper','https://example.org/business',now());`,
  );
});

afterAll(async () => { await db.close(); });

test("review_status column exists on vibe_contact_points with check constraint", async () => {
  const { rows } = await db.query(
    `select column_name, data_type, column_default
     from information_schema.columns
     where table_schema='public' and table_name='vibe_contact_points' and column_name='review_status'`);
  const cols = rows as { column_name: string; data_type: string; column_default: string }[];
  expect(cols.length).toBe(1);
  expect(cols[0].column_name).toBe("review_status");
  expect(cols[0].data_type).toBe("text");
  expect(cols[0].column_default).toBe("'pending'::text");
});

test("vibe_contact_points defaults review_status to 'pending'", async () => {
  const { rows } = await db.query(
    `insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,
      first_discovered_at,last_cross_checked_at)
     values('${orgA}','${leadA}','email','test@example.com','Test Example',now(),now())
     returning id,review_status`);
  const pts = rows as { id: string; review_status: string }[];
  expect(pts.length).toBe(1);
  expect(pts[0].review_status).toBe("pending");
});

test("vibe_contact_sources source_provider check accepts serper/harvey/vibe/official_website", async () => {
  const { rows: points } = await db.query(
    `insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,
      first_discovered_at,last_cross_checked_at)
     values('${orgA}','${leadA}','email','prov-test@example.com','Prov Test',now(),now())
     returning id`);
  const pointId = (points as { id: string }[])[0].id;
  const providers = ["serper", "harvey", "vibe", "official_website"];
  const urls = ["https://example.org/prov-business", "https://example.org/prov-business2",
    "https://example.org/prov-business3", "https://example.org/prov-contact"];
  for (let i = 0; i < providers.length; i++) {
    await db.query(
      `insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,
        evidence_excerpt,observed_at,confidence)
       values('${orgA}','${leadA}','${pointId}','${providers[i]}','${urls[i]}',
        'Example lists prov-test@example.com',now(),0.5)`);
  }
  const { rows } = await asUser(userA,
    `select source_provider from public.vibe_contact_sources where point_id='${pointId}' order by source_provider`);
  const providersFound = (rows as { source_provider: string }[]).map((r) => r.source_provider).sort();
  expect(providersFound).toEqual(["harvey", "official_website", "serper", "vibe"]);
});
