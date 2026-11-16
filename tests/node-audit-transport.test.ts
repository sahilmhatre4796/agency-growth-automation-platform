import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { expect, test, vi } from "vitest";
import { auditWebsite } from "../packages/server/audit";
import { NodePinnedAuditTransport, pinnedRequestOptions } from "../packages/server/node-audit-transport";

const publicIp = "93.184.215.14";

function fakeRequest(responses: { status: number; body: string; remote?: string; headers?: Record<string, string> }[]) {
  const calls: { protocol: string; options: RequestOptions }[] = [];
  const factory = (protocol: "http:" | "https:", options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    calls.push({ protocol, options });
    const request = new EventEmitter() as ClientRequest;
    request.destroy = vi.fn(() => request);
    request.end = vi.fn(() => {
      queueMicrotask(() => {
        const fixture = responses.shift();
        if (!fixture) { request.emit("error", new Error("NO_FIXTURE")); return; }
        const response = new PassThrough();
        Object.defineProperties(response, {
          statusCode: { value: fixture.status },
          headers: { value: fixture.headers ?? {} },
          socket: { value: { remoteAddress: fixture.remote ?? publicIp } },
        });
        onResponse(response as unknown as IncomingMessage);
        response.end(fixture.body);
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };
  return { factory, calls };
}

test("pinned transport runs robots and page over vetted IP with original Host and TLS identity", async () => {
  const fake = fakeRequest([
    { status: 404, body: "" },
    { status: 200, body: '<title>Acme Studio</title><meta name="viewport" content="width=device-width">' },
  ]);
  const transport = new NodePinnedAuditTransport(fake.factory, 0);
  transport.resolve = async () => [publicIp];
  const audit = await auditWebsite({ url: "https://example.org/", approvedHosts: ["example.org"], permissionReference: "synthetic-permission" }, transport);
  expect(audit.objective.httpStatus).toBe(200);
  expect(audit.objective.title).toBe("Acme Studio");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0].options.path).toBe("/robots.txt");
  expect(fake.calls[1].options.path).toBe("/");
  for (const call of fake.calls) {
    expect(call.protocol).toBe("https:");
    expect(call.options.hostname).toBe(publicIp);
    expect(call.options.servername).toBe("example.org");
    expect(call.options.headers).toMatchObject({ Host: "example.org", "Accept-Encoding": "identity" });
    expect(call.options.rejectUnauthorized).toBe(true);
    expect(call.options.agent).toBe(false);
  }
});

test("transport blocks mismatched remote address, compressed content and byte overflow", async () => {
  for (const fixture of [
    { status: 200, body: "ok", remote: "127.0.0.1" },
    { status: 200, body: "ok", headers: { "content-encoding": "gzip" } },
    { status: 200, body: "ééé" },
  ]) {
    const fake = fakeRequest([fixture]);
    await expect(new NodePinnedAuditTransport(fake.factory, 0).fetchPinned("https://example.org/", [publicIp], { timeoutMs: 1000, maxBytes: 4 }))
      .rejects.toThrow(fixture.remote ? "DNS_REBINDING_BLOCKED" : fixture.headers ? "UNSUPPORTED_CONTENT_ENCODING" : "RESPONSE_TOO_LARGE");
  }
  const fake = fakeRequest([]);
  await expect(new NodePinnedAuditTransport(fake.factory, 0).fetchPinned("https://example.org/", ["127.0.0.1"], { timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow("PRIVATE_TARGET");
  expect(fake.calls).toHaveLength(0);
  expect(() => pinnedRequestOptions(new URL("https://example.org"), "127.0.0.1", 1000)).toThrow("PRIVATE_TARGET");
});
