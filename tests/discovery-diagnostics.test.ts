// Privacy-safe diagnostics for the paged_search candidate filtering pipeline.
// Asserts aggregate counters only — no per-result data is embedded.
import { describe, expect, test } from "vitest";
import { discoverSerperSearchCandidates, newDiscoveryFilterDiagnostics } from "../packages/server/discovery.ts";
import type { SearchAdapter, SearchHit } from "../packages/server/research.ts";

const LONG = "Trusted diamond jewellery house in Surat India, serving customers with a full range for orders, wholesale and appointments.";

const adapterFor = (hits: SearchHit[]): SearchAdapter => ({
  search: async () => hits,
  async extract() { return []; },
});

const runWithStats = async (hits: SearchHit[]) => {
  const stats = newDiscoveryFilterDiagnostics();
  const found = await discoverSerperSearchCandidates(
    { industry: "jewellery", city: "Surat", country: "India", page: 1 },
    adapterFor(hits), undefined, stats,
  );
  return { found, stats };
};

describe("paged_search filter diagnostics", () => {
  test("raw, rejected and accepted counters account for every hit exactly once", async () => {
    const { found, stats } = await runWithStats([
      { title: "Top Jewellery Stores in Surat | Directory", url: "https://directory.example.org/top", content: LONG, score: 1 },
      { title: "IIG India Surat Campus | Gemology Institute", url: "https://iigindia.com/surat/", content: "The International Institute of Gemology (IIG) Surat campus stands as a key academic hub for gems and jewellery education.", score: 1 },
      { title: "Unsafe Gems | Surat", url: "http://insecure.example.org/", content: LONG, score: 1 },
      { title: "Quiet Gemcraft | Surat", url: "https://quietcraft.example.org/", content: "short.", score: 1 },
      { title: "Solo Jewellery | Surat", url: "https://wedgeoff.example.org/", content: "Exceptional diamond rings and earrings with full customer service across Gujarat state for clients.", score: 1 },
      { title: "Twin Gems | Surat", url: "https://twingems.example.org/", content: LONG + " Twin Gems manufactures diamond jewellery.", score: 1 },
      { title: "Twin Gems | Surat", url: "https://twingems.example.org/branch", content: LONG + " Twin Gems manufactures diamond jewellery.", score: 1 },
      { title: "Fine Jewellery | Surat", url: "https://finejewellery.example.org/", content: LONG + " Fine Jewellery manufactures diamond jewellery in Surat India.", score: 1 },
    ]);
    expect(stats).toEqual({
      raw_results: 8,
      name_rejected: 1,
      education_rejected: 1,
      unsafe_url_rejected: 1,
      snippet_rejected: 1,
      identity_rejected: 1,
      duplicate_rejected: 1,
      accepted: 2,
    });
    // raw == sum of all outcomes
    const accounted = stats.name_rejected + stats.education_rejected + stats.unsafe_url_rejected
      + stats.snippet_rejected + stats.identity_rejected + stats.duplicate_rejected + stats.accepted;
    expect(accounted).toBe(stats.raw_results);
    expect(found.map((c) => c.name)).toEqual(["Twin Gems", "Fine Jewellery"]);
  });

  test("education-plus-trade hits are not caught by the education gate (stay in review)", async () => {
    const { found, stats } = await runWithStats([
      { title: "Gem Export Academy | Surat", url: "https://gemexport.example.org/", content: "Gem Export Academy runs an exporter training and manufacturing program for diamond jewellery in Surat India.", score: 1 },
    ]);
    expect(stats.education_rejected).toBe(0);
    expect(stats.name_rejected + stats.education_rejected + stats.unsafe_url_rejected + stats.snippet_rejected + stats.identity_rejected + stats.duplicate_rejected).toBeLessThanOrEqual(1);
    expect(found.length + stats.duplicate_rejected + stats.identity_rejected).toBe(1);
  });

  test("calling without a diagnostics object still works (backward compatibility)", async () => {
    const found = await discoverSerperSearchCandidates(
      { industry: "jewellery", city: "Surat", country: "India", page: 1 },
      adapterFor([
        { title: "Fine Jewellery | Surat", url: "https://finejewellery.example.org/", content: LONG + " Fine Jewellery manufactures diamond jewellery in Surat India.", score: 1 },
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe("review_needed");
  });
});
