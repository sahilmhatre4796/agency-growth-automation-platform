import { describe, expect, test, vi } from "vitest";
import { publicWorkflowSignal, researchBusiness, SerperSearchAdapter, TavilySearchAdapter, type SearchAdapter } from "../packages/server/research.ts";
import { personalizedSelectionSchema, renderPersonalizedEmail, reviewedNoSiteDraftEligible } from "../packages/shared/personalization.ts";
import { StructuredAI } from "../packages/server/ai.ts";
import { discoverSerperCandidates, discoverSerperSearchCandidates, discoverySearchLane } from "../packages/server/discovery.ts";

const official = "https://oak.example.org/";
const ownContent = "Oak Studio creates handcrafted furniture for homes in Pune. We design custom tables using reclaimed wood.";
function mockResearch(options: { website?: boolean; content?: string; competitor?: boolean } = {}): SearchAdapter {
  return {
    async search(query) {
      if (query.startsWith("furniture")) return options.competitor
        ? [{ title: "Maple Works", url: "https://maple.example.org/", content: "Furniture in Pune", score: 0.9 }]
        : [];
      return options.website === false ? [] : [{ title: "Oak Studio", url: official, content: "Furniture studio", score: 0.9 }];
    },
    async extract(urls) {
      return urls.flatMap((url) => {
        if (url === official && options.website !== false) return [{ url, raw_content: options.content ?? ownContent }];
        if (url.includes("maple") && options.competitor) return [{ url, raw_content: "Maple Works offers furniture in Pune." }];
        return [];
      });
    },
  };
}
const lead = { name: "Oak Studio", websiteUrl: official, industry: "furniture", market: "Pune" };
const approvedOpportunity = {
  service_name: "Appointment and booking systems",
  gap_claim: "Oak Studio asks customers to telephone for workshop appointments.",
  gap_evidence_id: "00000000-0000-4000-8000-000000000099",
  benefit: "easier appointment requests", confidence: 0.9,
};

describe("mocked Tavily research and grounded email", () => {
  test("a no-site business can reach reviewable draft research only with two independent public facts", async () => {
    const listing: SearchAdapter = {
      async search() { return [
        { title: "Oak Studio listing", url: "https://directory-one.test/oak", content: "Oak Studio in Pune", score: 0.8 },
        { title: "Oak Studio profile", url: "https://directory-two.test/oak", content: "Oak Studio in Pune", score: 0.7 },
      ]; },
      async extract(urls) { return urls.map((url) => ({ url,
        raw_content: "Oak Studio in Pune creates handcrafted furniture and custom tables for local customers." })); },
    };
    const report = await researchBusiness({ ...lead, websiteUrl: null }, listing);
    expect(report).toMatchObject({ state: "ready", website: { status: "not_verified", url: null },
      opportunity: "website_presence_review" });
    expect(report.evidence.filter((item) => item.kind === "business_fact")).toHaveLength(2);
    const reviewedAssessment = { reportWebsite: report.website, leadWebsiteUrl: null,
      assessmentStatus: "NO_OFFICIAL_WEBSITE_DISCOVERED", assessmentObservedAt: new Date().toISOString(),
      serviceKey: "service_01" };
    expect(reviewedNoSiteDraftEligible(reviewedAssessment)).toBe(true);
    expect(reviewedNoSiteDraftEligible({ ...reviewedAssessment, leadWebsiteUrl: official })).toBe(false);
    expect(reviewedNoSiteDraftEligible({ ...reviewedAssessment, serviceKey: "service_15" })).toBe(false);
    expect(reviewedNoSiteDraftEligible({ ...reviewedAssessment, assessmentObservedAt: "2025-01-01T00:00:00Z" })).toBe(false);
    const draft = renderPersonalizedEmail(lead.name, report,
      { fact_id: report.evidence[0].id, competitor_id: null, language: "en" },
      { ...approvedOpportunity, service_name: "Business website",
        gap_claim: "Reviewed public evidence found no official Oak Studio website after separate checks." });
    expect(draft.body).toContain("A public page about Oak Studio says");
    expect(draft.body).not.toContain("Oak Studio's site");
    expect(draft.word_count).toBeLessThanOrEqual(90);
    const single = await researchBusiness({ ...lead, websiteUrl: null }, {
      ...listing, async search() { return [{ title: "Oak Studio listing", url: "https://directory-one.test/oak", content: "Oak Studio in Pune", score: 0.8 }]; },
    });
    expect(single.state).toBe("manual_review");
    const mirrored = await researchBusiness({ ...lead, websiteUrl: null }, {
      ...listing, async search() { return [
        { title: "Oak Studio listing", url: "https://directory-one.test/oak", content: "Oak Studio in Pune", score: 0.8 },
        { title: "Oak Studio listing mirror", url: "https://www.directory-one.test/oak", content: "Oak Studio in Pune", score: 0.7 },
      ]; },
    });
    expect(mirrored.state).toBe("manual_review");
    expect(() => renderPersonalizedEmail(lead.name,
      { ...report, evidence: report.evidence.slice(0, 1) },
      { fact_id: report.evidence[0].id, competitor_id: null, language: "en" },
      { ...approvedOpportunity, service_name: "Business website" })).toThrow("RESEARCH_REVIEW_REQUIRED");
  });
  test("official workflow evidence suggests automation review without claiming a missing system", async () => {
    const content = `${ownContent}\nCustomers can call our team to book appointments for a workshop consultation.`;
    const report = await researchBusiness(lead, mockResearch({ content }));
    expect(report.opportunity).toBe("appointment_workflow_review");
    expect(report.evidence.some((item) => item.kind === "business_fact" && item.claim.includes("book appointments"))).toBe(true);
    expect(report.reason).toMatch(/Whether an adequate system already exists is unknown/);
    expect((await researchBusiness({ ...lead, websiteUrl: null }, mockResearch({ content }))).opportunity).toBe("website_presence_review");
    expect(publicWorkflowSignal("Oak Studio has a premium functioning website.")).toBeNull();
    expect(publicWorkflowSignal("Customers can book appointments online instantly through our self-service booking portal.")).toBeNull();
  });
  test("public contact extraction suggests only same-domain addresses from a readable supplied site", async () => {
    const content = `${ownContent} Write to hello@oak.example.org or hello@oak.example.org. A directory also lists random@example.com and team@other.example.org.`;
    const report = await researchBusiness(lead, mockResearch({ content }));
    expect(report.contact_candidates).toEqual([expect.objectContaining({ email: "hello@oak.example.org", source_url: official, confidence: 0.65 })]);
    expect((await researchBusiness({ ...lead, websiteUrl: null }, mockResearch({ content }))).contact_candidates).toEqual([]);
  });
  test("research carries a named public Gmail candidate only when the official page associates it", async () => {
    const report = await researchBusiness(lead, mockResearch({ content:
      `${ownContent}\nPriya Shah — Founder — oakstudio@example.com\nGeneral enquiries: hello@oak.example.org` }));
    expect(report.decision_maker_candidates).toEqual([expect.objectContaining({
      full_name: "Priya Shah", role: "Founder", email: "oakstudio@example.com",
      email_status: "publicly_sourced", source_url: official,
    })]);
    expect((await researchBusiness({ ...lead, websiteUrl: null }, mockResearch())).decision_maker_candidates).toEqual([]);
  });
  test("official-page research carries every distinct public email into contact-first evidence", async () => {
    const report = await researchBusiness(lead, mockResearch({ content:
      `${ownContent}\nGeneral: hello@oak.example.org\nSales: sales@oak.example.org\nStudio: oakstudio@example.com` }));
    expect(report.contact_observations?.map((item) => item.value)).toEqual([
      "hello@oak.example.org", "sales@oak.example.org", "oakstudio@example.com",
    ]);
    expect((await researchBusiness({ ...lead, websiteUrl: null }, mockResearch())).contact_observations).toEqual([]);
  });
  test("Serper discovery returns reviewable candidates only after page identity, industry and city match", async () => {
    const adapter: SearchAdapter = {
      async search() { return [
        { title: "Zephyr Textiles | Fabrics in Pune", url: "https://zephyr.example.org/", content: "Textiles", score: 1 },
        { title: "Top textile businesses in Pune", url: "https://directory.example.org/", content: "Directory", score: 0.8 },
        { title: "Unrelated Studio | Design", url: "https://unrelated.example.org/", content: "Design", score: 0.7 },
      ]; },
      async extract(urls) { return urls.map((url) => ({ url, raw_content: url.includes("zephyr")
        ? "Zephyr Textiles makes cotton textiles in Pune for local customers."
        : "Unrelated Studio designs interiors in Mumbai." })); },
    };
    const candidates = await discoverSerperCandidates({ industry: "textiles", city: "Pune", country: "India" }, adapter);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "Zephyr Textiles", state: "review_needed", actual_provider: "serper", proposed_website_url: "https://zephyr.example.org/" });
    expect(candidates[0].evidence_quote).toContain("Pune");
  });
  test("Serper discovery retains multiple public page addresses as pending contact observations", async () => {
    const adapter: SearchAdapter = { search: async () => [{ title: "Aster Jewellery | Surat",
      url: "https://aster.example/contact", content: "Jewellery Surat", score: 1 }],
    extract: async () => [{ url: "https://aster.example/contact",
      raw_content: "Aster Jewellery in Surat offers jewellery. Email contact@aster.example or business@example.com." }] };
    const found = await discoverSerperCandidates({ industry: "jewellery", city: "Surat", country: "India" }, adapter);
    expect(found).toHaveLength(1);
    expect(found[0].contacts.map((item) => item.value)).toEqual(["contact@aster.example", "business@example.com"]);
    expect(found[0].state).toBe("review_needed");
  });
  test("deep discovery attributes contacts to the extracted page, not its search-result URL", async () => {
    const adapter: SearchAdapter = {
      search: async () => [{ title: "Aster Jewellery | Surat", url: "https://aster.example/search",
        content: "Jewellery Surat", score: 1 }],
      extract: async () => [{ url: "https://aster.example/contact",
        raw_content: "Aster Jewellery in Surat offers jewellery. Contact hello@aster.example." }],
    };
    const [candidate] = await discoverSerperCandidates({ industry: "jewellery", city: "Surat", country: "India" }, adapter);
    expect(candidate.source_url).toBe("https://aster.example/contact");
    expect(candidate.contacts.map((item) => item.value)).toEqual(["hello@aster.example"]);
  });
  test("paged discovery spends one bounded search credit and leaves snippets pending review", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://google.serper.dev/search");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        q: "textiles Pune India -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -site:yelp.com -site:indiamart.com -site:justdial.com -filetype:pdf", page: 2, num: 10,
      });
      return Response.json({ organic: [
        { title: "Aster Textiles | Pune", link: "https://aster.example.org/",
          snippet: "Aster Textiles makes fabric in Pune; contact our team for details." },
        { title: "Top textile businesses | Pune", link: "https://directory.example.org/",
          snippet: "Business listings in Pune." },
        { title: "Unrelated Works | Mumbai", link: "https://unrelated.example.org/",
          snippet: "Unrelated Works in Mumbai." },
        { title: "Birch Textiles | Pune", link: "https://directory.example.org/birch",
          snippet: "Birch Textiles supplies fabric to businesses in Pune." },
        { title: "Cedar Textiles | Pune", link: "https://directory.example.org/cedar",
          snippet: "Cedar Textiles supplies fabric to businesses in Pune." },
        { title: "Aster Textiles | Pune", link: "https://another.example.org/aster",
          snippet: "Aster Textiles makes fabric in Pune; contact our team for details." },
      ], credits: 1 });
    });
    const adapter = new SerperSearchAdapter("mock-only", transport, 1);
    const found = await discoverSerperSearchCandidates({ industry: "textiles", city: "Pune", country: "India", page: 2 }, adapter);
    expect(found).toHaveLength(3);
    expect(found.map((candidate) => candidate.name)).toEqual(["Aster Textiles", "Birch Textiles", "Cedar Textiles"]);
    expect(found.every((candidate) => candidate.state === "review_needed" && !candidate.contacts.length)).toBe(true);
    await expect(adapter.search("another page", 1, 3)).rejects.toThrow("SERPER_LOCAL_CREDIT_CAP");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("website lane carries exactly the eight owner-approved exclusions, dynamically interpolated", async () => {
    const calls: Array<{ q: string; num: number; page: number | undefined }> = [];
    const adapter: SearchAdapter = {
      async search(q, num, page) {
        calls.push({ q, num, page });
        return [];
      },
      async extract() { return []; },
    };
    await discoverSerperSearchCandidates({ industry: "jewellery", city: "Surat", country: "India", page: 1 }, adapter);
    expect(calls).toEqual([
      { q: "jewellery Surat India -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -site:yelp.com -site:indiamart.com -site:justdial.com -filetype:pdf", num: 10, page: 1 },
    ]);
    const query = calls[0].q;
    for (const host of ["instagram.com", "facebook.com", "booking.com", "aeroleads.com", "yelp.com", "indiamart.com", "justdial.com"]) {
      expect(query).toContain(`-site:${host}`);
    }
    expect(query).toContain("-filetype:pdf");
    expect(query).not.toContain("sulekha");
    expect(query).not.toContain("yellow.com");
    expect(query).not.toContain("yellowpages");
  });
  test("automation-lane query is unchanged by the website-lane exclusions", async () => {
    const search = vi.fn(async () => [] as Array<{ title: string; url: string; content: string; score: number }>);
    const adapter: SearchAdapter = { search, async extract() { return []; } };
    await discoverSerperSearchCandidates({ industry: "jewellery", city: "Surat", country: "India", page: 1, lane: "automation" }, adapter);
    expect(search).toHaveBeenCalledWith(
      "jewellery businesses Surat India customer enquiries WhatsApp -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -filetype:pdf",
      10,
      1,
    );
  });
  test("a 70/30 campaign allocates ten search pages without claiming ten qualified leads", async () => {
    expect(Array.from({ length: 10 }, (_, index) => discoverySearchLane(index + 1, 70)))
      .toEqual(["website", "automation", "website", "website", "website",
        "automation", "website", "website", "automation", "website"]);
    expect(Array.from({ length: 10 }, (_, index) => discoverySearchLane(index + 1, 70)).filter((lane) => lane === "website"))
      .toHaveLength(7);
    expect(discoverySearchLane(1, 0)).toBe("automation");
    expect(discoverySearchLane(1, 100)).toBe("website");
    expect(() => discoverySearchLane(16, 70)).toThrow("INVALID_DISCOVERY_ALLOCATION");
  });
  test("automation-lane search still records only review-needed identity candidates", async () => {
    const search = vi.fn(async () => [{ title: "Birch Textiles | Pune",
      url: "https://directory.example.org/birch", content: "Birch Textiles serves customers in Pune.", score: 1 }]);
    const found = await discoverSerperSearchCandidates({ industry: "textiles", city: "Pune", country: "India", page: 2,
      lane: "automation" }, { search, async extract() { return []; } });
    expect(search).toHaveBeenCalledWith("textiles businesses Pune India customer enquiries WhatsApp -site:instagram.com -site:facebook.com -site:booking.com -site:aeroleads.com -filetype:pdf", 10, 2);
    expect(found).toMatchObject([{ name: "Birch Textiles", state: "review_needed", contacts: [] }]);
  });
  test("a business-named public search snippet preserves explicit email and phone for review", async () => {
    const search = vi.fn(async () => [
      { title: "Aster Textiles | Pune", url: "https://directory.example.org/aster",
        content: "Aster Textiles, Pune. Email contact@aster.example.org. Phone: +919876543210.", score: 1 },
      { title: "Birch Textiles | Pune", url: "https://directory.example.org/birch",
        content: "Birch Textiles, Pune. No public contact listed.", score: 0.5 },
    ]);
    const found = await discoverSerperSearchCandidates({ industry: "textiles", city: "Pune", country: "India", page: 1 },
      { search, async extract() { return []; } });
    expect(found).toHaveLength(2);
    expect(found[0].contacts.map((item) => [item.kind, item.value])).toEqual([
      ["email", "contact@aster.example.org"], ["phone", "+919876543210"],
    ]);
    expect(found[0].contacts.every((item) => item.evidence_excerpt.includes(item.value))).toBe(true);
    expect(found[0].source_url).toBe("https://directory.example.org/aster");
    expect(found[1].contacts).toEqual([]);
    expect(found.every((item) => item.state === "review_needed")).toBe(true);
  });
  test("paged search rejects social posts, directory categories and page-heading identities", async () => {
    const search = vi.fn(async () => [
      { title: "Authenticity mark on all jewellery . Website link in bio . Visit our ...",
        url: "https://www.instagram.com/reel/abc/", content: "Visit us in Surat for jewellery", score: 1 },
      { title: "Jewelry Manufacturing Services", url: "https://dir.example.org/surat/jewelry-manufacturing-services.html",
        content: "Get address of Jewelry Manufacturing Services firms in Surat", score: 1 },
      { title: "Contact support number of www.divinejewellerystore.com India",
        url: "https://www.divinejewellerystore.com/contact",
        content: "Shop address in Surat. Email divine@example.org", score: 1 },
      { title: "Anshum Diamond Jewellery", url: "https://in.linkedin.com/company/anshum",
        content: "Anshum Diamond Jewellery is based in Surat, Gujarat", score: 1 },
      { title: "Anshum Diamond Jewellery", url: "https://in.linkedin.com/jobs/view/anshum-role",
        content: "Anshum Diamond Jewellery is based in Surat, Gujarat", score: 1 },
      { title: "Company Secretary", url: "https://www.kalamandirjewellersgroup.com/investor/company-secretary",
        content: "Company Secretary contact in Surat", score: 1 },
      { title: "Kiran Pandya Email & Phone Number", url: "https://aeroleads.com/in/kiran-pandya",
        content: "Kiran Pandya Email & Phone Number Surat jewellery", score: 1 },
      { title: "MEDIUM MANUFACTURER-JEWELLERY 2020.pdf", url: "https://www.gjc.org.in/pdf/medium-manufacturer-jewellery.pdf",
        content: "MEDIUM MANUFACTURER-JEWELLERY 2020.pdf Surat", score: 1 },
      { title: "Antiquecut Jewelry, Surat (updated prices 2026)", url: "https://www.booking.com/hotel/in/antiquecut-jewelry.html",
        content: "Antiquecut Jewelry, Surat hotel listing", score: 1 },
      { title: "Khushalbhai Jewellers", url: "https://www.khushalbhaijewellers.com/",
        content: "Jewellery shop in Surat, Gujarat. Contact our store.", score: 1 },
      { title: "Surat Diamond Jewellery", url: "https://www.suratdiamond.com/",
        content: "Surat Diamond Jewellery sells certified diamond and gold jewellery online.", score: 1 },
      { title: "Surat Diamond Jewellery", url: "https://www.suratdiamond.com/page/about-us",
        content: "Surat Diamond Jewellery operates from Mumbai, India.", score: 1 },
      { title: "River Jewels", url: "https://www.justdial.com/Surat/River-Jewels-Katargam/123",
        content: "River Jewels jewellery showroom, Katargam, Surat, Gujarat. Phone +919876543210", score: 1 },
    ]);
    const found = await discoverSerperSearchCandidates({ industry: "jewellery", city: "Surat", country: "India", page: 1 },
      { search, async extract() { return []; } });
    expect(found.map((candidate) => candidate.name)).toEqual(["Anshum Diamond Jewellery", "Khushalbhai Jewellers", "River Jewels"]);
    expect(found.every((candidate) => candidate.state === "review_needed")).toBe(true);
    expect(found.find((candidate) => candidate.name === "Anshum Diamond Jewellery")?.proposed_website_url)
      .toBeNull();
    expect(found.find((candidate) => candidate.name === "Anshum Diamond Jewellery")?.source_url)
      .toBe("https://in.linkedin.com/company/anshum");
  });
  test("international search retains only market-evidenced business candidates", async () => {
    const search = vi.fn(async () => [
      { title: "Northstar Dental | Austin", url: "https://www.yelp.com/biz/northstar-dental-austin",
        content: "Northstar Dental, Austin, United States. Business address and phone are publicly listed.", score: 1 },
      { title: "Southern Dental | Austin", url: "https://www.yelp.com/biz/southern-dental-austin",
        content: "Southern Dental, Austin, Australia. Business address and phone are publicly listed.", score: 1 },
      { title: "Coastal Dental | Austin", url: "https://coastaldental.example.org/",
        content: "Coastal Dental serves Austin patients. Book online.", score: 1 },
    ]);
    const found = await discoverSerperSearchCandidates({ industry: "dental", city: "Austin", country: "United States", page: 1 },
      { search, async extract() { return []; } });
    expect(found.map((candidate) => candidate.name)).toEqual(["Northstar Dental"]);
    expect(found[0].proposed_website_url).toBeNull();
    expect(found[0].source_url).toContain("yelp.com");
    expect(found[0].state).toBe("review_needed");
  });
  test("long approved discovery targets remain within the provider's query bound", async () => {
    const queries: string[] = [];
    const search = vi.fn(async (query: string) => { queries.push(query); return []; });
    await discoverSerperSearchCandidates({ industry: "j".repeat(80), city: "s".repeat(80),
      country: "i".repeat(80), page: 1 }, { search, async extract() { return []; } });
    expect(queries[0].length).toBeLessThanOrEqual(300);
  });
  test("a Serper discovery adapter cannot spend beyond its 31-credit reservation", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/search")) return Response.json({ organic: [
        { title: "Zephyr Textiles | Pune", link: "https://zephyr.example.org/" },
        { title: "Maple Textiles | Pune", link: "https://maple.example.org/" },
        { title: "Pine Textiles | Pune", link: "https://pine.example.org/" },
      ], credits: 1 });
      const body = JSON.parse(String(init?.body)) as { url: string };
      const name = new URL(body.url).hostname.split(".")[0];
      return Response.json({ text: `${name} Textiles makes textiles in Pune.`, credits: 10 });
    });
    const adapter = new SerperSearchAdapter("mock-only", transport, 31);
    expect(await discoverSerperCandidates({ industry: "textiles", city: "Pune", country: "India" }, adapter)).toHaveLength(3);
    await expect(adapter.search("another target", 1)).rejects.toThrow("SERPER_LOCAL_CREDIT_CAP");
    expect(transport).toHaveBeenCalledTimes(4);
  });
  test("Serper search and webpage adapters translate mocked results without a live key", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("X-API-KEY")).toBe("mock-only");
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/search")) {
        expect(body).toMatchObject({ q: "Oak Studio Pune", num: 10 });
        return Response.json({ organic: [{ title: "Oak Studio", link: official, snippet: "Furniture in Pune", position: 1 }], credits: 1 });
      }
      expect(String(url)).toBe("https://scrape.serper.dev");
      expect(body).toEqual({ url: official, includeMarkdown: false });
      return Response.json({ text: ownContent, credits: 2 });
    });
    const adapter = new SerperSearchAdapter("mock-only", transport);
    expect((await adapter.search("Oak Studio Pune", 5))[0]).toMatchObject({ url: official, content: "Furniture in Pune" });
    expect((await adapter.extract([official]))[0]).toEqual({ url: official, raw_content: ownContent });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test("Serper unexpected scrape charges and exhausted credits fail closed", async () => {
    const expensive = new SerperSearchAdapter("mock-only", async () => Response.json({ text: ownContent, credits: 11 }));
    await expect(expensive.extract([official])).rejects.toThrow("SERPER_CREDIT_COST_UNEXPECTED");
    const limited = new SerperSearchAdapter("mock-only", async () => Response.json({ organic: [], credits: 1 }));
    for (let n = 0; n < 42; n++) await limited.search("Oak Studio Pune", 5);
    await expect(limited.search("Oak Studio Pune", 5)).rejects.toThrow("SERPER_LOCAL_CREDIT_CAP");
  });
  test("mock Serper report keeps official and competitor claims tied to extracted pages", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/search")) return Response.json({ organic: body.q.startsWith("furniture")
        ? [{ title: "Maple Works", link: "https://maple.example.org/", snippet: "Furniture in Pune", position: 1 }]
        : [{ title: "Oak Studio", link: official, snippet: "Furniture studio", position: 1 }], credits: 1 });
      return Response.json({ text: body.url === official ? ownContent : "Maple Works offers furniture in Pune.", credits: 2 });
    });
    const report = await researchBusiness(lead, new SerperSearchAdapter("mock-only", transport));
    expect(report.state).toBe("ready");
    expect(report.evidence.find((item) => item.kind === "business_fact")?.url).toBe(official);
    expect(report.competitors).toEqual([expect.objectContaining({ name: "Maple Works", url: "https://maple.example.org/" })]);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  test("Tavily HTTP adapter uses bounded server-side search and extract responses", async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock-only");
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/search")) {
        expect(body.search_depth).toBe("basic");
        return Response.json({ results: [{ title: "Oak Studio", url: official, content: "Furniture in Pune", score: 0.9 }] });
      }
      expect(body.extract_depth).toBe("basic");
      return Response.json({ results: [{ url: official, raw_content: ownContent }] });
    });
    const adapter = new TavilySearchAdapter("mock-only", transport);
    expect((await adapter.search("Oak Studio Pune", 5))[0].url).toBe(official);
    expect((await adapter.extract([official]))[0].raw_content).toBe(ownContent);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test("no verified website leads to manual review without claiming no website", async () => {
    const report = await researchBusiness(lead, mockResearch({ website: false }));
    expect(report.state).toBe("manual_review");
    expect(report.website.status).toBe("not_verified");
    expect(report.reason).not.toMatch(/no website/i);
  });
  test("an insecure extract URL cannot become official contact evidence", async () => {
    const adapter: SearchAdapter = { search: async () => [], extract: async () => [{
      url: "http://oak.example.org/", raw_content: `${ownContent} Contact hello@oak.example.org`,
    }] };
    const report = await researchBusiness(lead, adapter);
    expect(report.website.status).toBe("not_verified");
    expect(report.contact_observations).toEqual([]);
  });
  test("a matching search hit is not promoted to an official website", async () => {
    const report = await researchBusiness({ ...lead, websiteUrl: null }, mockResearch());
    expect(report.state).toBe("manual_review");
    expect(report.website).toEqual({ status: "not_verified", url: null });
    expect(report.reason).toMatch(/identity review/);
  });
  test("outdated-site claims are not invented from ordinary extract content", async () => {
    const report = await researchBusiness(lead, mockResearch());
    expect(report.state).toBe("ready");
    expect(JSON.stringify(report)).not.toMatch(/outdated|broken|slow/i);
  });
  test("a good existing website receives only the separately evidenced service pitch", async () => {
    const report = await researchBusiness(lead, mockResearch());
    const fact = report.evidence.find((item) => item.kind === "business_fact")!;
    const draft = renderPersonalizedEmail(lead.name, report, { fact_id: fact.id, competitor_id: null, language: "en" }, approvedOpportunity);
    expect(draft.body).toContain(fact.claim);
    expect(draft.body).toContain(approvedOpportunity.gap_claim);
    expect(draft.suggested_service).toBe(approvedOpportunity.service_name);
    expect(draft.body).not.toMatch(/you have no website|need a new website|outdated/i);
    expect(draft.word_count).toBeLessThanOrEqual(90);
    expect(draft.subjects).toHaveLength(2);
    expect(draft.subjects[0]).toContain("Oak Studio");
    expect(draft.subjects[1]).toContain("appointment booking");
  });
  test("a relevant competitor is included only with extracted website evidence", async () => {
    const report = await researchBusiness(lead, mockResearch({ competitor: true }));
    expect(report.competitors).toHaveLength(1);
    const fact = report.evidence.find((item) => item.kind === "business_fact")!;
    const draft = renderPersonalizedEmail(lead.name, report, { fact_id: fact.id, competitor_id: report.competitors[0].evidence_id, language: "en" }, approvedOpportunity);
    expect(draft.body).toContain("Maple Works");
    expect(draft.body).toContain(report.competitors[0].capability);
    expect(draft.evidence_ids).toContain(report.competitors[0].evidence_id);
    const invented = { ...report, competitors: [{ ...report.competitors[0], capability: "Maple Works has a booking system with guaranteed sales growth." }] };
    expect(() => renderPersonalizedEmail(lead.name, invented, { fact_id: fact.id, competitor_id: report.competitors[0].evidence_id, language: "en" }, approvedOpportunity))
      .toThrow("COMPETITOR_NOT_VERIFIED");
  });
  test("a long but verified comparison is dropped before exceeding the 90-word limit", async () => {
    const report = await researchBusiness(lead, mockResearch({ competitor: true }));
    const fact = report.evidence.find((item) => item.kind === "business_fact")!;
    fact.claim = "Oak Studio creates handcrafted furniture with locally sourced reclaimed wood for family homes and small offices in Pune through a careful design process.";
    const comparison = "Maple Works offers furniture design consultations and custom tables for households and offices in Pune with an online catalogue and ordering guidance.";
    report.competitors[0].capability = comparison;
    report.evidence.find((item) => item.id === report.competitors[0].evidence_id)!.claim = comparison;
    const draft = renderPersonalizedEmail(lead.name, report, { fact_id: fact.id, competitor_id: report.competitors[0].evidence_id, language: "en" },
      { ...approvedOpportunity, gap_claim: "Oak Studio asks customers to call for workshop appointments and does not publish a direct appointment request form for these sessions." });
    expect(draft.word_count).toBeLessThanOrEqual(90);
    expect(draft.body).not.toContain("Maple Works");
    expect(draft.evidence_ids).toEqual([fact.id]);
  });
  test("a directory-like competitor hit or page without the business name is excluded", async () => {
    const base = mockResearch({ competitor: true });
    const adapter: SearchAdapter = { search: async (query, limit) => query.startsWith("furniture")
      ? [{ title: "Maple Works", url: "https://maple.example.org/", content: "Furniture in Pune", score: 0.9 },
        { title: "Top furniture businesses", url: "https://directory.example.org/", content: "Pune", score: 0.8 }]
      : base.search(query, limit),
    extract: async (urls) => urls.map((url) => ({ url, raw_content: url === official ? ownContent : "Furniture businesses in Pune." })) };
    const report = await researchBusiness(lead, adapter);
    expect(report.competitors).toHaveLength(0);
  });
  test("no reliable competitor omits comparison", async () => {
    const report = await researchBusiness(lead, mockResearch());
    expect(report.competitors).toHaveLength(0);
    const fact = report.evidence.find((item) => item.kind === "business_fact")!;
    expect(renderPersonalizedEmail(lead.name, report, { fact_id: fact.id, competitor_id: null, language: "hinglish" }, approvedOpportunity).body).not.toContain("Maple Works");
    expect(() => renderPersonalizedEmail(lead.name, report, { fact_id: fact.id, competitor_id: crypto.randomUUID(), language: "en" }, approvedOpportunity)).toThrow("COMPETITOR_NOT_VERIFIED");
  });
  test("insufficient public information blocks drafting", async () => {
    const report = await researchBusiness(lead, mockResearch({ content: "Oak Studio. Welcome." }));
    expect(report.state).toBe("manual_review");
    expect(() => renderPersonalizedEmail(lead.name, report, { fact_id: crypto.randomUUID(), competitor_id: null, language: "en" }, approvedOpportunity)).toThrow("RESEARCH_REVIEW_REQUIRED");
  });
  test("conflicting website identity blocks personalization", async () => {
    const report = await researchBusiness(lead, mockResearch({ content: "Different Business creates kitchen tables." }));
    expect(report.website.status).toBe("not_verified");
    expect(report.state).toBe("manual_review");
  });
  test("untrusted selection cannot introduce unsupported facts", async () => {
    const report = await researchBusiness(lead, mockResearch());
    expect(() => renderPersonalizedEmail(lead.name, report, { fact_id: crypto.randomUUID(), competitor_id: null, language: "en" }, approvedOpportunity)).toThrow("FACT_NOT_EVIDENCED");
    expect(() => renderPersonalizedEmail(lead.name, report, { fact_id: report.evidence.find((item) => item.kind === "business_fact")!.id, competitor_id: null, language: "en" }, { ...approvedOpportunity, gap_claim: "" })).toThrow();
  });
  test("mock Groq selects only stored IDs and settles usage before a review draft", async () => {
    const report = await researchBusiness(lead, mockResearch({ competitor: true }));
    const fact = report.evidence.find((item) => item.kind === "business_fact")!;
    const competitor = report.competitors[0];
    const reserve = vi.fn(async () => "reservation-1");
    const settle = vi.fn(async () => {});
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.messages[0].content).toContain("Choose exactly one supplied business_fact ID");
      expect(request.messages[1].content).toContain(fact.id);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ fact_id: fact.id, competitor_id: competitor.evidence_id, language: "en" }) } }], usage: { prompt_tokens: 42, completion_tokens: 18 } });
    });
    const ai = new StructuredAI({ provider: "groq", apiKey: "mock-only", model: "openai/gpt-oss-120b", freeTierApproved: true, maxTokens: 220, timeoutMs: 1000 }, { reserve, settle }, transport, undefined,
      "Choose exactly one supplied business_fact ID and optionally one supplied verified competitor ID. Return JSON {fact_id,competitor_id,language}.");
    const selection = await ai.generate(personalizedSelectionSchema, { facts: [{ id: fact.id, quote: fact.claim }], competitors: [{ id: competitor.evidence_id, name: competitor.name }], language: "en" });
    const draft = renderPersonalizedEmail(lead.name, report, selection.data, approvedOpportunity);
    expect(draft.evidence_ids).toEqual([fact.id, competitor.evidence_id]);
    expect(draft.word_count).toBeLessThanOrEqual(90);
    expect(transport).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith("reservation-1", { input: 42, output: 18, status: "completed" });
  });
  test("ten synthetic businesses yield distinct drafts tied only to their own evidence", async () => {
    const drafts: string[] = [];
    for (let index = 1; index <= 10; index++) {
      const name = `Studio ${index} Furniture`;
      const url = `https://studio-${index}.example.org/`;
      const content = `${name} makes custom oak tables for homes in Pune. Customers can call to request a workshop appointment.`;
      const report = await researchBusiness({ name, websiteUrl: url, industry: "furniture", market: "Pune" }, {
        search: async () => [{ title: name, url, content, score: 1 }],
        extract: async (urls) => urls.map((page) => ({ url: page, raw_content: content })),
      });
      expect(report.state).toBe("ready");
      const fact = report.evidence.find((item) => item.kind === "business_fact")!;
      const selection = personalizedSelectionSchema.parse({ fact_id: fact.id, competitor_id: null, language: "en" });
      const draft = renderPersonalizedEmail(name, report, selection, {
        ...approvedOpportunity, gap_claim: `${name} asks customers to call for workshop appointments.`,
      });
      expect(fact.url).toBe(url);
      expect(draft.evidence_ids).toEqual([fact.id]);
      expect(draft.body).toContain(name);
      expect(draft.word_count).toBeLessThanOrEqual(90);
      drafts.push(draft.body);
    }
    expect(new Set(drafts).size).toBe(10);
    for (let index = 0; index < drafts.length; index++)
      for (let other = 0; other < drafts.length; other++)
        if (index !== other) expect(drafts[index]).not.toContain(`Studio ${other + 1} Furniture`);
  });
});
