import { describe, expect, it } from "vitest";
import { parseOverturePlacesGeoJSON } from "../packages/server/overture-places.ts";

const target = { city: "Modesto", state: "California", country: "USA", limit: 10, release: "2026-10-21.0" };
const feature = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [-120.99, 37.64] },
  properties: {
    names: { primary: name },
    taxonomy: { primary: "welder", hierarchy: ["services_and_business", "welder"] },
    addresses: [{ freeform: "123 Main St, Modesto, CA", locality: "Modesto", region: "CA", country: "US" }],
    websites: null,
    emails: ["Hello@EXAMPLE.ORG", "hello@example.org"],
    phones: ["+1555010006", "+1555010006"],
    sources: [{ dataset: "meta", record_id: "meta-123" }],
    ...overrides,
  },
});
const collection = (...features: ReturnType<typeof feature>[]) => ({ type: "FeatureCollection", features });

describe("bounded Overture owner-review discovery", () => {
  it("preserves a source observation and distinct public contacts without claiming verification or website absence", () => {
    const rows = parseOverturePlacesGeoJSON(collection(feature(
      "550e8400-e29b-41d4-a716-446655440000", "Example Welding",
    )), target, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "550e8400-e29b-41d4-a716-446655440000",
      release: target.release,
      businessName: "Example Welding",
      category: "welder",
      city: "Modesto",
      country: "USA",
      websiteUrl: null,
      websiteStatus: "UNKNOWN",
      recommendation: "Conditional professional website opportunity",
      opportunityStatus: "conditional",
      reviewStatus: "pending",
      identityStatus: "source_observation",
      duplicateLeadIds: [],
    });
    expect(rows[0].sources).toEqual([{ dataset: "meta", recordId: "meta-123", property: null,
      license: null, updatedAt: null }]);
    expect(rows[0].attribution).toContain("Overture Maps Foundation");
    expect(rows[0].contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "email", value: "hello@example.org", verificationStatus: "unknown", reviewStatus: "pending" }),
      expect.objectContaining({ kind: "phone", value: "+1555010006", verificationStatus: "unknown", reviewStatus: "pending" }),
    ]));
    expect(rows[0].contacts).toHaveLength(2);
    expect(rows[0].contacts.every((contact) => contact.sourceUrl === "https://explore.overturemaps.org/")).toBe(true);
  });

  it("filters outside the selected city and never treats a supplied URL as an independently verified official site", () => {
    const rows = parseOverturePlacesGeoJSON(collection(
      feature("550e8400-e29b-41d4-a716-446655440001", "Example Welding", {
        websites: ["https://example-welding.example/"],
      }),
      feature("550e8400-e29b-41d4-a716-446655440002", "Other City Welding", {
        addresses: [{ freeform: "5 Main St, Sacramento, CA", locality: "Sacramento", region: "CA", country: "US" }],
      }),
      feature("550e8400-e29b-41d4-a716-446655440003", "Private Home", {
        taxonomy: { primary: "private_residence", hierarchy: ["residential"] },
      }),
    ), target, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].websiteStatus).toBe("UNKNOWN");
    expect(rows[0].reviewStatus).toBe("pending");
    expect(rows[0].websiteUrl).toBe("https://example-welding.example/");
    expect(rows[0].opportunityStatus).not.toBe("confirmed");
    expect(rows[0].recommendation).toBeNull();
  });

  it("flags a known business for owner review and caps the returned batch without CRM promotion", () => {
    const known = [{ id: "lead-existing", business_name: " Example  Welding ", city: "Modesto",
      state_region: "California", country: "USA", website_url: null,
      phones: ["+1555010006"], emails: ["hello@example.org"] },
    { id: "lead-contact", business_name: "A different business name", city: "Modesto",
      state_region: "California", country: "USA", website_url: null,
      phones: [], emails: ["HELLO@EXAMPLE.ORG"] }];
    const features = Array.from({ length: 12 }, (_, n) => feature(
      `550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`,
      n === 0 ? "Example Welding" : `Synthetic Workshop ${n}`,
    ));
    const rows = parseOverturePlacesGeoJSON(collection(...features), target, known);
    expect(rows).toHaveLength(10);
    expect(rows[0].duplicateLeadIds).toContain("lead-existing");
    expect(rows[0].duplicateLeadIds).toContain("lead-contact");
    expect(rows[0].reviewStatus).toBe("pending");
    expect(rows.every((row) => row.reviewStatus === "pending")).toBe(true);
    expect(() => parseOverturePlacesGeoJSON(collection(...features), { ...target, limit: 16 }, known))
      .toThrow("INVALID_OVERTURE_TARGET");
  });
});
