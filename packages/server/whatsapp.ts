import { z } from "zod";
import {
  verifyWhatsAppSignature,
  whatsappEligibility,
} from "./integrations.ts";
const message = z.object({
  id: z.string().max(200),
  from: z.string().regex(/^\d{8,15}$/),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string().max(10000) }).optional(),
});
const webhook = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }),
            messages: z.array(message).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});
export interface WhatsAppInbox {
  acceptEvent(event: {
    eventId: string;
    phoneNumberId: string;
    from: string;
    at: string;
    body: string | null;
  }): Promise<"created" | "duplicate">;
}
export async function processWhatsAppWebhook(
  input: {
    raw: Uint8Array;
    signature: string;
    appSecret: string;
    expectedPhoneNumberId: string;
  },
  inbox: WhatsAppInbox,
) {
  if (input.raw.length > 1_000_000) throw new Error("PAYLOAD_TOO_LARGE");
  if (
    !(await verifyWhatsAppSignature(
      input.raw,
      input.signature,
      input.appSecret,
    ))
  )
    throw new Error("WEBHOOK_SIGNATURE_INVALID");
  const data = webhook.parse(JSON.parse(new TextDecoder().decode(input.raw)));
  let created = 0,
    duplicates = 0;
  for (const entry of data.entry)
    for (const change of entry.changes) {
      if (change.value.metadata.phone_number_id !== input.expectedPhoneNumberId)
        throw new Error("WEBHOOK_ACCOUNT_MISMATCH");
      for (const message of change.value.messages ?? []) {
        const result = await inbox.acceptEvent({
          eventId: message.id,
          phoneNumberId: input.expectedPhoneNumberId,
          from: message.from,
          at: new Date(Number(message.timestamp) * 1000).toISOString(),
          body: message.type === "text" ? (message.text?.body ?? null) : null,
        });
        if (result === "created") created++;
        else duplicates++;
      }
    }
  return { created, duplicates };
}
export class WhatsAppAdapter {
  constructor(
    private config: {
      accessToken: string;
      phoneNumberId: string;
      graphVersion: string;
      enabled: boolean;
    },
    private transport: typeof fetch = fetch,
  ) {}
  async send(input: {
    to: string;
    text: string;
    template?: { name: string; language: string; approved: boolean };
    optedIn: boolean;
    optedOut: boolean;
    lastInboundAt: number | null;
    approved: boolean;
  }) {
    if (!this.config.enabled || !input.approved)
      throw new Error("LIVE_WHATSAPP_DISABLED");
    if (
      !/^\d{8,15}$/.test(input.to) ||
      !/^v\d+\.\d+$/.test(this.config.graphVersion) ||
      !/^\d+$/.test(this.config.phoneNumberId) ||
      !input.text ||
      input.text.length > 3000
    )
      throw new Error("INVALID_WHATSAPP_INPUT");
    if (
      !whatsappEligibility({
        ...input,
        now: Date.now(),
        templateApproved: input.template?.approved ?? false,
      })
    )
      throw new Error("WHATSAPP_INELIGIBLE");
    const payload = input.template
      ? {
          type: "template",
          template: {
            name: input.template.name,
            language: { code: input.template.language },
          },
        }
      : { type: "text", text: { body: input.text } };
    if (input.template && !input.template.approved)
      throw new Error("TEMPLATE_NOT_APPROVED");
    const response = await this.transport(
      `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.to,
          ...payload,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "WHATSAPP_RATE_LIMITED"
          : "WHATSAPP_PROVIDER_FAILED",
      );
    return z
      .object({ messages: z.array(z.object({ id: z.string() })).min(1) })
      .parse(await response.json()).messages[0].id;
  }
}
