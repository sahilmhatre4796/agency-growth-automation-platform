import { expect, test } from "vitest";
import { boundedBody } from "../packages/server/requests";
test("bodies remain bounded even when content length is absent or dishonest", async () => {
  await expect(
    boundedBody(
      new Request("https://example.org", {
        method: "POST",
        body: "x".repeat(20),
      }),
      10,
    ),
  ).rejects.toThrow("PAYLOAD_TOO_LARGE");
  await expect(
    boundedBody(
      new Request("https://example.org", {
        method: "POST",
        body: "x".repeat(20),
        headers: { "Content-Length": "1" },
      }),
      10,
    ),
  ).rejects.toThrow("PAYLOAD_TOO_LARGE");
  expect(
    new TextDecoder().decode(
      await boundedBody(
        new Request("https://example.org", { method: "POST", body: "fixture" }),
        10,
      ),
    ),
  ).toBe("fixture");
});
