// Real org-scan filter test for the batch worker. The actual processBatch code
// runs against a real supabase-js client whose HTTP layer is intercepted: each
// captured request URL is translated back to SQL and executed against real
// PGlite rows, so filters are evaluated by Postgres, never ignored. PostgREST
// itself cannot run locally (no Docker/binary) — the HTTP transport is the one
// substituted layer; an unsupported filter token fails the test loudly.
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, expect, test } from "vitest";
import { createIntakePgLite } from "./helpers/intake-pglite.ts";
import { createBatchWorker } from "../scripts/intake-handoff-batch-worker.ts";
import type { PGlite } from "@electric-sql/pglite";

let db: PGlite;
let envBackup: Record<string, string | undefined> = {};
const ids = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
// One org per scan outcome; each needs its own lead (composite FK).
const readyOrg = ids("41"), readyLead = ids("51");        // pending, retry null     → include
const retryOrg = ids("42"), retryLead = ids("52");        // pending, retry past      → include
const futureOrg = ids("43"), futureLead = ids("53");      // pending, retry future    → exclude
const orphanOrg = ids("44"), orphanLead = ids("54");      // claimed, lease expired   → include
const activeOrg = ids("45"), activeLead = ids("55");      // claimed, lease active    → exclude
const doneOrg = ids("46"), doneLead = ids("56");          // completed                → exclude
const failedOrg = ids("47"), failedLead = ids("57");      // failed, retry future     → exclude

const executedSql: string[] = [];
const claimedOrgs: string[] = [];

// Translate the captured PostgREST query params back to SQL. Any operator the
// worker's scan does not use throws, so a query-shape change fails this test.
const translate = (params: URLSearchParams): string => {
  const select = params.get("select") ?? "*";
  const clauses: string[] = [];
  for (const [key, raw] of params) {
    if (key === "select") continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot), value = raw.slice(dot + 1);
    if (op === "eq") clauses.push(`${key} = '${value}'`);
    else if (op === "is" && value === "null") clauses.push(`${key} is null`);
    else if (op === "lte") clauses.push(`${key} <= '${value}'`);
    else if (op === "lt") clauses.push(`${key} < '${value}'`);
    else throw new Error(`UNSUPPORTED_SCAN_FILTER ${key}=${raw}`);
  }
  return `select ${select} from public.lead_intake_handoff_queue` +
    (clauses.length ? ` where ${clauses.join(" and ")}` : "");
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// PGlite is single-connection: serialize the worker's three concurrent scan
// GETs (PostgREST would handle this concurrency in production).
let pgChain: Promise<unknown> = Promise.resolve();
const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = pgChain.then(fn, fn);
  pgChain = next.catch(() => undefined);
  return next;
};

const interceptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  // supabase-js prefixes all paths with /rest/v1 (PostgREST base path).
  const path = url.pathname.replace(/^\/rest\/v1/, "");
  if (method === "GET" && path === "/lead_intake_handoff_queue") {
    const sql = translate(url.searchParams);
    executedSql.push(sql);
    return json((await serialize(() => db.query(sql))).rows);
  }
  if (method === "POST" && path.startsWith("/rpc/")) {
    const name = path.slice("/rpc/".length);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (name === "claim_intake_handoff_queue_rows") claimedOrgs.push(body.p_org_id);
    return json([]); // reclaim/claim RPCs return no rows; only the scan is under test
  }
  if (method === "PATCH") return json([]); // failed→pending reset is not under test
  throw new Error(`UNEXPECTED_SCAN_REQUEST ${method} ${url.pathname}`);
}) as typeof fetch;

beforeAll(async () => {
  // Worker construction gate (same env contract as the real cron job).
  envBackup = { ...process.env };
  process.env.ENABLE_INTAKE_HANDOFF_BATCH = "true";
  process.env.SUPABASE_URL = "http://pgrest.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";
  db = await createIntakePgLite();
  const pairs = [
    [readyOrg, readyLead], [retryOrg, retryLead], [futureOrg, futureLead],
    [orphanOrg, orphanLead], [activeOrg, activeLead], [doneOrg, doneLead], [failedOrg, failedLead],
  ];
  await db.query(
    `insert into public.organizations(id,name,research_provider,research_monthly_credit_cap)
     select o, o, 'serper', 100 from unnest($1::uuid[]) as o`,
    [pairs.map(([o]) => o)]);
  await db.query(
    `insert into public.leads(id,org_id,business_name,source_type)
     select l, o, 'Scan Business', 'serper' from unnest($2::uuid[], $1::uuid[]) as t(l, o)`,
    [pairs.map(([o]) => o), pairs.map(([, l]) => l)]);
  await db.query(
    `insert into public.lead_intake_handoff_queue(org_id,lead_id,state,next_retry_at,lease_until) values
     ($1,$2,'pending',null,null),
     ($3,$4,'pending',now() - interval '1 minute',null),
     ($5,$6,'pending',now() + interval '1 hour',null),
     ($7,$8,'claimed',null,now() - interval '1 minute'),
     ($9,$10,'claimed',null,now() + interval '1 hour'),
     ($11,$12,'completed',null,null),
     ($13,$14,'failed',now() + interval '1 hour',null)`,
    [readyOrg, readyLead, retryOrg, retryLead, futureOrg, futureLead, orphanOrg, orphanLead,
      activeOrg, activeLead, doneOrg, doneLead, failedOrg, failedLead]);
});

afterAll(async () => {
  process.env = envBackup;
  await db.close();
});

test("worker org scan discovers only ready-pending, retryable-pending and expired-claimed orgs", async () => {
  const client = createClient("http://pgrest.local", "service-key-for-tests", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: interceptFetch },
  });
  const { processBatch } = createBatchWorker(client);
  await processBatch();

  // Three flat typed queries ran (pending-ready, pending-retryable, claimed-expired).
  expect(executedSql).toHaveLength(3);
  const allSql = executedSql.join("\n");
  expect(allSql).toContain("next_retry_at is null");
  expect(allSql).toContain("next_retry_at <=");   // lte emits <= against the captured timestamp
  expect(allSql).toContain("lease_until <");
  // Real Postgres filtering: only the three in-scope orgs reach the claim calls.
  expect(new Set(claimedOrgs)).toEqual(new Set([readyOrg, retryOrg, orphanOrg]));
});
