import { describe, expect, it } from "vitest";
import { extractPublicBusinessEmails, normalizeContactValue, reconcileContactObservations,
  type ContactObservation } from "../packages/server/vibe-contact-enrichment.ts";
import { HarveyOsmCollector } from "../packages/server/harvey-osm.ts";

const lead = "00000000-0000-4000-8000-000000000021";
const otherLead = "00000000-0000-4000-8000-000000000022";
const observed_at = "2026-10-21T00:00:00.000Z";
function email(value: string, source_provider: ContactObservation["source_provider"], lead_id = lead): ContactObservation {
  return { lead_id, kind: "email", value, source_provider,
    source_url: source_provider === "harvey" ? "https://www.openstreetmap.org/node/21" : "https://aster.example/contact",
    observed_at, evidence_excerpt: `Public contact email: ${value}`, confidence: 0.6 };
}

describe("email-first contact reconciliation", () => {
  it("shows the same email once with both original sources, without claiming mailbox verification", () => {
    const points = reconcileContactObservations([email("Hello@aster.example", "serper"), email("hello@aster.example", "harvey")]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ normalized_value: "hello@aster.example", source_count: 2, corroborated: false });
    expect(points[0].observations.map((item) => item.source_provider)).toEqual(["serper", "harvey"]);
  });

  it("does not call two provider labels on the same URL independent corroboration", () => {
    const points = reconcileContactObservations([email("hello@aster.example", "serper"),
      email("hello@aster.example", "vibe")]);
    expect(points[0].source_count).toBe(2);
    expect(points[0].corroborated).toBe(false);
  });

  it("does not corroborate different paths or subdomains owned by one publisher", () => {
    const official = email("hello@aster.example", "official_website");
    const repeated = { ...email("hello@aster.example", "vibe"),
      source_url: "https://support.aster.example/about" };
    const sameHost = { ...repeated, source_url: "https://aster.example/about" };
    expect(reconcileContactObservations([official, repeated])[0].corroborated).toBe(false);
    expect(reconcileContactObservations([official, sameHost])[0].corroborated).toBe(false);
    expect(reconcileContactObservations([official, email("hello@aster.example", "harvey")])[0].corroborated).toBe(true);
  });

  it("keeps different Serper and Harvey addresses plus a third official-site address", () => {
    const points = reconcileContactObservations([email("contact@aster.example", "serper"),
      email("business@example.com", "harvey"), email("sales@aster.example", "official_website")]);
    expect(points.map((item) => item.normalized_value).sort()).toEqual([
      "business@example.com", "contact@aster.example", "sales@aster.example",
    ]);
  });

  it("retains a single-source address and returns no invented email when none was found", () => {
    expect(reconcileContactObservations([email("info@aster.example", "serper")])).toHaveLength(1);
    expect(reconcileContactObservations([email("info@aster.example", "harvey")])).toHaveLength(1);
    expect(reconcileContactObservations([])).toEqual([]);
  });

  it("finds every distinct listed official-site address including public Gmail", () => {
    const page = "Aster Jewellery\nContact us at hello@aster.example\nSales: sales@aster.example\nStudio: asterstudio@example.com\nhello@aster.example";
    const found = extractPublicBusinessEmails({ lead_id: lead, source_url: "https://aster.example/contact",
      page_text: page, business_name: "Aster Jewellery", observed_at });
    expect(found.map((item) => item.value)).toEqual(["hello@aster.example", "sales@aster.example", "asterstudio@example.com"]);
    const minified = `<html><body><h1>Aster Jewellery</h1>${"Welcome to our studio. ".repeat(30)}<a href="mailto:info@aster.example">Email us</a></body></html>`;
    expect(extractPublicBusinessEmails({ lead_id: lead, source_url: "https://aster.example/contact",
      page_text: minified, business_name: "Aster Jewellery", observed_at }).map((item) => item.value))
      .toEqual(["info@aster.example"]);
    const longPage = `<h1>Aster Jewellery</h1>${"Navigation ".repeat(2300)}<a href="mailto:late@aster.example">Contact</a>`;
    expect(extractPublicBusinessEmails({ lead_id: lead, source_url: "https://aster.example/contact",
      page_text: longPage, business_name: "Aster Jewellery", observed_at }).map((item) => item.value))
      .toEqual(["late@aster.example"]);
  });

  it("does not merge lookalike businesses or duplicate a repeated observation", () => {
    const points = reconcileContactObservations([email("hello@aster.example", "serper"),
      email("hello@aster.example", "serper"), email("hello@aster.example", "harvey", otherLead)]);
    expect(points).toHaveLength(2);
    expect(points.every((point) => point.observations.length === 1)).toBe(true);
  });

  it("treats an invalid address and an unmarked mobile as unsupported evidence", () => {
    expect(() => normalizeContactValue("email", "owner@@aster.example")).toThrow("INVALID_CONTACT_EMAIL");
    expect(() => reconcileContactObservations([{ ...email("hello@aster.example", "serper"),
      evidence_excerpt: "Contact details available on request" }])).toThrow("CONTACT_EVIDENCE_VALUE_MISSING");
    expect(() => reconcileContactObservations([{ ...email("hello@aster.example", "serper"),
      kind: "whatsapp", value: "+919876543210", evidence_excerpt: "Mobile: +919876543210" }])).toThrow("WHATSAPP_NOT_EXPLICIT");
  });

  it("preserves two different public business phones independently", () => {
    const base = email("hello@aster.example", "serper");
    const phones = reconcileContactObservations([
      { ...base, kind: "phone", value: "+91 98765 43210", evidence_excerpt: "Phone +91 98765 43210" },
      { ...base, kind: "phone", value: "+91 98765 43211", source_provider: "harvey",
        source_url: "https://www.openstreetmap.org/node/21", evidence_excerpt: "phone=+91 98765 43211" },
    ]);
    expect(phones.map((point) => point.normalized_value)).toEqual(["+919876543210", "+919876543211"]);
  });

  it("takes only explicit public contact tags from a mocked Harvey OSM listing", async () => {
    const collector = new HarveyOsmCollector(async () => Response.json({ elements: [{ type: "node", id: 123,
      tags: { name: "Aster Jewellery", "contact:email": "hello@aster.example", "contact:phone": "+919876543210",
        "contact:whatsapp": "+919876543211", website: "https://aster.example/contact" } }] }));
    const listings = await collector.collect({ category: "dentist", latitude: 18.5, longitude: 73.8, radiusKm: 2, limit: 1 });
    expect(listings[0].contacts).toEqual([
      { kind: "email", value: "hello@aster.example", evidence_excerpt: "contact:email=hello@aster.example" },
      { kind: "phone", value: "+919876543210", evidence_excerpt: "contact:phone=+919876543210" },
      { kind: "whatsapp", value: "+919876543211", evidence_excerpt: "contact:whatsapp=+919876543211" },
    ]);
  });
});
