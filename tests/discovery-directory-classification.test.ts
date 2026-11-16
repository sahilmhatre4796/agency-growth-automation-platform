// Regression tests for issue discovered 2026-11-15:
// - IIG-style gemology education institutes were ingested as "jewellery" leads.
// - DEFINE JEWELLERY (genuine diamond jewellery manufacturer) surfaced only via
//   a TradeIndia directory profile.
import { describe, expect, test } from "vitest";
import { discoverSerperSearchCandidates } from "../packages/server/discovery.ts";
import type { SearchAdapter, SearchHit } from "../packages/server/research.ts";

const CANDIDATE_TEXT = (name: string, city: string, country: string) =>
  `${name} — ${city}, ${country}. Contact the team for enquiries and orders.`;

const adapterFor = (hits: SearchHit[]): SearchAdapter => ({
  search: async () => hits,
  async extract() { return []; },
});
const run = (hits: SearchHit[]) =>
  discoverSerperSearchCandidates({ industry: "jewellery", city: "Surat", country: "India", page: 1 }, adapterFor(hits));

describe("discovery relevance and directory classification", () => {
  test("IIG-style gemology education institutes do not become jewellery leads", async () => {
    const found = await run([
      { title: "IIG India Surat Campus | Gemology Institute",
        url: "https://iigindia.com/iig-india-surat-campus/",
        content: "The International Institute of Gemology (IIG) Surat campus stands as a key academic hub for gems, diamonds, and jewellery education in India's diamond capital.",
        score: 1 },
    ]);
    expect(found).toEqual([]);
  });

  test("mixed education and trade markers stay available for human review", async () => {
    const found = await run([
      { title: "Surat Institute of Gem Jewellery Design & Exports | Directory",
        url: "https://inst-exports.example.org/",
        content: "Surat Institute of Gem Jewellery Design & Exports, an exporter of diamond jewellery, trains designers in Surat India.",
        score: 1 },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe("review_needed");
  });

  test("genuine diamond jewellery manufacturer on an independent domain is accepted with the official URL", async () => {
    const found = await run([
      { title: "Apex Diamond Jewellery | Surat",
        url: "https://apexdiamondjewellery.in/",
        content: CANDIDATE_TEXT("Apex Diamond Jewellery", "Surat", "India") + " Apex Diamond Jewellery manufactures and exports diamond rings.",
        score: 1 },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].proposed_website_url).toBe("https://apexdiamondjewellery.in/");
  });

  test("jewellery showroom and retail businesses are preserved", async () => {
    const found = await run([
      { title: "Royal Gems Jewellery Showroom | Surat",
        url: "https://royalgems.example.org/",
        content: CANDIDATE_TEXT("Royal Gems Jewellery", "Surat", "India") + " Royal Gems Jewellery retail showroom in Surat India.",
        score: 1 },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].proposed_website_url).toBe("https://royalgems.example.org/");
  });

  test("TradeIndia business profiles are recognised as directory listings, never as official websites", async () => {
    const found = await run([
      { title: "DEFINE JEWELLERY — Real Diamond Jewellery | TradeIndia",
        url: "https://www.tradeindia.com/define-jewellery-2297799/",
        content: "DEFINE JEWELLERY is a leading exporter manufacturer of real diamond jewellery rings earrings in Surat India.",
        score: 1 },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe("review_needed");
    expect(found[0].proposed_website_url).toBeNull();
    expect(found[0].source_url).toBe("https://www.tradeindia.com/define-jewellery-2297799/");
  });

  test("directory profile versus official domain: only the independent domain may carry the website URL", async () => {
    const found = await run([
      { title: "Element Jewellery | Surat",
        url: "https://elementjewellery.in/element",
        content: CANDIDATE_TEXT("Element Jewellery", "Surat", "India") + " Element Jewellery manufactures diamond jewellery in Surat India.",
        score: 1 },
      { title: "Prime Jewellery | IndiaMART",
        url: "https://www.indiamart.com/prime-jewellery-8557/",
        content: "Prime Jewellery manufactures diamond jewellery in Surat India. Prime jewellery profile listing.",
        score: 1 },
    ]);
    const official = found.find((c) => c.name === "Element Jewellery");
    const directory = found.find((c) => c.name === "Prime Jewellery");
    expect(official?.proposed_website_url).toBe("https://elementjewellery.in/element");
    expect(directory?.proposed_website_url).toBeNull();
  });
});
