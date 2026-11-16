import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

test("migration downgrades existing latest search-only website qualifications", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role service_role bypassrls; create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to authenticated,anon;
      grant execute on function auth.uid() to authenticated,anon;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
    const migrations = readdirSync("supabase/migrations").filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations.filter((name) => name < "0047_no_website_positive_evidence.sql")) {
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8")
        .replace("create extension if not exists pgcrypto;", ""));
    }
    const org = "00000000-0000-4000-8000-000000000201";
    const user = "00000000-0000-4000-8000-000000000202";
    const lead = "00000000-0000-4000-8000-000000000203";
    const qualification = "00000000-0000-4000-8000-000000000204";
    await db.exec(`insert into auth.users(id) values('${user}');
      insert into public.organizations(id,name) values('${org}','Upgrade Fixture');
      insert into public.memberships(org_id,user_id,role) values('${org}','${user}','admin');
      insert into public.leads(id,org_id,business_name,source_type) values('${lead}','${org}','Search-only Fixture','manual');
      insert into public.service_catalog(org_id,service_key,name) values('${org}','service_01','Business websites');`);
    const service = (await db.query<{ id: string }>(`select id from public.service_catalog where org_id='${org}' and service_key='service_01'`)).rows[0].id;
    await db.exec(`insert into public.lead_qualifications(id,org_id,lead_id,primary_service_id,status,score,confidence,reasons,evidence_ids)
      values('${qualification}','${org}','${lead}','${service}','QUALIFIED',80,0.8,array['Older reviewed search misses'],
        array['00000000-0000-4000-8000-000000000205']::uuid[])`);
    await db.exec(readFileSync("supabase/migrations/0047_no_website_positive_evidence.sql", "utf8"));
    expect((await db.query<{ status: string; primary_service_id: string | null; score: number }>(
      `select status,primary_service_id,score from public.lead_qualifications where id='${qualification}'`)).rows[0])
      .toEqual({ status: "RESEARCH_NEEDED", primary_service_id: null, score: 0 });
    expect((await db.query(`select id from public.audit_events where entity_id='${qualification}'
      and action='qualification_downgraded_for_missing_site_evidence'`)).rows).toHaveLength(1);
  } finally {
    await db.close();
  }
});
