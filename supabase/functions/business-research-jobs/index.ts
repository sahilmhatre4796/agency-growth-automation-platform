import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { SerperSearchAdapter, TavilySearchAdapter, researchBusiness, SERPER_MAX_CREDITS_PER_REPORT } from "../../../packages/server/research.ts";

async function authorized(req: Request, secret: string) {
  const values = await Promise.all([secret, req.headers.get("X-Cron-Signature") ?? ""].map((value) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
Deno.serve(async (req: Request) => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  const provider = Deno.env.get("RESEARCH_PROVIDER") ?? "serper";
  if (!(["serper", "tavily"] as string[]).includes(provider)) return reply(503, { error: "RESEARCH_PROVIDER_INVALID" });
  if (Deno.env.get(provider === "serper" ? "ENABLE_SERPER_RESEARCH" : "ENABLE_TAVILY_RESEARCH") !== "true")
    return reply(503, { error: "RESEARCH_DISABLED" });
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "", key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const providerKey = Deno.env.get(provider === "serper" ? "SERPER_API_KEY" : "TAVILY_API_KEY") ?? "";
  if (secret.length < 32 || !key || !url || !providerKey || providerKey === "your_key_here") return reply(503, { error: "RESEARCH_NOT_CONFIGURED" });
  if (!(await authorized(req, secret))) return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const leased = await client.rpc("lease_business_research_jobs", { p_limit: 2, p_provider: provider });
  if (leased.error) return reply(503, { error: "RESEARCH_QUEUE_UNAVAILABLE" });
  const jobs = z.array(z.object({ id: z.uuid(), lease_token: z.uuid(), source_snapshot: z.object({
    name: z.string(), website_url: z.string().nullable(), industry: z.string().nullable(), market: z.string().nullable(),
  }) })).parse(leased.data);
  let completed = 0, failed = 0;
  for (const job of jobs) {
    try {
      const reservation = await client.rpc("reserve_research_credits", {
        p_job: job.id, p_token: job.lease_token, p_credits: provider === "serper" ? SERPER_MAX_CREDITS_PER_REPORT : 4,
      });
      if (reservation.error || !reservation.data) throw new Error("RESEARCH_CREDIT_CAP");
      const adapter = provider === "serper" ? new SerperSearchAdapter(providerKey) : new TavilySearchAdapter(providerKey);
      const report = await researchBusiness({
        name: job.source_snapshot.name, websiteUrl: job.source_snapshot.website_url,
        industry: job.source_snapshot.industry, market: job.source_snapshot.market,
      }, adapter);
      const saved = await client.rpc("finish_business_research_job", { p_job: job.id, p_token: job.lease_token, p_report: report });
      if (saved.error) throw new Error("RESEARCH_PERSIST_FAILED");
      completed++;
    } catch (cause) {
      const code = cause instanceof Error ? cause.message.slice(0, 80) : "RESEARCH_UNAVAILABLE";
      const failure = await client.rpc("fail_business_research_job", { p_job: job.id, p_token: job.lease_token, p_code: code });
      if (failure.error) return reply(503, { error: "RESEARCH_FAILURE_PERSIST_FAILED" });
      failed++;
    }
  }
  return reply(200, { processed: jobs.length, completed, failed });
});
