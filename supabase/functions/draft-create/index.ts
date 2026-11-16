import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "zod";
import { StructuredAI } from "../../../packages/server/ai.ts";
import {
  eligibleEvidence,
  renderGroundedDraft,
  selectionSchema,
} from "../../../packages/shared/drafting.ts";
import type { Evidence } from "../../../packages/shared/crm.ts";
import { boundedBody } from "../../../packages/server/requests.ts";

const input = z
  .object({
    org_id: z.uuid(),
    lead_id: z.uuid(),
    language: z.enum(["en", "hi", "hinglish"]).default("en"),
  })
  .strict();
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin ?? "",
    Vary: "Origin",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const reply = (status: number, data: unknown, error: string | null = null) =>
    new Response(
      JSON.stringify({ data, error, request_id: crypto.randomUUID() }),
      { status, headers },
    );
  if (!origin || req.headers.get("Origin") !== origin)
    return reply(403, null, "ORIGIN_DENIED");
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, null, "METHOD_NOT_ALLOWED");
  if (Number(req.headers.get("content-length") ?? 0) > 4096)
    return reply(413, null, "PAYLOAD_TOO_LARGE");
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply(401, null, "UNAUTHENTICATED");
  const url = Deno.env.get("SUPABASE_URL")!,
    anon = Deno.env.get("SUPABASE_ANON_KEY")!,
    serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!url || !anon || !serviceKey)
    return reply(503, null, "BACKEND_NOT_CONFIGURED");
  const client = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: identity, error: authError } = await client.auth.getUser();
  if (authError || !identity.user) return reply(401, null, "UNAUTHENTICATED");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(req, 4096),
    );
    if (text.length > 4096) return reply(413, null, "PAYLOAD_TOO_LARGE");
    const parsed = input.parse(JSON.parse(text));
    const { data: member } = await client
      .from("memberships")
      .select("role")
      .eq("org_id", parsed.org_id)
      .eq("user_id", identity.user.id)
      .maybeSingle();
    if (member?.role !== "admin") return reply(403, null, "FORBIDDEN");
    const { data: lead } = await client
      .from("leads")
      .select("id")
      .eq("org_id", parsed.org_id)
      .eq("id", parsed.lead_id)
      .maybeSingle();
    if (!lead) return reply(404, null, "LEAD_NOT_FOUND");
    const service = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    const { data: budget } = await service
      .from("ai_budgets")
      .select("*")
      .eq("org_id", parsed.org_id)
      .maybeSingle();
    if (!budget?.enabled || !budget.free_tier_approved || !budget.model)
      return reply(503, null, "AI_NOT_CONFIGURED");
    const { data: contact } = await client
      .from("contacts")
      .select("id")
      .eq("org_id", parsed.org_id)
      .eq("lead_id", parsed.lead_id)
      .not("email", "is", null)
      .limit(1)
      .maybeSingle();
    if (!contact) return reply(422, null, "EMAIL_CONTACT_REQUIRED");
    const { data: rows, error: evidenceError } = await client
      .from("lead_evidence")
      .select("*")
      .eq("org_id", parsed.org_id)
      .eq("lead_id", parsed.lead_id);
    if (evidenceError) return reply(503, null, "EVIDENCE_UNAVAILABLE");
    const evidence = (rows ?? []).map((e) => ({
      ...e,
      reviewed: Boolean(e.reviewed_by),
    })) as Evidence[];
    const key =
      Deno.env.get(
        budget.provider === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY",
      ) ?? "";
    const ai = new StructuredAI(
      {
        provider: budget.provider,
        apiKey: key,
        model: budget.model,
        freeTierApproved: budget.free_tier_approved,
        maxTokens: 300,
        timeoutMs: 15000,
      },
      {
        reserve: async (tokens) => {
          const { data, error } = await service.rpc("reserve_ai_usage", {
            p_org: parsed.org_id,
            p_tokens: tokens,
          });
          if (error) throw new Error("QUOTA_EXHAUSTED");
          return String(data);
        },
        settle: async (id, usage) => {
          const { error } = await service
            .from("ai_usage")
            .update({
              input_tokens: usage.input,
              output_tokens: usage.output,
              state: usage.status,
            })
            .eq("id", id)
            .eq("org_id", parsed.org_id);
          if (error) throw new Error("USAGE_PERSIST_FAILED");
        },
      },
    );
    // Only IDs/kinds/confidence reach the model; source quotes and contact details stay local.
    const selection = await ai.generate(selectionSchema, {
      language: parsed.language,
      evidence: eligibleEvidence(evidence).map((e) => ({
        id: e.id,
        kind: e.kind,
        confidence: e.confidence,
      })),
    });
    const draft = renderGroundedDraft(evidence, {
      ...selection.data,
      language: parsed.language,
    });
    const { data: stored, error: saveError } = await client
      .from("outbound_drafts")
      .insert({
        org_id: parsed.org_id,
        lead_id: parsed.lead_id,
        contact_id: contact.id,
        channel: "email",
        subject: draft.subject,
        body: draft.body,
        evidence_ids: draft.evidence_ids_used,
        state: "needs_review",
        language: draft.language,
        prompt_version: "grounded-v1",
        model_id: selection.model,
      })
      .select("id")
      .single();
    if (saveError) return reply(503, null, "DRAFT_SAVE_FAILED");
    return reply(201, {
      draft_id: stored.id,
      review_required: true,
      live_send_enabled: false,
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return reply(422, null, "INVALID_INPUT_OR_MODEL_OUTPUT");
    const code =
      error instanceof Error &&
      [
        "RATE_LIMITED",
        "AI_NOT_CONFIGURED",
        "QUOTA_EXHAUSTED",
        "UNGROUNDED_EVIDENCE",
        "INVALID_AI_OUTPUT",
      ].includes(error.message)
        ? error.message
        : "DRAFT_GENERATION_FAILED";
    return reply(code === "RATE_LIMITED" ? 429 : 503, null, code);
  }
});
