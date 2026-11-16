// Integration tests for the Campaign Command Center RPCs (migration 0078):
// batch campaign creation (one active campaign per org at a time), sequential
// activation, pause/resume semantics, organization isolation and credit caps.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createIntakePgLite } from "../helpers/intake-pglite.ts";
import type { PGlite } from "@electric-sql/pglite";

const orgA = "31240000-0000-4000-8000-0000000000aa";
const orgB = "31240000-0000-4000-8000-0000000000bb";
const orgC = "31240000-0000-4000-8000-0000000000cc";
const orgD = "31240000-0000-4000-8000-0000000000dd";
const adminA = "31240000-0000-4000-8000-0000000000a1";
const adminB = "31240000-0000-4000-8000-0000000000b1";
const adminC = "31240000-0000-4000-8000-0000000000c1";
const adminD = "31240000-0000-4000-8000-0000000000d1";
const salesA = "31240000-0000-4000-8000-0000000000a2";

let db: PGlite;
async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
  try { return await db.query(sql); }
  finally { await db.exec("reset role; reset request.jwt.claim.sub"); }
}
async function seedOrg(org: string, owner: string, cap: number) {
  await db.exec(`
    insert into auth.users(id) values('${owner}') on conflict do nothing;
    insert into public.organizations(id,name,outbound_paused,research_provider,research_monthly_credit_cap)
      values('${org}','Batch Org',true,'serper',${cap});
    insert into public.memberships(org_id,user_id,role) values('${org}','${owner}','admin');`);
}
async function seedTargeting(org: string, industries: string[], maxNew: number, enabled: boolean) {
  const ind = industries.map((i) => `'${i}'`).join(",");
  await db.exec(`
    insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,max_new_prospects,serper_discovery_enabled)
      values('${org}', array[${ind}], array['surat','pune','mumbai'], array['india'], ${maxNew}, ${enabled});`);
}
beforeAll(async () => {
  db = await createIntakePgLite();
  await db.exec("insert into auth.users(id) values('31240000-0000-4000-8000-0000000000a1'),('31240000-0000-4000-8000-0000000000b1'),('31240000-0000-4000-8000-0000000000c1'),('31240000-0000-4000-8000-0000000000d1'),('31240000-0000-4000-8000-0000000000a2') on conflict do nothing;");
  await seedOrg(orgA, adminA, 1000);
  await seedTargeting(orgA, ["jewellery", "diamond jewellery manufacturer"], 10, true);
  await db.exec(`insert into public.memberships(org_id,user_id,role) values('${orgA}','${salesA}','sales');`);
  await seedOrg(orgB, adminB, 1000);
  await seedTargeting(orgB, ["jewellery"], 10, true);
  await seedOrg(orgC, adminC, 2);
  await seedTargeting(orgC, ["jewellery"], 10, true);
  await seedOrg(orgD, adminD, 1000);
  await seedTargeting(orgD, ["jewellery"], 10, true);
}, 60000);
afterAll(async () => { await db?.close(); });

describe("create_discovery_campaign_batch", () => {
  test("creates the crossed combinations deterministically, queued first and paused for the rest", async () => {
    const res = await asUser(adminA, `select public.create_discovery_campaign_batch('${orgA}','Launch',array['jewellery','diamond jewellery manufacturer'],array['surat','pune'],'india',3,70,1) as ids`);
    const ids = (res.rows[0] as { ids: string[] }).ids;
    expect(ids).toHaveLength(4);
    const campaigns = (await db.query(`select id, target_industry, target_city, state, target_count, max_credits from public.discovery_campaigns where org_id='${orgA}' order by target_industry, target_city`)) as { rows: Array<Record<string, unknown>> };
    expect(campaigns.rows).toHaveLength(4);
    expect(campaigns.rows[0]).toMatchObject({ target_industry: "diamond jewellery manufacturer", target_city: "pune", state: "queued", target_count: 3, max_credits: 1 });
    expect(campaigns.rows.slice(1).every((c) => c.state === "paused")).toBe(true);
    const runs = (await db.query(`select campaign_id, search_mode, search_page, requested_limit from public.discovery_runs where org_id='${orgA}'`)) as { rows: Array<Record<string, unknown>> };
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ campaign_id: ids[0], search_mode: "paged_search", search_page: 1, requested_limit: 3 });
  });

  test("non-admin callers are rejected", async () => {
    await expect(asUser(salesA, `select public.create_discovery_campaign_batch('${orgA}','Nope',array['jewellery'],array['surat'],'india',1,70,1)`)).rejects.toThrow(/FORBIDDEN/);
  });

  test("a second batch is refused while a campaign is queued", async () => {
    await expect(asUser(adminA, `select public.create_discovery_campaign_batch('${orgA}','Again',array['jewellery'],array['nagpur'],'india',1,70,1)`)).rejects.toThrow(/DISCOVERY_ALREADY_PENDING/);
  });

  test("unregistered industries are rejected and no rows are written", async () => {
    const before = (await db.query(`select count(*) as n from public.discovery_campaigns where org_id='${orgA}'`)).rows[0] as { n: string };
    await expect(asUser(adminA, `select public.create_discovery_campaign_batch('${orgA}','Bad',array['retail tyres'],array['surat'],'india',1,70,1)`)).rejects.toThrow(/DISCOVERY_TARGET_NOT_APPROVED/);
    const after = (await db.query(`select count(*) as n from public.discovery_campaigns where org_id='${orgA}'`)).rows[0] as { n: string };
    expect(after.n).toBe(before.n);
  });

  test("monthly credit cap covers the whole batch at once", async () => {
    await expect(asUser(adminC, `select public.create_discovery_campaign_batch('${orgC}','Cap',array['jewellery'],array['surat','pune'],'india',1,70,2)`)).rejects.toThrow(/DISCOVERY_CREDIT_CAP/);
  });

  test("pausing the queued campaign then activating it resumes that same combination", async () => {
    const queued = (await db.query(`select id from public.discovery_campaigns where org_id='${orgA}' and state='queued'`)).rows[0] as { id: string };
    await asUser(adminA, `select public.pause_discovery_campaign('${orgA}','${queued.id}')`);
    const runs = ((await db.query(`select state from public.discovery_runs where org_id='${orgA}' and campaign_id='${queued.id}'`)) as { rows: Array<{ state: string }> }).rows;
    expect(runs.every((r) => r.state === "cancelled")).toBe(true);
    const activated = await asUser(adminA, `select public.activate_discovery_campaign('${orgA}','${queued.id}') as ok`);
    expect(activated.rows[0]).toMatchObject({ ok: true });
    const state = (await db.query(`select state from public.discovery_campaigns where id='${queued.id}'`)).rows[0] as { state: string };
    expect(state.state).toBe("queued");
    const runCount = await db.query(`select count(*) as n from public.discovery_runs where org_id='${orgA}' and campaign_id='${queued.id}' and state='queued'`);
    expect(Number((runCount.rows[0] as { n: string }).n)).toBe(1);
  });

  test("a campaign whose budget is fully reserved auto-completes on activation", async () => {
    const paused = (await db.query(`select id from public.discovery_campaigns where org_id='${orgA}' and state='paused' limit 1`)).rows[0] as { id: string };
    await db.exec(`update public.discovery_campaigns set credits_reserved=max_credits where id='${paused.id}'`);
    const res = await asUser(adminA, `select public.activate_discovery_campaign('${orgA}','${paused.id}') as ok`);
    expect(res.rows[0]).toMatchObject({ ok: false });
    const state = (await db.query(`select state from public.discovery_campaigns where id='${paused.id}'`)).rows[0] as { state: string };
    expect(state.state).toBe("completed");
  });

  test("activation from another organization cannot touch this campaign", async () => {
    const paused = (await db.query(`select id from public.discovery_campaigns where org_id='${orgA}' and state='paused' limit 1`)).rows[0] as { id: string };
    await expect(asUser(adminD, `select public.activate_discovery_campaign('${orgA}','${paused.id}')`)).rejects.toThrow(/FORBIDDEN/);
  });
});

describe("save_serper_targeting", () => {
  test("admins can replace targeting and values are normalized", async () => {
    await asUser(adminB, `select public.save_serper_targeting('${orgB}',true,array[' Jewellery ','jewellery','TExtiles'],array[' Surat  '],array['INDIA','india'],5)`);
    const t = (await db.query(`select target_industries, target_cities, target_countries, max_new_prospects, serper_discovery_enabled from public.discovery_targeting where org_id='${orgB}'`)).rows[0] as Record<string, unknown>;
    expect(t.target_industries).toEqual(["jewellery", "textiles"]);
    expect(t.target_cities).toEqual(["surat"]);
    expect(t.target_countries).toEqual(["india"]);
    expect(t.max_new_prospects).toBe(5);
    expect(t.serper_discovery_enabled).toBe(true);
  });

  test("non-admin callers are rejected", async () => {
    await expect(asUser(adminA, `select public.save_serper_targeting('${orgD}',true,array['jewellery'],array['surat'],array['india'],5)`)).rejects.toThrow(/FORBIDDEN/);
  });
});
