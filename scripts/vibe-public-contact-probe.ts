import { readFileSync } from "node:fs";
import { robotsPermits, publicTarget } from "../packages/server/audit.ts";
import { NodePinnedAuditTransport } from "../packages/server/node-audit-transport.ts";
import { extractPublicEmailCandidates, extractPublicPhoneCandidates } from "../packages/server/vibe-contact-enrichment.ts";
import { safeResearchUrl } from "../packages/server/research.ts";

type Target = { business_name: string; city: string; url: string };
const manifest = process.argv[2];
if (!manifest) throw new Error("TARGET_MANIFEST_REQUIRED");
const targets = JSON.parse(readFileSync(manifest, "utf8")) as Target[];
if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10) throw new Error("ONE_TO_TEN_TARGETS_REQUIRED");

const transport = new NodePinnedAuditTransport();
async function getPublicPage(input: string) {
  let current = safeResearchUrl(input);
  const originalHost = new URL(current).hostname.replace(/^www\./, "");
  for (let redirect = 0; redirect <= 2; redirect++) {
    const target = await publicTarget(current, (host) => transport.resolve(host));
    if (target.url.protocol !== "https:" || target.url.hostname.replace(/^www\./, "") !== originalHost)
      throw new Error("OFFICIAL_HOST_CHANGED");
    const robotsUrl = new URL("/robots.txt", target.url.origin).toString();
    const robotsTarget = await publicTarget(robotsUrl, (host) => transport.resolve(host));
    const robotsResponse = await transport.fetchPinned(robotsUrl, robotsTarget.addresses,
      { timeoutMs: 10000, maxBytes: 512000 });
    if (![200, 404, 410].includes(robotsResponse.status)) throw new Error("ROBOTS_REVIEW_REQUIRED");
    const robots = robotsResponse.status === 200 ? robotsResponse.body : "";
    if (!robotsPermits(robots, target.url.pathname + target.url.search)) throw new Error("ROBOTS_DISALLOWED");
    const response = await transport.fetchPinned(current, target.addresses,
      { timeoutMs: 10000, maxBytes: 512000 });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.location;
      if (!next) throw new Error("INVALID_REDIRECT");
      current = safeResearchUrl(new URL(next, current).toString());
      continue;
    }
    if (response.status !== 200 || !/^(text\/html|text\/plain)/i.test(response.headers["content-type"] ?? ""))
      throw new Error(`UNREADABLE_OFFICIAL_PAGE_${response.status}`);
    return { url: current, body: response.body };
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

const results = [];
for (const target of targets) {
  try {
    if (!target.business_name?.trim() || !target.city?.trim()) throw new Error("BUSINESS_IDENTITY_REQUIRED");
    const page = await getPublicPage(target.url);
    const observed_at = new Date().toISOString();
    const emailCandidates = extractPublicEmailCandidates({ source_url: page.url, page_text: page.body,
      observed_at, business_name: target.business_name, official_domain_confirmed: true });
    const domain = new URL(page.url).hostname.replace(/^www\./, "").toLowerCase();
    const businessToken = target.business_name.toLowerCase().split(/\s+/)[0];
    const emails = emailCandidates.filter((candidate) => {
      const emailDomain = candidate.value.toLowerCase().split("@")[1];
      return emailDomain === domain || emailDomain === "gmail.com" &&
        (candidate.evidence_excerpt.toLowerCase().includes(businessToken) || /contact|email|inquiry|enquiry/i.test(candidate.evidence_excerpt));
    });
    const phones = extractPublicPhoneCandidates({ source_url: page.url, page_text: page.body,
      observed_at, business_name: target.business_name, official_domain_confirmed: true });
    results.push({ business_name: target.business_name, city: target.city,
      source_url: page.url, observed_at, emails, phones, status: "sourced_public_page" });
  } catch (error) {
    results.push({ business_name: target.business_name, city: target.city, source_url: target.url,
      emails: [], phones: [], status: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
  }
}
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
