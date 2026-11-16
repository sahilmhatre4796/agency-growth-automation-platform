import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { z } from "npm:zod@4.6.7";
import { decryptToken, encryptToken } from "../../../packages/server/integrations.ts";
import { GoogleAPI, GoogleAPIError, refreshGoogleToken } from "../../../packages/server/google.ts";

// Supabase's generic RPC type cannot infer functions from the migration-generated table-only types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = ReturnType<typeof createClient<any>>;
const hex = (bytes: number[] | Uint8Array) =>
  "\\x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Array.from(value.replace(/^\\x/, "").match(/../g) ?? [], (v) => parseInt(v, 16));

export async function loadGmailAccount(client: Client, connectionId: string) {
  const encryption = Deno.env.get("TOKEN_ENCRYPTION_KEY") ?? "";
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
  if (!encryption || !clientId || !clientSecret) throw new Error("GOOGLE_SECRETS_UNAVAILABLE");
  const keyBytes = Uint8Array.from(atob(encryption), (c) => c.charCodeAt(0));
  if (keyBytes.length !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const { data, error } = await client.rpc("get_gmail_oauth_secret", { p_connection: connectionId });
  if (error) throw new Error("OAUTH_SECRET_UNAVAILABLE");
  const record = z.array(z.object({
    org_id: z.uuid(), account: z.email(), ciphertext: z.string(), iv: z.string(), expires_at: z.string(),
  })).length(1).parse(data)[0];
  const tokens = z.object({
    access_token: z.string(), refresh_token: z.string(), expires_in: z.number().optional(),
    token_type: z.literal("Bearer"), scope: z.string(),
  }).parse(JSON.parse(await decryptToken({
    iv: unhex(record.iv), ciphertext: unhex(record.ciphertext),
  }, key, record.org_id)));
  let accessToken = tokens.access_token;
  if (Date.parse(record.expires_at) < Date.now() + 60000) {
    try {
      const refreshed = await refreshGoogleToken({
        refreshToken: tokens.refresh_token, clientId, clientSecret,
      });
      accessToken = refreshed.access_token;
      const sealed = await encryptToken(JSON.stringify({
        ...tokens, access_token: accessToken, expires_in: refreshed.expires_in,
        scope: refreshed.scope ?? tokens.scope,
      }), key, record.org_id);
      const { error: saveError } = await client.rpc("update_gmail_oauth_secret", {
        p_connection: connectionId,
        p_ciphertext: hex(sealed.ciphertext), p_iv: hex(sealed.iv),
        p_expires: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      });
      if (saveError) throw new Error("TOKEN_REFRESH_SAVE_FAILED");
    } catch (error) {
      if (error instanceof GoogleAPIError && error.code === "GOOGLE_REVOKED") {
        await client.rpc("mark_gmail_account_error", {
          p_connection: connectionId, p_code: "GOOGLE_REVOKED", p_revoked: true,
        });
      }
      throw error;
    }
  }
  return { api: new GoogleAPI(accessToken), account: record.account, orgId: record.org_id };
}
