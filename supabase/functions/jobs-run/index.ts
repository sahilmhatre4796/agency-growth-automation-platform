import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { runJobs, type JobStore } from "../../../packages/server/worker.ts";
async function equalSecret(a: string, b: string) {
  const encode = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(a)),
    crypto.subtle.digest("SHA-256", encode.encode(b)),
  ]);
  const left = new Uint8Array(x),
    right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("INTERNAL_CRON_SECRET"),
    url = Deno.env.get("SUPABASE_URL"),
    key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const reply = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (!secret || secret.length < 32 || !url || !key)
    return reply(503, { error: "SCHEDULER_NOT_CONFIGURED" });
  if (!(await equalSecret(req.headers.get("X-Cron-Signature") ?? "", secret)))
    return reply(401, { error: "UNAUTHORIZED" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const store: JobStore = {
    lease: async (limit) => {
      const { data, error } = await client.rpc("lease_jobs", {
        p_limit: limit,
      });
      if (error) throw new Error("LEASE_FAILED");
      return z
        .array(
          z.object({
            id: z.uuid(),
            org_id: z.uuid(),
            kind: z.string(),
            lease_token: z.uuid(),
            policy_version: z.string(),
            payload: z.unknown(),
          }),
        )
        .parse(data);
    },
    paused: async (org) => {
      const { data, error } = await client
        .from("organizations")
        .select("outbound_paused")
        .eq("id", org)
        .single();
      if (error || !data) throw new Error("POLICY_UNAVAILABLE");
      return data.outbound_paused;
    },
    finish: async (job, state, error) => {
      const result = await client.rpc("finish_job", {
        p_id: job.id,
        p_token: job.lease_token,
        p_state: state,
        p_error: error ?? null,
      });
      if (result.error) throw new Error("FINISH_FAILED");
      return Boolean(result.data);
    },
  };
  try {
    return reply(
      200,
      await runJobs(store, {
        "notification.create": async (job) => {
          const { error } = await client.rpc("create_job_notification", {
            p_id: job.id,
            p_token: job.lease_token,
          });
          if (error) throw new Error("NOTIFICATION_FAILED");
        },
      }),
    );
  } catch {
    return reply(503, { error: "WORKER_UNAVAILABLE" });
  }
});
