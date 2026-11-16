import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { boundedBody } from "../../../packages/server/requests.ts";
import {
  base64url,
  googleAuthorization,
  encryptToken,
  decryptToken,
} from "../../../packages/server/integrations.ts";
import {
  exchangeGoogleCode,
  GoogleAPI,
} from "../../../packages/server/google.ts";
const hex = (bytes: number[] | Uint8Array) =>
  "\\x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Array.from(value.replace(/^\\x/, "").match(/../g) ?? [], (v) =>
    parseInt(v, 16),
  );
async function stateHash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
Deno.serve(async (req: Request) => {
  const origin = Deno.env.get("ALLOWED_ORIGIN"),
    url = Deno.env.get("SUPABASE_URL"),
    anon = Deno.env.get("SUPABASE_ANON_KEY"),
    serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI"),
    encryption = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin ?? "",
    Vary: "Origin",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const reply = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers });
  if (
    Deno.env.get("GOOGLE_SANDBOX_ONLY") !== "true" ||
    !origin ||
    !url ||
    !anon ||
    !serviceKey ||
    !clientId ||
    !clientSecret ||
    !redirect ||
    !encryption
  )
    return reply(503, { error: "GOOGLE_NOT_CONFIGURED" });
  if (req.method === "OPTIONS") {
    if (req.headers.get("Origin") !== origin)
      return reply(403, { error: "ORIGIN_DENIED" });
    return new Response(null, { status: 204, headers });
  }
  try {
    const rawKey = Uint8Array.from(atob(encryption), (c) => c.charCodeAt(0));
    if (rawKey.length !== 32)
      return reply(503, { error: "ENCRYPTION_NOT_CONFIGURED" });
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const service = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    if (req.method === "POST") {
      if (req.headers.get("Origin") !== origin)
        return reply(403, { error: "ORIGIN_DENIED" });
      const token = req.headers.get("Authorization");
      if (!token?.startsWith("Bearer "))
        return reply(401, { error: "UNAUTHENTICATED" });
      const userClient = createClient(url, anon, {
        global: { headers: { Authorization: token } },
        auth: { persistSession: false },
      });
      const { data: identity, error } = await userClient.auth.getUser();
      if (error || !identity.user)
        return reply(401, { error: "UNAUTHENTICATED" });
      const body = new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBody(req, 2048),
      );
      if (body.length > 2048) return reply(413, { error: "PAYLOAD_TOO_LARGE" });
      const input = z
        .object({
          org_id: z.uuid(),
          profile: z.enum(["mail", "calendar"]),
          reconnect_connection_id: z.uuid().optional(),
        })
        .strict()
        .parse(JSON.parse(body));
      if (input.reconnect_connection_id && input.profile !== "mail")
        return reply(422, { error: "INVALID_RECONNECT_PROFILE" });
      const { data: membership, error: membershipError } = await userClient
        .from("memberships").select("role")
        .eq("org_id", input.org_id).eq("user_id", identity.user.id).maybeSingle();
      if (membershipError || membership?.role !== "admin")
        return reply(403, { error: "FORBIDDEN" });
      let loginHint: string | undefined;
      if (input.reconnect_connection_id) {
        const { data: target, error: targetError } = await service
          .from("external_connections")
          .select("provider_account_id")
          .eq("id", input.reconnect_connection_id)
          .eq("org_id", input.org_id)
          .eq("provider", "gmail")
          .maybeSingle();
        if (targetError || !target)
          return reply(404, { error: "RECONNECT_ACCOUNT_NOT_FOUND" });
        loginHint = target.provider_account_id;
      } else if (input.profile === "mail") {
        const { count, error: capacityError } = await service
          .from("external_connections")
          .select("id", { count: "exact", head: true })
          .eq("org_id", input.org_id)
          .eq("provider", "gmail")
          .eq("state", "connected");
        if (capacityError) return reply(503, { error: "CAPACITY_UNAVAILABLE" });
        if ((count ?? 0) >= 10)
          return reply(409, { error: "GMAIL_CAPACITY_REACHED" });
      }
      const state = base64url(crypto.getRandomValues(new Uint8Array(32))),
        verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
      const encrypted = await encryptToken(verifier, cryptoKey, input.org_id);
      const { error: saveError } = await service.rpc(input.reconnect_connection_id
        ? "store_oauth_state_for_connection"
        : "store_oauth_state", {
        p_hash: await stateHash(state),
        p_org: input.org_id,
        p_user: identity.user.id,
        p_profile: input.profile,
        p_ciphertext: hex(encrypted.ciphertext),
        p_iv: hex(encrypted.iv),
        p_redirect: redirect,
        ...(input.reconnect_connection_id
          ? { p_connection: input.reconnect_connection_id }
          : {}),
      });
      if (saveError) return reply(403, { error: "OAUTH_START_BLOCKED" });
      return reply(200, {
        authorization_url: await googleAuthorization({
          clientId,
          redirectUri: redirect,
          state,
          verifier,
          profile: input.profile,
          loginHint,
        }),
      });
    }
    if (req.method !== "GET")
      return reply(405, { error: "METHOD_NOT_ALLOWED" });
    const callback = new URL(req.url),
      expected = new URL(redirect);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname
    )
      return reply(400, { error: "REDIRECT_MISMATCH" });
    const state = callback.searchParams.get("state"),
      code = callback.searchParams.get("code");
    if (!state || !code || state.length > 200 || code.length > 2048)
      return reply(400, { error: "OAUTH_CALLBACK_INVALID" });
    const { data: states, error } = await service.rpc("consume_oauth_state", {
      p_hash: await stateHash(state),
    });
    if (error || states?.length !== 1)
      return reply(400, { error: "OAUTH_STATE_REJECTED" });
    const saved = states[0];
    if (saved.redirect_uri !== redirect)
      return reply(400, { error: "REDIRECT_MISMATCH" });
    const verifier = await decryptToken(
      {
        iv: unhex(saved.verifier_iv),
        ciphertext: unhex(saved.verifier_ciphertext),
      },
      cryptoKey,
      saved.org_id,
    );
    const tokens = await exchangeGoogleCode({
      code,
      verifier,
      redirectUri: redirect,
      clientId,
      clientSecret,
    });
    let account: string;
    if (saved.profile === "mail") {
      const profile = z
        .object({ emailAddress: z.email() })
        .parse(
          await new GoogleAPI(tokens.access_token).request(
            "gmail/v1/users/me/profile",
          ),
        );
      account = profile.emailAddress;
    } else {
      const api = new GoogleAPI(tokens.access_token);
      const profile = z
        .object({ email: z.email() })
        .parse(await api.request("oauth2/v3/userinfo"));
      await api.request("calendar/v3/freeBusy", {
        method: "POST",
        body: JSON.stringify({
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 3600000).toISOString(),
          items: [{ id: "primary" }],
        }),
      });
      account = profile.email;
    }
    const allowedEmails = (Deno.env.get("GOOGLE_ALLOWED_TEST_EMAILS") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase());
    if (!allowedEmails.includes(account.toLowerCase()))
      return reply(403, { error: "TEST_ACCOUNT_NOT_APPROVED" });
    if (saved.expected_connection_id) {
      const { data: expected, error: expectedError } = await service
        .from("external_connections")
        .select("provider_account_id")
        .eq("id", saved.expected_connection_id)
        .eq("org_id", saved.org_id)
        .eq("provider", "gmail")
        .maybeSingle();
      if (expectedError ||
          expected?.provider_account_id.toLowerCase() !== account.toLowerCase())
        return reply(403, { error: "RECONNECT_ACCOUNT_MISMATCH" });
    }
    const granted = new Set(tokens.scope.split(" "));
    if (saved.profile === "mail" &&
        (!granted.has("https://www.googleapis.com/auth/gmail.send") ||
         !granted.has("https://www.googleapis.com/auth/gmail.readonly")))
      return reply(403, { error: "GMAIL_PERMISSIONS_INCOMPLETE" });
    if (!tokens.refresh_token)
      return reply(400, { error: "REFRESH_TOKEN_REQUIRED_RECONNECT" });
    const sealed = await encryptToken(
      JSON.stringify(tokens),
      cryptoKey,
      saved.org_id,
    );
    const { error: connectionError } = await service.rpc(
      saved.expected_connection_id ? "reconnect_oauth_connection" : "save_oauth_connection",
      {
        p_org: saved.org_id,
        ...(saved.expected_connection_id
          ? { p_connection: saved.expected_connection_id }
          : { p_provider: saved.profile === "mail" ? "gmail" : "calendar" }),
        p_account: account,
        p_scopes: tokens.scope.split(" "),
        p_ciphertext: hex(sealed.ciphertext),
        p_iv: hex(sealed.iv),
        p_expires: new Date(
          Date.now() + tokens.expires_in * 1000,
        ).toISOString(),
        p_actor: saved.user_id,
      },
    );
    if (connectionError) return reply(503, { error: "CONNECTION_SAVE_FAILED" });
    return new Response(
      "Google account read verified and tokens stored encrypted. Outbound remains disabled. Return to the ChainCraft workspace.",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch {
    return reply(400, { error: "OAUTH_FAILED_NO_CHANNEL_ENABLED" });
  }
});
