import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";

const org = "e0000000-0000-4000-8000-000000000001";
const otherOrg = "e0000000-0000-4000-8000-000000000002";
const owner = "e0000000-0000-4000-8000-000000000011";
const outsider = "e0000000-0000-4000-8000-000000000012";
const place = {
  id: "550e8400-e29b-41d4-a716-446655440090",
  release: "2026-10-21.0",
  name: "Synthetic Alloy Works",
  category: "welder",
  city: "Modesto",
  state_region: "California",
  country: "USA",
  website_url: "https://synthetic-alloy.example/",
  source_url: "https://explore.overturemaps.org/",
  sources: [{ dataset: "meta", record_id: "meta-9090" }],
  observed_at: new Date().toISOString(),
  emails: ["HELLO@SYNTHETIC-ALLOY.EXAMPLE", "hello@synthetic-alloy.example"],
  phones: ["+1555010006", "+1555010006"],
  review_note: "Owner reviewed this synthetic source record and location before promotion.",
};

let db: PGlite;
async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
  try { return await db.query(sql); }
  finally { await db.exec("reset role; reset request.jwt.claim.sub"); }
}
const promote = (tenant: string, input: Omit<typeof place, "website_url"> & { website_url: string | null }) =>
  `select public.promote_reviewed_overture_place('${tenant}','${JSON.stringify(input)}'::jsonb) as result`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role service_role bypassrls; create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated;`);
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    try { await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8")
      .replace("create extension if not exists pgcrypto;", "")); }
    catch (cause) { throw new Error(`Migration ${file} failed`, { cause }); }
  }
  await db.exec(`insert into auth.users values('${owner}'),('${outsider}');
    insert into public.organizations(id,name) values('${org}','Synthetic Overture tenant'),('${otherOrg}','Other tenant');
    insert into public.memberships(org_id,user_id,role) values('${org}','${owner}','admin'),('${otherOrg}','${outsider}','admin');`);
});
afterAll(async () => { await db.close(); });

test("reviewed Overture promotion preserves provenance and pending contacts without outreach", async () => {
  await expect(asUser(outsider, promote(org, place))).rejects.toThrow("FORBIDDEN");
  await expect(asUser(owner, promote(org, { ...place, review_note: "short" })))
    .rejects.toThrow("INVALID_OVERTURE_PLACE");
  const created = (await asUser(owner, promote(org, place))).rows[0] as
    { result: { state: string; lead_id: string; pending_contacts: number } };
  expect(created.result).toMatchObject({ state: "created", pending_contacts: 2 });
  const leadId = created.result.lead_id;
  expect((await asUser(owner, `select business_name,city,state_region,country,status,website_url,needs
    from public.leads where org_id='${org}' and id='${leadId}'`)).rows[0]).toMatchObject({
    business_name: place.name, city: "Modesto", state_region: "California", country: "USA",
    status: "researching", website_url: null, needs: null,
  });
  expect((await asUser(owner, `select source,actual_provider,provider_record_id,proposed_website_url,
    source_metadata->>'release' as release,source_metadata->'sources' as sources
    from public.lead_discovery_sources where org_id='${org}' and lead_id='${leadId}'`)).rows)
    .toEqual([{ source: "overture", actual_provider: "overture_user_export", provider_record_id: place.id,
      proposed_website_url: place.website_url, release: place.release,
      sources: [{ dataset: "meta", record_id: "meta-9090", property: null,
        license: null, update_time: null }] }]);
  expect((await asUser(owner, `select status,official_url,reason from public.lead_website_assessments
    where org_id='${org}' and lead_id='${leadId}'`)).rows[0]).toMatchObject({
    status: "UNKNOWN", official_url: null,
  });
  expect((await asUser(owner, `select claim,source_url,source_type,reviewed_by,rejected_by
    from public.lead_evidence where org_id='${org}' and lead_id='${leadId}'`)).rows[0])
    .toMatchObject({ source_url: place.source_url, source_type: "overture", reviewed_by: null, rejected_by: null });
  expect((await asUser(owner, `select kind,normalized_value,review_status,reviewed_by
    from public.vibe_contact_points where org_id='${org}' and lead_id='${leadId}' order by kind`)).rows)
    .toEqual([{ kind: "email", normalized_value: "hello@synthetic-alloy.example", review_status: "pending", reviewed_by: null },
      { kind: "phone", normalized_value: "+1555010006", review_status: "pending", reviewed_by: null }]);
  expect((await asUser(owner, `select source_provider,source_url from public.vibe_contact_sources
    where org_id='${org}' and lead_id='${leadId}'`)).rows)
    .toEqual([{ source_provider: "overture", source_url: place.source_url },
      { source_provider: "overture", source_url: place.source_url }]);
  for (const table of ["contacts", "email_outbox"]) {
    expect((await db.query(`select id from public.${table} where org_id='${org}' and lead_id='${leadId}'`)).rows).toEqual([]);
  }
  expect((await db.query(`select cr.id from public.consent_records cr join public.contacts c
    on c.org_id=cr.org_id and c.id=cr.contact_id where c.org_id='${org}' and c.lead_id='${leadId}'`)).rows).toEqual([]);
  expect((await asUser(outsider, `select id from public.leads where org_id='${org}' and id='${leadId}'`)).rows).toEqual([]);
  expect((await asUser(outsider, `select id from public.vibe_contact_points where org_id='${org}' and lead_id='${leadId}'`)).rows).toEqual([]);
  expect((await asUser(owner, promote(org, place))).rows[0]).toEqual({ result: { state: "already_recorded", lead_id: leadId } });
  const ambiguous = { ...place, id: "550e8400-e29b-41d4-a716-446655440091" };
  const repeat = (await asUser(owner, promote(org, ambiguous))).rows[0] as
    { result: { state: string; possible_lead_ids: string[] } };
  expect(repeat.result).toMatchObject({ state: "review_needed" });
  expect(repeat.result.possible_lead_ids).toContain(leadId);
  expect((await db.query(`select id from public.leads where org_id='${org}' and business_name='${place.name}'`)).rows).toHaveLength(1);
});

test("a missing source website remains UNKNOWN with only a conditional recommendation", async () => {
  const withoutWebsite = {
    ...place,
    id: "550e8400-e29b-41d4-a716-446655440092",
    name: "Synthetic Machine Shop",
    website_url: null,
    emails: ["shop@synthetic-machine.example"],
    phones: ["+1555010007"],
    sources: [{ dataset: "meta", record_id: "meta-9292" }],
  };
  const created = (await asUser(owner, promote(org, withoutWebsite))).rows[0] as
    { result: { state: string; lead_id: string; pending_contacts: number } };
  expect(created.result).toMatchObject({ state: "created", pending_contacts: 2 });
  const leadId = created.result.lead_id;
  expect((await asUser(owner, `select website_url,needs,status from public.leads
    where org_id='${org}' and id='${leadId}'`)).rows[0]).toMatchObject({
    website_url: null, status: "researching",
    needs: "Conditional professional website opportunity; no website listed in Overture, independent checks pending.",
  });
  expect((await asUser(owner, `select status,official_url,reason from public.lead_website_assessments
    where org_id='${org}' and lead_id='${leadId}'`)).rows[0]).toMatchObject({
    status: "UNKNOWN", official_url: null,
    reason: "Overture export has no website field; independent official-site checks are still required.",
  });
  expect((await db.query(`select id from public.email_outbox where org_id='${org}' and lead_id='${leadId}'`)).rows).toEqual([]);
});
