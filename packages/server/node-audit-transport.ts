import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isPublicAddress, publicTarget, type AuditResponse, type PinnedAuditTransport } from "./audit.ts";

type RequestFactory = (
  protocol: "http:" | "https:",
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const defaultRequest: RequestFactory = (protocol, options, onResponse) =>
  (protocol === "https:" ? httpsRequest : httpRequest)(options, onResponse);

// Connect to a vetted IP directly. The original hostname remains the HTTP Host
// and TLS servername, so certificate validation is still against the real site.
export function pinnedRequestOptions(url: URL, approvedAddress: string, timeoutMs: number): RequestOptions {
  if (!isIP(approvedAddress) || !isPublicAddress(approvedAddress))
    throw new Error("PRIVATE_TARGET");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("INVALID_AUDIT_LIMIT");
  return {
    protocol: url.protocol,
    hostname: approvedAddress,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    agent: false,
    servername: url.hostname.replace(/^\[|\]$/g, ""),
    rejectUnauthorized: true,
    maxHeaderSize: 16384,
    timeout: timeoutMs,
    headers: {
      Host: url.host,
      "User-Agent": "ChainCraftAudit/1.0 (+public-metadata-only)",
      Accept: "text/html,text/plain;q=0.8",
      "Accept-Encoding": "identity",
    },
  };
}

export class NodePinnedAuditTransport implements PinnedAuditTransport {
  private readonly nextHostSlot = new Map<string, number>();
  private readonly requestFactory: RequestFactory;
  private readonly minimumHostIntervalMs: number;

  constructor(
    requestFactory: RequestFactory = defaultRequest,
    minimumHostIntervalMs = 1000,
  ) {
    this.requestFactory = requestFactory;
    this.minimumHostIntervalMs = minimumHostIntervalMs;
  }

  async resolve(hostname: string): Promise<string[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(addresses.map((item) => item.address))];
  }

  async fetchPinned(
    input: string,
    approvedAddresses: string[],
    limits: { timeoutMs: number; maxBytes: number },
  ): Promise<AuditResponse> {
    const target = await publicTarget(input, async () => approvedAddresses);
    if (!approvedAddresses.length || approvedAddresses.some((address) => !isIP(address) || !isPublicAddress(address)))
      throw new Error("PRIVATE_TARGET");
    if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 512000)
      throw new Error("INVALID_AUDIT_LIMIT");
    const address = target.addresses[0];
    if (!approvedAddresses.includes(address)) throw new Error("DNS_PIN_MISMATCH");
    const options = pinnedRequestOptions(target.url, address, limits.timeoutMs);

    if (!Number.isInteger(this.minimumHostIntervalMs) || this.minimumHostIntervalMs < 0)
      throw new Error("INVALID_AUDIT_LIMIT");
    const now = Date.now();
    const slot = Math.max(now, this.nextHostSlot.get(target.url.hostname) ?? now);
    this.nextHostSlot.set(target.url.hostname, slot + this.minimumHostIntervalMs);
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));

    return new Promise<AuditResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error, request: ClientRequest) => {
        if (settled) return;
        settled = true;
        request.destroy(error);
        reject(error);
      };
      const request = this.requestFactory(target.url.protocol as "http:" | "https:", options, (response) => {
        const remoteAddress = response.socket?.remoteAddress ?? "";
        if (remoteAddress !== address || !isPublicAddress(remoteAddress)) {
          fail(new Error("DNS_REBINDING_BLOCKED"), request);
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          fail(new Error("UNSUPPORTED_CONTENT_ENCODING"), request);
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > limits.maxBytes) {
          fail(new Error("RESPONSE_TOO_LARGE"), request);
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.maxBytes) fail(new Error("RESPONSE_TOO_LARGE"), request);
          else chunks.push(chunk);
        });
        response.on("error", (error: Error) => fail(error, request));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (typeof value === "string") headers[key] = value;
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8"), remoteAddress });
        });
      });
      request.on("timeout", () => fail(new Error("AUDIT_TIMEOUT"), request));
      request.on("error", (error) => {
        if (!settled) { settled = true; reject(error); }
      });
      request.end();
    });
  }
}
