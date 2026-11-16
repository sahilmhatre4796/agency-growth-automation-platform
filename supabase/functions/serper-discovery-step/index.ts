import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";

const schema = z.object({ org_id: z.uuid(), campaign_id: z.uuid() }).strict();

// One explicit owner action advances at most one durable page. A closed tab
// cannot keep spending credits; the worker, SQL budget and provider flag remain
// independent gates. No cron schedule is installed by this function.
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN"), url = Deno.env.get("SUPABASE_URL"),
    anon = Deno.env.get("SUPABASE_ANON_KEY"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    secret = Deno.env.get("INTERNAL_CRON_SECRET");
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin ?? "",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", Vary: "Origin" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (!origin || !url || !anon || !serviceKey || !secret || secret.length < 32) return reply(503, { error: "DISCOVERY_NOT_CONFIGURED" });
  if (req.headers.get("Origin") !== origin) return reply(403, { error: "ORIGIN_DENIED" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Deno.env.get("ENABLE_SERPER_DISCOVERY") !== "true") return reply(503, { error: "DISCOVERY_DISABLED" });
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return reply(401, { error: "UNAUTHENTICATED" });
  let input: z.infer<typeof schema>;
  try { input = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(req, 512)))); }
  catch { return reply(422, { error: "INVALID_DISCOVERY_STEP" }); }
  try {
    const user = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } });
    const { data: identity, error: authError } = await user.auth.getUser();
    if (authError || !identity.user) return reply(401, { error: "UNAUTHENTICATED" });
    const { data: member } = await user.from("memberships").select("role").eq("org_id", input.org_id).eq("user_id", identity.user.id).maybeSingle();
    if (member?.role !== "admin") return reply(403, { error: "FORBIDDEN" });
    const { data: campaign } = await user.from("discovery_campaigns").select("id,state")
      .eq("org_id", input.org_id).eq("id", input.campaign_id).maybeSingle();
    if (!campaign) return reply(404, { error: "CAMPAIGN_NOT_FOUND" });
    if (!["queued", "running"].includes(campaign.state)) return reply(409, { error: "CAMPAIGN_NOT_RUNNING" });
    const response = await fetch(`${url}/functions/v1/serper-discovery-jobs`, {
      method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey,
        "Content-Type": "application/json", "X-Cron-Signature": secret },
      body: JSON.stringify(input), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) return reply(503, { error: "DISCOVERY_WORKER_UNAVAILABLE" });
    const result = z.object({ processed: z.number().int().min(0).max(1), completed: z.number().int().min(0).max(1),
      failed: z.number().int().min(0).max(1) }).parse(await response.json());
    return reply(200, result);
  } catch { return reply(503, { error: "DISCOVERY_STEP_UNAVAILABLE" }); }
});
