import { describe, expect, it } from "vitest";
import { allocateCountryTargets, canonicalDiscoveryCountry, DEFAULT_DISCOVERY_COUNTRIES,
  DEFAULT_DAILY_TARGETS, DEFAULT_WEEKLY_COUNTRIES, hasUnambiguousCountryEvidence, mentionedDiscoveryCountries,
  orderedDiscoveryCountries, phoneCountryCompatibility, weeklyFallbackMarkets, weeklyMarketForDate } from "../packages/server/market-targeting.ts";
import { parseVibeRequest } from "../packages/server/vibe-prospecting.ts";

describe("international discovery targeting", () => {
  it("defaults to five overseas markets and keeps India opt-in", () => {
    expect(parseVibeRequest("Find 10 dental businesses with public contact details").countries)
      .toEqual([...DEFAULT_DISCOVERY_COUNTRIES]);
    expect(parseVibeRequest("Find 10 jewellery businesses in Surat, India")).toMatchObject({
      countries: ["India"], country: "India", city: "Surat",
    });
    expect(parseVibeRequest("Find 10 jewellers in Surat India")).toMatchObject({
      countries: ["India"], country: "India", city: "Surat",
    });
    expect(parseVibeRequest("Find 10 clinics in Austin, USA")).toMatchObject({
      countries: ["United States"], country: "United States", city: "Austin",
    });
    expect(parseVibeRequest("Find 10 clinics in Austin USA")).toMatchObject({
      countries: ["United States"], country: "United States", city: "Austin",
    });
    expect(parseVibeRequest("Find emails for these 10 businesses discovered by Serper").countries)
      .toContain("India");
  });

  it("preserves mentioned priority order and allocates a bounded ten-business target", () => {
    const filters = parseVibeRequest("Find 10 dental businesses in Australia, USA and New Zealand");
    expect(filters.countries).toEqual(["Australia", "United States", "New Zealand"]);
    expect(allocateCountryTargets(10, filters.countries)).toEqual([
      { country: "Australia", target: 5 }, { country: "United States", target: 3 }, { country: "New Zealand", target: 2 },
    ]);
    expect(allocateCountryTargets(10, [...DEFAULT_DISCOVERY_COUNTRIES]).map((item) => item.target))
      .toEqual([3, 3, 2, 1, 1]);
    expect(() => orderedDiscoveryCountries(["United States", "USA"])).toThrow("INVALID_DISCOVERY_COUNTRIES");
    expect(() => orderedDiscoveryCountries(["Atlantis"])).toThrow("INVALID_DISCOVERY_COUNTRIES");
  });

  it("does not promote a same-name location or conflicting country to identity evidence", () => {
    expect(canonicalDiscoveryCountry("UAE")).toBe("United Arab Emirates");
    expect(canonicalDiscoveryCountry("IN")).toBe("India");
    expect(canonicalDiscoveryCountry("U.S.A.")).toBe("United States");
    expect(hasUnambiguousCountryEvidence("Austin office, America", "United States")).toBe(false);
    expect(mentionedDiscoveryCountries("Sydney, Australia and Auckland, New Zealand"))
      .toEqual(["Australia", "New Zealand"]);
    expect(hasUnambiguousCountryEvidence("Austin office, Texas", "United States")).toBe(false);
    expect(hasUnambiguousCountryEvidence("Austin office, United States", "United States")).toBe(true);
    expect(hasUnambiguousCountryEvidence("Austin, United States; Newcastle, Australia", "United States")).toBe(false);
    expect(hasUnambiguousCountryEvidence("Austin, Australia", "United States")).toBe(false);
  });

  it("checks public phone formatting and calling-code compatibility without claiming ownership", () => {
    expect(phoneCountryCompatibility("+1 (512) 555-0134", "United States")).toBe("compatible_calling_code");
    expect(phoneCountryCompatibility("+44 20 7946 0958", "United States")).toBe("different_calling_code");
    expect(phoneCountryCompatibility("512-555-0134", "United States")).toBe("invalid_e164");
    expect(phoneCountryCompatibility("+64 9 555 1234", "Unknown market")).toBe("unknown_market");
  });

  it("selects all seven primary markets at Asia/Kolkata day boundaries while keeping India separate", () => {
    const expected = ["United States", "New Zealand", "United Arab Emirates", "Australia", "United Kingdom", "United States", "Australia"];
    for (let day = 0; day < 7; day++) {
      // 2026-10-18 is Sunday; 19:00 UTC is after midnight in Kolkata.
      const date = new Date(Date.UTC(2026, 9, 17 + day, 19));
      const plan = weeklyMarketForDate(date);
      expect(plan.today).toBe(expected[day]);
      expect(plan.next).toBe(expected[(day + 1) % 7]);
      expect(plan.internationalTarget).toBe(500);
      expect(plan.indiaManualTarget).toBe(100);
    }
    expect(DEFAULT_DAILY_TARGETS).toEqual({ internationalWebsite: 350, internationalAutomation: 150, indiaManual: 100 });
    expect(weeklyMarketForDate(new Date("2026-10-17T18:29:59Z")).today).toBe("Australia");
    expect(weeklyMarketForDate(new Date("2026-10-17T18:30:00Z")).today).toBe("United States");
  });

  it("never enables country fallback implicitly or mixes India into international markets", () => {
    expect(weeklyFallbackMarkets("United States", DEFAULT_WEEKLY_COUNTRIES, false, 5)).toEqual([]);
    expect(weeklyFallbackMarkets("United States", DEFAULT_WEEKLY_COUNTRIES, true, 0)).toEqual([]);
    expect(weeklyFallbackMarkets("United States", DEFAULT_WEEKLY_COUNTRIES, true, 5))
      .toEqual(["New Zealand", "United Arab Emirates", "Australia", "United Kingdom"]);
    expect(() => weeklyMarketForDate(new Date(), "Asia/Kolkata", [...DEFAULT_WEEKLY_COUNTRIES.slice(0, 6), "India"]))
      .toThrow("INVALID_WEEKLY_SCHEDULE");
    expect(() => weeklyMarketForDate(new Date(), "Invalid/Zone")).toThrow("INVALID_TIMEZONE");
  });
});
