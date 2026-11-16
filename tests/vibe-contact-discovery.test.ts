import { describe, expect, it, vi } from "vitest";
import { discoverAuditedOfficialContacts, discoverVibePublicContacts, discoverVibeListingContacts, VIBE_CONTACT_MAX_SERPER_CREDITS } from "../packages/server/vibe-contact-discovery.ts";
import { reconcileContactObservations, type ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";
import { SerperSearchAdapter, type SearchAdapter, type SearchHit, type ExtractedPage } from "../packages/server/research.ts";
import { auditWebsite } from "../packages/server/audit.ts";
import { storedWebsiteAudit } from "../packages/server/website-audit-result.ts";

const lead = "00000000-0000-4000-8000-000000000021";
const observed_at = "2026-10-22T00:00:00.000Z";
class MockSearch implements SearchAdapter {
  searched = 0;
  extracted: string[] = [];
  constructor(private hits: SearchHit[], private pages: ExtractedPage[]) {}
  async search() { this.searched++; return this.hits; }
  async extract(urls: string[]) { this.extracted = urls; return this.pages; }
}
const hit = (url: string): SearchHit => ({ title: "Contact", url, content: "", score: 1 });
const original = (value: string, provider: "serper" | "harvey"): ContactObservation => ({
  lead_id: lead, kind: "email", value, source_provider: provider,
  source_url: provider === "harvey" ? "https://www.openstreetmap.org/node/21" : "https://aster.example/",
  observed_at, evidence_excerpt: `Contact email ${value}`, confidence: 0.5,
});

describe("independent Vibe public-contact discovery", () => {
  it("reuses one approved pinned-site audit for distinct sourced contacts without search credits", () => {
    const input = { lead_id: lead, business_name: "Aster Jewellery",
      official_url: "https://aster.example/", audited_url: "https://aster.example/",
      observed_at, country: "USA",
      page_text: "Aster Jewellery offers custom pieces. Contact hello@aster.example or sales@aster.example. Aster Jewellery business@gmail.com. Phone: +1555010009. Unrelated: someone@elsewhere.example." };
    const found = discoverAuditedOfficialContacts(input);
    expect(found.map((item) => item.value)).toEqual([
      "hello@aster.example", "sales@aster.example", "business@gmail.com", "+1555010009",
    ]);
    expect(found.every((item) => item.source_url === input.official_url &&
      item.source_provider === "official_website")).toBe(true);
    expect(discoverAuditedOfficialContacts({ ...input,
      audited_url: "https://aster.example/contact" }).length).toBe(4);
    expect(discoverAuditedOfficialContacts({ ...input, audited_url: "https://other.example/" })).toEqual([]);
    expect(discoverAuditedOfficialContacts({ ...input, page_text: "Contact hello@aster.example" })).toEqual([]);
  });

  it("connects a permitted pinned website check to Vibe evidence without storing page HTML", async () => {
    const official = "https://aster.example/";
    const audit = await auditWebsite({ url: official,
      permissionReference: "Synthetic public-site research permission",
      approvedHosts: ["aster.example"] }, {
      resolve: async () => ["93.184.215.14"],
      fetchPinned: async (url) => ({ status: url.endsWith("robots.txt") ? 404 : 200,
        headers: {}, body: url.endsWith("robots.txt") ? "" :
          "<title>Aster Jewellery</title><p>Aster Jewellery contact hello@aster.example Phone: +1555010009</p>",
        remoteAddress: "93.184.215.14" }),
    });
    const contacts = discoverAuditedOfficialContacts({ lead_id: lead,
      business_name: "Aster Jewellery", official_url: official,
      audited_url: audit.url, page_text: audit.public_page_text,
      observed_at: audit.observed_at, country: "USA" });
    expect(contacts.map((item) => item.value)).toEqual(["hello@aster.example", "+1555010009"]);
    expect(JSON.stringify(storedWebsiteAudit(audit))).not.toContain("hello@aster.example");
  });
  it("extracts missing public business and Gmail addresses from official contact pages", async () => {
    const adapter = new MockSearch([hit("https://aster.example/contact"), hit("https://unrelated.example/contacts")], [
      { url: "https://aster.example/contact", raw_content: "Email us: hello@aster.example or our business Gmail asterstudio@example.com" },
    ]);
    const found = await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    expect(adapter.searched).toBe(1);
    expect(adapter.extracted).toEqual(["https://aster.example/contact", "https://aster.example/"]);
    expect(found.map((item) => item.value)).toEqual(["hello@aster.example", "asterstudio@example.com"]);
    expect(found.every((item) => item.source_provider === "vibe" && item.source_url === "https://aster.example/contact")).toBe(true);
    expect(VIBE_CONTACT_MAX_SERPER_CREDITS).toBe(21);
  });

  it("cross-checks an existing Serper address and preserves a different Harvey and new Vibe address", async () => {
    const adapter = new MockSearch([hit("https://aster.example/contact")], [
      { url: "https://aster.example/contact", raw_content: "Email hello@aster.example; sales@aster.example" },
    ]);
    const found = await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    const points = reconcileContactObservations([original("HELLO@aster.example", "serper"),
      original("business@gmail.com", "harvey"), ...found]);
    expect(points.map((point) => point.normalized_value)).toEqual([
      "business@gmail.com", "hello@aster.example", "sales@aster.example",
    ]);
    const matched = points.find((point) => point.normalized_value === "hello@aster.example")!;
    expect(matched.observations.map((item) => item.source_provider)).toEqual(["serper", "vibe"]);
    // Serper linked the official site; Vibe extracted a second page on that
    // same publisher. Keep both observations without inventing corroboration.
    expect(matched.corroborated).toBe(false);
    expect(reconcileContactObservations([{ ...original("HELLO@aster.example", "serper"),
      source_url: "https://directory.test/aster" }, found[0]])[0].corroborated).toBe(true);
    expect(points.find((point) => point.normalized_value === "business@gmail.com")?.corroborated).toBe(false);
  });

  it("rejects off-domain evidence, unsafe URLs and missing page evidence without inventing contacts", async () => {
    const adapter = new MockSearch([hit("https://aster.example/contact"), hit("https://127.0.0.1/private")], [
      { url: "https://unrelated.example/contact", raw_content: "Email outsider@example.com" },
      { url: "https://aster.example/contact", raw_content: "Call us for details" },
    ]);
    expect(await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at)).toEqual([]);
    expect(adapter.extracted).not.toContain("https://127.0.0.1/private");
    await expect(discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "http://aster.example/" }, adapter, observed_at)).rejects.toThrow("RESEARCH_URL_NOT_PERMITTED");
  });

  it("does not call a second provider page when the contact result and homepage coincide", async () => {
    const adapter = new MockSearch([hit("https://aster.example/")], [
      { url: "https://aster.example/", raw_content: "Aster Jewellery: info@aster.example" },
    ]);
    await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    expect(adapter.extracted).toEqual(["https://aster.example/"]);
  });

  it("adds only explicitly labeled international business and WhatsApp numbers", async () => {
    const adapter = new MockSearch([hit("https://aster.example/contact")], [
      { url: "https://aster.example/contact", raw_content: "Phone: +91 98765 43210 WhatsApp: +91 98765 43211 Reference +91 98765 43212" },
    ]);
    const found = await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    expect(found.filter((item) => item.kind !== "email").map((item) => [item.kind, item.value]))
      .toEqual([["phone", "+91 98765 43210"], ["whatsapp", "+91 98765 43211"]]);
  });

  it("associates a named decision maker only when name, role and email share the source line", async () => {
    const adapter = new MockSearch([hit("https://aster.example/team")], [
      { url: "https://aster.example/team", raw_content: "Aster Jewellery\nAsha Shah - Founder - asha@aster.example\nOther email: info@aster.example" },
    ]);
    const found = await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    expect(found.find((item) => item.value === "asha@aster.example" && item.contact_name)).toMatchObject({
      contact_name: "Asha Shah", role: "Founder",
    });
    expect(found.find((item) => item.value === "info@aster.example")?.contact_name).toBeUndefined();
  });

  it("keeps a late-page email with the 21-credit Serper adapter and never requests a third scrape", async () => {
    const transport = vi.fn<typeof fetch>(async (endpoint, init) => {
      if (String(endpoint).endsWith("/search")) return Response.json({ organic: [
        { title: "Contact", link: "https://aster.example/contact" },
      ], credits: 1 });
      const body = JSON.parse(String(init?.body)) as { url: string };
      return Response.json({ text: body.url.endsWith("/contact") ?
        `Aster Jewellery ${"Contact details follow. ".repeat(1000)}Email late@aster.example` :
        "Aster Jewellery home", credits: 10 });
    });
    const adapter = new SerperSearchAdapter("mock-only", transport, VIBE_CONTACT_MAX_SERPER_CREDITS, 100000);
    const found = await discoverVibePublicContacts({ lead_id: lead, business_name: "Aster Jewellery",
      official_website_url: "https://aster.example/" }, adapter, observed_at);
    expect(found.some((item) => item.value === "late@aster.example")).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    await expect(adapter.search("site:aster.example more", 1)).rejects.toThrow("SERPER_LOCAL_CREDIT_CAP");
  });

  it("extracts a business email from its reviewed listing card without taking a neighboring business address", async () => {
    const listing = "https://directory.example/surat-jewellers";
    const adapter = new MockSearch([], [{ url: listing, raw_content:
      "Aster Jewellery · Surat · Email asterstudio@example.com\nOther Jewels · Surat · Email other@example.com" }]);
    const found = await discoverVibeListingContacts({ lead_id: lead, business_name: "Aster Jewellery",
      city: "Surat", reviewed_listing_url: listing }, adapter, observed_at);
    expect(adapter.searched).toBe(0);
    expect(adapter.extracted).toEqual([listing]);
    expect(found.map((item) => item.value)).toEqual(["asterstudio@example.com"]);
    const ambiguous = new MockSearch([], [{ url: listing, raw_content:
      "Aster Jewellery · Surat\nOther Jewels · Surat · Email other@example.com" }]);
    expect(await discoverVibeListingContacts({ lead_id: lead, business_name: "Aster Jewellery",
      city: "Surat", reviewed_listing_url: listing }, ambiguous, observed_at)).toEqual([]);
  });
});

