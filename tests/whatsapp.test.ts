import { expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  processWhatsAppWebhook,
  WhatsAppAdapter,
  type WhatsAppInbox,
} from "../packages/server/whatsapp";
test("signed duplicate inbound event creates only one logical message; tamper rejected before inbox", async () => {
  const raw = new TextEncoder().encode(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "fixture-account",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "12345" },
                messages: [
                  {
                    id: "fixture-event",
                    from: "919999999999",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Stop contacting me" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  const signature =
    "sha256=" +
    createHmac("sha256", "fixture-secret").update(raw).digest("hex");
  const seen = new Set<string>();
  const inbox: WhatsAppInbox = {
    acceptEvent: vi.fn(async (e) => {
      if (seen.has(e.eventId)) return "duplicate";
      seen.add(e.eventId);
      return "created";
    }),
  };
  const input = {
    raw,
    signature,
    appSecret: "fixture-secret",
    expectedPhoneNumberId: "12345",
  };
  expect(await processWhatsAppWebhook(input, inbox)).toEqual({
    created: 1,
    duplicates: 0,
  });
  expect(await processWhatsAppWebhook(input, inbox)).toEqual({
    created: 0,
    duplicates: 1,
  });
  await expect(
    processWhatsAppWebhook(
      { ...input, raw: new TextEncoder().encode("{}") },
      inbox,
    ),
  ).rejects.toThrow("SIGNATURE_INVALID");
  expect(inbox.acceptEvent).toHaveBeenCalledTimes(2);
  await expect(
    processWhatsAppWebhook({ ...input, expectedPhoneNumberId: "other" }, inbox),
  ).rejects.toThrow("ACCOUNT_MISMATCH");
});
test("outbound WhatsApp stays off and missing consent blocks even an approved template", async () => {
  const transport = vi.fn();
  const config = {
    accessToken: "synthetic",
    phoneNumberId: "12345",
    graphVersion: "v99.0",
    enabled: false,
  };
  const input = {
    to: "919999999999",
    text: "fixture",
    optedIn: false,
    optedOut: false,
    lastInboundAt: null,
    approved: true,
    template: { name: "fixture", language: "en", approved: true },
  };
  await expect(
    new WhatsAppAdapter(config, transport).send(input),
  ).rejects.toThrow("DISABLED");
  await expect(
    new WhatsAppAdapter({ ...config, enabled: true }, transport).send(input),
  ).rejects.toThrow("INELIGIBLE");
  expect(transport).not.toHaveBeenCalled();
});
