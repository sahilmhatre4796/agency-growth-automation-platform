export function isPublicAddress(address: string) {
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Restrict IPv6 to global-unicast 2000::/3 and exclude documentation/tunnel ranges.
  const value = address.toLowerCase();
  return (
    /^[23][0-9a-f]{3}:/.test(value) &&
    !value.startsWith("2001:db8:") &&
    !value.startsWith("2001:0:") &&
    !value.startsWith("2002:")
  );
}
export async function publicTarget(
  input: string,
  resolve: (hostname: string) => Promise<string[]>,
) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("URL_NOT_PERMITTED");
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  )
    throw new Error("PRIVATE_TARGET");
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const addresses =
    /^[0-9.]+$/.test(literal) || literal.includes(":")
      ? [literal]
      : await resolve(url.hostname);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a)))
    throw new Error("PRIVATE_TARGET");
  return { url, addresses };
}
export type AuditResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  remoteAddress: string;
};
// A real transport MUST pin the approved DNS address and preserve Host/TLS SNI.
// Generic Edge fetch cannot guarantee this; no unsafe live fallback is provided.
export interface PinnedAuditTransport {
  resolve(hostname: string): Promise<string[]>;
  fetchPinned(
    url: string,
    approvedAddresses: string[],
    limits: { timeoutMs: number; maxBytes: number },
  ): Promise<AuditResponse>;
}

// This intentionally supports a small subset. Unsupported crawl-rate rules
// and malformed access directives require owner review rather than a crawl.
export function robotsPermits(robots: string, path: string, agent = "ChainCraftAudit") {
  if (robots.length > 512000) throw new Error("ROBOTS_TOO_LARGE");
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group: (typeof groups)[number] | undefined;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) {
      if (/^(user-agent|allow|disallow|crawl-delay|request-rate)\b/i.test(line))
        throw new Error("ROBOTS_RULE_REVIEW_REQUIRED");
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "crawl-delay" || key === "request-rate")
      throw new Error("ROBOTS_RULE_REVIEW_REQUIRED");
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group?.agents.length) {
      if (value.includes("*") || value.includes("$")) throw new Error("ROBOTS_RULE_REVIEW_REQUIRED");
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  const named = groups.filter((item) => item.agents.some((name) => name !== "*" && agent.toLowerCase().includes(name)));
  const selected = named.length ? named : groups.filter((item) => item.agents.includes("*"));
  const matching = selected.flatMap((item) => item.rules).filter((rule) => rule.path && path.startsWith(rule.path));
  matching.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

export async function auditWebsite(
  input: {
    url: string;
    permissionReference: string;
    approvedHosts: string[];
  },
  transport: PinnedAuditTransport,
) {
  if (!input.permissionReference.trim())
    throw new Error("SOURCE_PERMISSION_REQUIRED");
  const robotsCache = new Map<string, string>();
  let current = input.url;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const target = await publicTarget(current, (host) =>
      transport.resolve(host),
    );
    if (!input.approvedHosts.includes(target.url.hostname))
      throw new Error("HOST_NOT_APPROVED");
    const origin = target.url.origin;
    let robots = robotsCache.get(origin);
    if (robots === undefined) {
      const robotsTarget = await publicTarget(new URL("/robots.txt", origin).toString(), (host) => transport.resolve(host));
      const robotsResponse = await transport.fetchPinned(robotsTarget.url.toString(), robotsTarget.addresses, { timeoutMs: 10000, maxBytes: 512000 });
      if (!robotsTarget.addresses.includes(robotsResponse.remoteAddress) || !isPublicAddress(robotsResponse.remoteAddress))
        throw new Error("DNS_REBINDING_BLOCKED");
      if (robotsResponse.body.length > 512000) throw new Error("ROBOTS_TOO_LARGE");
      if (robotsResponse.status === 404 || robotsResponse.status === 410) robots = "";
      else if (robotsResponse.status === 200) robots = robotsResponse.body;
      else throw new Error("ROBOTS_REVIEW_REQUIRED");
      robotsCache.set(origin, robots);
    }
    if (!robotsPermits(robots, target.url.pathname + target.url.search))
      throw new Error("ROBOTS_DISALLOWED");
    const response = await transport.fetchPinned(
      target.url.toString(),
      target.addresses,
      { timeoutMs: 10000, maxBytes: 512000 },
    );
    if (
      !target.addresses.includes(response.remoteAddress) ||
      !isPublicAddress(response.remoteAddress)
    )
      throw new Error("DNS_REBINDING_BLOCKED");
    if (response.body.length > 512000) throw new Error("RESPONSE_TOO_LARGE");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new Error("INVALID_REDIRECT");
      current = new URL(location, current).toString();
      continue;
    }
    const html = response.body;
    return {
      url: current,
      observed_at: new Date().toISOString(),
      // Used only in-process by the approved-site contact extractor. The
      // stored audit result below persists objective metadata, not page HTML.
      public_page_text: response.status >= 200 && response.status < 300 ? html.slice(0, 100000) : "",
      objective: {
        httpStatus: response.status,
        https: target.url.protocol === "https:",
        title: html.match(/<title[^>]*>([^<]{0,300})<\/title>/i)?.[1] ?? null,
        hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html),
        hasDescription: /<meta\b[^>]*name\s*=\s*["']description["']/i.test(
          html,
        ),
        hasContactPath: /href\s*=\s*["'](?:mailto:|tel:|[^"']*contact)/i.test(
          html,
        ),
      },
      subjective: [],
      limitations: [
        "Metadata signals only; no visual design judgment, measured performance or buying intent inferred.",
      ],
    };
  }
  throw new Error("TOO_MANY_REDIRECTS");
}
