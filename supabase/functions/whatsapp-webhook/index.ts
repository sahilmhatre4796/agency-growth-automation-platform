import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { processWhatsAppWebhook } from "../../../packages/server/whatsapp.ts";
import {
  classifyReply,
  verifyWhatsAppSignature,
} from "../../../packages/server/integrations.ts";
import { boundedBody } from "../../../packages/server/requests.ts";
Deno.serve(async (req: Request) => {
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET"),
    verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN"),
    connectionId = Deno.env.get("WHATSAPP_CONNECTION_ID"),
    hashSecret = Deno.env.get("SUPPRESSION_HMAC_SECRET");
  const url = Deno.env.get("SUPABASE_URL"),
    key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const reply = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (
    !appSecret ||
    !verifyToken ||
    !connectionId ||
    !hashSecret ||
    hashSecret.length < 32 ||
    !url ||
    !key
  )
    return reply(503, { error: "WHATSAPP_NOT_CONFIGURED" });
  if (req.method === "GET") {
    const query = new URL(req.url).searchParams;
    if (
      query.get("hub.mode") !== "subscribe" ||
      query.get("hub.verify_token") !== verifyToken
    )
      return reply(403, { error: "VERIFICATION_DENIED" });
    return new Response(query.get("hub.challenge") ?? "", { status: 200 });
  }
  if (req.method !== "POST") return reply(405, { error: "METHOD_NOT_ALLOWED" });
  if (Number(req.headers.get("content-length") ?? 0) > 1_000_000)
    return reply(413, { error: "PAYLOAD_TOO_LARGE" });
  let raw: Uint8Array;
  try {
    raw = await boundedBody(req, 1_000_000);
  } catch {
    return reply(413, { error: "PAYLOAD_TOO_LARGE_OR_TIMEOUT" });
  }
  if (raw.length > 1_000_000) return reply(413, { error: "PAYLOAD_TOO_LARGE" });
  if (
    !(await verifyWhatsAppSignature(
      raw,
      req.headers.get("X-Hub-Signature-256") ?? "",
      appSecret,
    ))
  )
    return reply(401, { error: "WEBHOOK_SIGNATURE_INVALID" });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data: connection, error } = await client
    .from("external_connections")
    .select("provider_account_id,state,verified_at")
    .eq("id", connectionId)
    .eq("provider", "whatsapp")
    .single();
  if (error || !connection?.verified_at || connection.state !== "connected")
    return reply(503, { error: "CONNECTION_NOT_VERIFIED" });
  try {
    const result = await processWhatsAppWebhook(
      {
        raw,
        signature: req.headers.get("X-Hub-Signature-256") ?? "",
        appSecret,
        expectedPhoneNumberId: connection.provider_account_id,
      },
      {
        acceptEvent: async (event) => {
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(hashSecret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const digest = await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode("+" + event.from),
          );
          const identifierHash = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          const { data, error } = await client.rpc("accept_whatsapp_inbound", {
            p_connection: connectionId,
            p_event: event.eventId,
            p_from: "+" + event.from,
            p_at: event.at,
            p_body: event.body,
            p_classification: classifyReply(event.body ?? "").label,
            p_identifier_hash: identifierHash,
          });
          if (error) throw new Error("INBOUND_PERSIST_FAILED");
          return data as "created" | "duplicate";
        },
      },
    );
    return reply(200, result);
  } catch (error) {
    return reply(
      error instanceof Error && error.message === "WEBHOOK_SIGNATURE_INVALID"
        ? 401
        : 422,
      { error: "WEBHOOK_REJECTED" },
    );
  }
});
