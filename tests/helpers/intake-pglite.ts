// Shared PGlite harness for intake-handoff integration tests: real Postgres
// with every local migration, plus a minimal Supabase Auth/roles schema.
// 0073 needs pgcrypto (omitted locally, as in queue-concurrency.test.ts);
// 0074/0075 are applied afterwards in their original order.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

export async function createIntakePgLite(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(
    `create role service_role bypassrls; create role anon; create role authenticated;
     create schema auth; create table auth.users(id uuid primary key);
     create function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
     grant usage on schema auth,public to authenticated,anon;
     grant execute on function auth.uid() to authenticated,anon;`,
  );
  await db.exec(
    "alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;" +
    "alter default privileges in schema public grant all on tables to anon,authenticated;",
  );
  const deferred = ["0074_bounded_retries_discovery_runs.sql", "0075_restore_serper_campaign_invariants.sql", "0079_serper_finish_diagnostics.sql"];
  const skipped = ["0073_scrapling_contact_provider.sql", ...deferred];
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (skipped.includes(file)) continue;
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  for (const file of deferred) {
    try {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;", ""));
    } catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  return db;
}
