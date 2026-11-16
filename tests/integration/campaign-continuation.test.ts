// Phase 44 integration tests: one-click batch arming, automatic page
// continuation, batch advancement, and the stops (budget, target, pause,
// cancel, expiry). Runs against real Postgres (PGlite) with every local
// migration applied.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createIntakePgLite } from "../helpers/intake-pglite.ts";
import type { PGlite } from "@electric-sql/pglite";

const orgA = "41240000-0000-4000-8000-0000000000aa";
const orgB = "41240000-0000-4000-8000-0000000000bb";
const adminA = "41240000-0000-4000-8000-0000000000a1";
const adminB = "41240000-0000-4000-8000-0000000000b1";

let db: PGlite;

async function asUser(user: string, sql: string) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
  try { return await db.query(sql); }
  finally { await db.exec("reset role; reset request.jwt.claim.sub"); }
}
async function asService(sql: string) {
  await db.exec("set role service_role");
  try { return await db.query(sql); }
  finally { await db.exec("reset role"); }
}
async function seedOrg(org: string, owner: string, cap: number) {
  await db.exec(`
    insert into auth.users(id) values('${owner}') on conflict do nothing;
    insert into public.organizations(id,name,outbound_paused,research_provider,research_monthly_credit_cap)
      values('${org}','Continuation Org',true,'serper',${cap});
    insert into public.memberships(org_id,user_id,role) values('${org}','${owner}','admin');`);
}
async function seedTargeting(org: string, industries: string[], maxNew: number) {
  const ind = industries.map((i) => `'${i}'`).join(",");
  await db.exec(`
    insert into public.discovery_targeting(org_id,target_industries,target_cities,target_countries,max_new_prospects,serper_discovery_enabled)
      values('${org}', array[${ind}], array['surat','pune'], array['india'], ${maxNew}, true);`);
}
async function campaignsOf(org: string) {
  const res = await db.query(
    `select id,state,auto_continue,auto_stop_reason,credits_reserved,max_credits,next_page,new_businesses_count,target_count,last_error_code,batch_position
       from public.discovery_campaigns where org_id='${org}' order by batch_position nulls last, created_at, id`);
  return (res as { rows: Array<Record<string, unknown>> }).rows;
}
async function runsOf(org: string) {
  const res = await db.query(
    `select id,campaign_id,search_page,state from public.discovery_runs
      where org_id='${org}' and campaign_id is not null order by campaign_id, search_page`);
  return (res as { rows: Array<Record<string, unknown>> }).rows;
}
async function claimAll() {
  const res = await asService(`select * from public.claim_campaign_continuation(1)`);
  return (res as { rows: Array<{ org_id: string; campaign_id: string; search_page: number }> }).rows;
}

beforeAll(async () => {
  db = await createIntakePgLite();
  await db.exec(`insert into auth.users(id) values('${adminA}'),('${adminB}') on conflict do nothing;`);
  await seedOrg(orgA, adminA, 1000);
  await seedTargeting(orgA, ["jewellery", "diamond jewellery manufacturer"], 10);
  await seedOrg(orgB, adminB, 1000);
  await seedTargeting(orgB, ["jewellery"], 10);
}, 60000);

afterAll(async () => { await db?.close(); });

describe("one-click campaign batch", () => {
  test("START arms the whole batch and the first campaign becomes claimable", async () => {
    const created = await asUser(adminA, `select public.create_discovery_campaign_batch('${orgA}','Launch',
      array['jewellery','diamond jewellery manufacturer'],array['surat','pune'],'india',3,70,5) as ids`);
    const ids = (created.rows[0] as { ids: string[] }).ids;
    expect(ids).toHaveLength(4);

    const armed = await asUser(adminA, `select public.arm_campaign_batch_continuation('${orgA}', array[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]) as ok`);
    expect((armed.rows[0] as { ok: string[] }).ok).toHaveLength(4);
    const rows = await campaignsOf(orgA);
    expect(rows).toHaveLength(4);
    const queued = rows.find((c) => c.state === "queued")!;
    const paused = rows.filter((c) => c.state === "paused");
    expect(queued.auto_continue).toBe(true);
    expect(paused.every((c) => c.auto_continue === true)).toBe(true);
    // The batch keeps the confirmed combination order, not uuid order.
    const positions = await db.query(`select id,batch_position from public.discovery_campaigns
      where org_id='${orgA}' order by batch_position`);
    expect((positions as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual(ids);
    const runs = await runsOf(orgA);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ search_page: 1, state: "queued" });

    const claims = await claimAll();
    expect(claims).toHaveLength(1);
    expect(claims[0].campaign_id).toBe(ids[0]);
    expect(claims[0].search_page).toBe(1);
  });

  test("a page can never be leased twice (no duplicate execution)", async () => {
    const first = await asService(`select * from public.lease_serper_campaign_page('${orgA}',
      (select id from public.discovery_campaigns where org_id='${orgA}' and state='queued' limit 1))`);
    expect((first as { rows: unknown[] }).rows).toHaveLength(1);
    const second = await asService(`select * from public.lease_serper_campaign_page('${orgA}',
      (select id from public.discovery_campaigns where org_id='${orgA}' and state='queued' limit 1))`);
    expect((second as { rows: unknown[] }).rows).toHaveLength(0);
    // A second claim is idempotent: it never creates a second page.
    const claims = await claimAll();
    expect(claims).toHaveLength(1);
    expect((await runsOf(orgA)).filter((r) => r.state === "queued")).toHaveLength(0);
  });

  test("arming another organization's campaign is refused", async () => {
    const rows = await campaignsOf(orgA);
    const foreign = rows[0].id as string;
    await expect(asUser(adminB, `select public.arm_campaign_batch_continuation('${orgB}', array['${foreign}']::uuid[])`))
      .rejects.toThrow(/CAMPAIGN_NOT_FOUND/);
  });

  test("a claim for another organization never returns this organization's campaign", async () => {
    const claim = await asService(`select * from public.claim_campaign_continuation(5,'${orgB}')`);
    const claims = (claim as { rows: Array<{ org_id: string }> }).rows;
    expect(claims.every((c) => c.org_id === orgB)).toBe(true);
  });
});

describe("automatic page continuation", () => {
  test("a finished page queues the next page and the campaign stays claimable", async () => {
    const rows = await campaignsOf(orgA);
    const campaign = rows.find((c) => c.state === "queued" || c.state === "running")!;
    const campaignId = campaign.id as string;
    // Exactly what finish_discovery_campaign_page does on success.
    await db.exec(`update public.discovery_runs set state='completed',observations_count=2,completed_at=now()
      where campaign_id='${campaignId}' and search_page=1`);
    await db.exec(`update public.discovery_campaigns set state='running',pages_completed=1,
      observations_count=2,new_businesses_count=2,next_page=2,credits_reserved=1 where id='${campaignId}'`);
    await db.exec(`insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,campaign_id,search_mode,search_page,next_run_at)
      values('${orgA}','serper','queued',1,'jewellery','surat','India','${campaignId}','paged_search',2,now())`);

    const runs = await runsOf(orgA);
    expect(runs.some((r) => r.search_page === 2 && r.state === "queued")).toBe(true);
    const claims = await claimAll();
    expect(claims).toHaveLength(1);
    expect(claims[0].campaign_id).toBe(campaignId);
    expect(claims[0].search_page).toBe(2);
  });

  test("a completed campaign advances the batch to the next combination", async () => {
    const rows = await campaignsOf(orgA);
    const first = rows.find((c) => c.state === "queued" || c.state === "running")!;
    // The campaign's last page finished; no page of it is left outstanding.
    await db.exec(`update public.discovery_runs set state='completed',completed_at=now()
      where campaign_id='${first.id}' and state='queued'`);
    await db.exec(`update public.discovery_campaigns set state='completed',completed_at=now(),
      new_businesses_count=target_count where id='${first.id}'`);
    const advanced = await asService(`select public.advance_campaign_batch('${orgA}','${first.id}') as next`);
    const next = (advanced.rows[0] as { next: string | null }).next;
    expect(next).toBeTruthy();
    const after = await campaignsOf(orgA);
    const activated = after.find((c) => c.id === next)!;
    expect(activated.state).toBe("queued");
    expect(activated.auto_continue).toBe(true);
    const runs = await runsOf(orgA);
    expect(runs.some((r) => r.campaign_id === next && r.state === "queued")).toBe(true);
  });

  test("a campaign that exhausted its budget is not claimed", async () => {
    const rows = await campaignsOf(orgA);
    const campaign = rows.find((c) => c.state === "queued")!;
    await db.exec(`update public.discovery_campaigns set credits_reserved=max_credits where id='${campaign.id}'`);
    const claims = await claimAll();
    expect(claims).toHaveLength(0);
  });

  test("a paused campaign stops the batch with its reason", async () => {
    const rows = await campaignsOf(orgA);
    const campaign = rows.find((c) => c.state === "queued")!;
    await db.exec(`update public.discovery_campaigns set state='paused',last_error_code='CAMPAIGN_CREDIT_LIMIT'
      where id='${campaign.id}'`);
    const advanced = await asService(`select public.advance_campaign_batch('${orgA}','${campaign.id}') as next`);
    expect((advanced.rows[0] as { next: string | null }).next).toBeNull();
    const after = await campaignsOf(orgA);
    expect(after.every((c) => c.auto_continue === false)).toBe(true);
    expect(after.some((c) => c.auto_stop_reason === "CAMPAIGN_CREDIT_LIMIT")).toBe(true);
  });
});

describe("owner controls", () => {
  test("an owner pause stops the batch and Resume re-arms it", async () => {
    const rows = await campaignsOf(orgA);
    // The first paused combination in the confirmed order (deterministic).
    const campaign = rows.filter((c) => c.state === "paused")
      .sort((a, b) => Number(a.batch_position ?? 99) - Number(b.batch_position ?? 99))[0];
    await asUser(adminA, `select public.pause_discovery_campaign('${orgA}','${campaign.id}')`);
    const paused = await campaignsOf(orgA);
    expect(paused.every((c) => c.auto_continue === false)).toBe(true);
    expect(paused.some((c) => c.auto_stop_reason === "OWNER_PAUSED")).toBe(true);

    await asUser(adminA, `select public.resume_discovery_campaign('${orgA}','${campaign.id}')`);
    const resumed = await campaignsOf(orgA);
    // The batch is armed again and the sequence continues with the next
    // combination that can still run.
    expect(resumed.some((c) => c.auto_continue === true)).toBe(true);
    expect(resumed.some((c) => c.state === "queued")).toBe(true);
  });

  test("cancelling a campaign stops the whole batch", async () => {
    const rows = await campaignsOf(orgA);
    const target = rows.filter((c) => c.state === "paused" || c.state === "queued")
      .sort((a, b) => Number(a.batch_position ?? 99) - Number(b.batch_position ?? 99))[0];
    await asUser(adminA, `select public.cancel_discovery_campaign('${orgA}','${target.id}')`);
    const after = await campaignsOf(orgA);
    expect(after.every((c) => c.auto_continue === false)).toBe(true);
    expect(after.find((c) => c.id === target.id)?.state).toBe("cancelled");
  });
});

describe("stop conditions", () => {
  test("an expired campaign lease pauses the campaign for review and stops continuation", async () => {
    // A separate organization keeps this scenario independent of the batch above.
    const created = await asUser(adminB, `select public.create_discovery_campaign_batch('${orgB}','Lease',
      array['jewellery'],array['surat'],'india',3,70,1) as ids`);
    const ids = (created.rows[0] as { ids: string[] }).ids;
    await asUser(adminB, `select public.arm_campaign_batch_continuation('${orgB}', array['${ids[0]}']::uuid[])`);
    const campaignId = ids[0];
    await db.exec(`update public.discovery_campaigns set state='running' where id='${campaignId}'`);
    await db.exec(`update public.discovery_runs set state='cancelled' where campaign_id='${campaignId}'`);
    await db.exec(`insert into public.discovery_runs(org_id,provider,state,requested_limit,target_industry,
      target_city,target_country,campaign_id,search_mode,search_page,next_run_at,lease_token,lease_until)
      values('${orgB}','serper','leased',1,'jewellery','surat','India','${campaignId}','paged_search',5,now(),
      gen_random_uuid(), now() - interval '1 minute')`);
    await asService(`select * from public.lease_serper_campaign_page('${orgB}','${campaignId}')`);
    const after = await campaignsOf(orgB);
    const paused = after.find((c) => c.id === campaignId)!;
    expect(paused.state).toBe("paused");
    expect(paused.last_error_code).toBe("LEASE_EXPIRED_REVIEW_REQUIRED");
    const claims = await asService(`select * from public.claim_campaign_continuation(1,'${orgB}')`);
    expect((claims as { rows: Array<{ campaign_id: string }> }).rows
      .some((c) => c.campaign_id === campaignId)).toBe(false);
  });

  test("an organization whose monthly allowance is exhausted is not claimed", async () => {
    await db.exec(`update public.organizations set research_monthly_credit_cap=0 where id='${orgA}'`);
    const claims = await claimAll();
    expect(claims).toHaveLength(0);
    await db.exec(`update public.organizations set research_monthly_credit_cap=1000 where id='${orgA}'`);
  });
});
