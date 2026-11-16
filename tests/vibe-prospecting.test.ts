import { describe, expect, it } from "vitest";
import { classifyLeadOpportunity, extractPublicDecisionMakers, groundedVibeModelFilters, industryMatches, leadTargets, opportunityPriority, parseVibeRequest, websiteServiceLabel } from "../packages/server/vibe-prospecting.ts";

describe("Vibe Prospecting request interpretation", () => {
  it("shows the requested count, market, role, and service criterion before search", () => {
    expect(parseVibeRequest("Find 100 jewellery businesses in Surat that need e-commerce websites. Get the business owner's name and public business email.")).toMatchObject({
      mode: "discover_new", industry: "jewellery", city: "Surat", requested_count: 100,
      decision_maker_role: "owner", website_criterion: "ecommerce_opportunity",
      require_public_email: false,
      needs_review: ["Country is unconfirmed for this city; select India manually if intended."],
    });
    expect(parseVibeRequest("Find 50 construction businesses in Mumbai with missing or broken websites and identify their directors.")).toMatchObject({
      industry: "construction", city: "Mumbai", requested_count: 50,
      decision_maker_role: "director", website_criterion: "missing_or_broken",
    });
  });

  it("requires review of ambiguous filters and rejects unbounded batches", () => {
    expect(parseVibeRequest("Find jewellery businesses with a public email address.").needs_review).toContain("Specify the city or geographic market.");
    expect(() => parseVibeRequest("Find 600 jewellery businesses in Surat with email.")).toThrow("PROSPECT_COUNT_OUT_OF_RANGE");
  });

  it("recognizes a direct plural business type and public email requirement", () => {
    expect(parseVibeRequest("Find dentists in Mumbai with public emails and missing websites")).toMatchObject({
      mode: "discover_new", industry: "dentists", city: "Mumbai",
      website_criterion: "missing_or_broken", require_public_email: true,
      needs_review: ["Country is unconfirmed for this city; select India manually if intended.",
        "Prospect count defaulted to 10; confirm it before searching."],
    });
  });
  it("keeps the city when an email-search instruction follows the market", () => {
    expect(parseVibeRequest("Find 50 jewellery businesses in Surat and find their Gmail/business emails")).toMatchObject({
      mode: "discover_new", industry: "jewellery", city: "Surat", requested_count: 50,
      needs_review: ["Country is unconfirmed for this city; select India manually if intended."],
    });
  });

  it("accepts a grounded Groq proposal but rejects invented counts and service gaps", () => {
    const request = "Find 20 jewellery businesses in Surat, India with public email addresses.";
    const proposal = { mode: "discover_new", industry: "jewellery", city: "Surat", country: "India", requested_count: 20,
      decision_maker_role: null, website_criterion: "any", require_public_email: true };
    expect(groundedVibeModelFilters(request, proposal)).toMatchObject(proposal);
    expect(() => groundedVibeModelFilters(request, { ...proposal, requested_count: 10 })).toThrow("UNGROUNDED_PROSPECT_FILTER");
    expect(() => groundedVibeModelFilters(request, { ...proposal, website_criterion: "missing_or_broken" })).toThrow("UNGROUNDED_PROSPECT_FILTER");
    expect(() => groundedVibeModelFilters(request, { ...proposal, decision_maker_role: "CEO" })).toThrow("UNGROUNDED_PROSPECT_FILTER");
    expect(() => groundedVibeModelFilters(request, { ...proposal, mode: "enrich_existing" })).toThrow("UNGROUNDED_PROSPECT_FILTER");
  });

  it("keeps the owner's first-priority market when a model interprets multiple countries", () => {
    const request = "Find 10 dental businesses in Austin, United States and Australia with public email addresses.";
    const proposal = { mode: "discover_new", industry: "dental", city: "Austin", country: "United States",
      requested_count: 10, decision_maker_role: null, website_criterion: "any", require_public_email: true };
    expect(groundedVibeModelFilters(request, proposal).country).toBe("United States");
    expect(() => groundedVibeModelFilters(request, { ...proposal, country: "Australia" })).toThrow("UNGROUNDED_PROSPECT_FILTER");
  });

  it("selects existing CRM enrichment without requiring a website or industry", () => {
    expect(parseVibeRequest("Find emails for these 100 businesses discovered by Serper and Harvey; cross-check all existing emails.")).toMatchObject({
      mode: "enrich_existing", requested_count: 100, industry: null, city: null, needs_review: [],
    });
    expect(parseVibeRequest("Find emails for these businesses discovered in my CRM")).toMatchObject({
      mode: "enrich_existing", industry: null, city: null,
    });
  });
});

describe("unified website and automation lead targets", () => {
  it("allocates deterministic 70/30 targets and handles single-category requests", () => {
    expect(leadTargets(10)).toEqual({ website: 7, automation: 3 });
    expect(leadTargets(50)).toEqual({ website: 35, automation: 15 });
    expect(leadTargets(11)).toEqual({ website: 8, automation: 3 });
    expect(leadTargets(30, 70, "automation")).toEqual({ website: 0, automation: 30 });
    expect(() => leadTargets(501)).toThrow("INVALID_LEAD_TARGET");
  });

  it("interprets a broad market request and automation-only request without inventing an industry", () => {
    expect(parseVibeRequest("Find 100 business leads in Mumbai using ChainCraft's 70/30 strategy. Find genuine emails and recommend services.")).toMatchObject({
      requested_count: 100, city: "Mumbai", industry: null, lead_category: "mixed", website_percent: 70,
    });
    expect(parseVibeRequest("Find 30 automation leads in Delhi with existing websites and public emails.")).toMatchObject({
      requested_count: 30, city: "Delhi", lead_category: "automation",
    });
    expect(parseVibeRequest("Find 50 businesses in Pune using my default 70/30 lead strategy.")).toMatchObject({
      requested_count: 50, city: "Pune", industry: null, lead_category: "mixed", website_percent: 70,
    });
    expect(parseVibeRequest("Find 100 prospects in Delhi. Prioritize construction companies for website development and clinics for automation.")).toMatchObject({
      requested_count: 100, city: "Delhi", lead_category: "mixed", website_industries: ["construction"], automation_industries: ["clinics"],
    });
    expect(parseVibeRequest("Find 50 jewellery businesses in Surat and cross-check their public email addresses.")).toMatchObject({
      mode: "discover_new", requested_count: 50, city: "Surat",
    });
  });

  it("keeps website and automation industry preferences separate", () => {
    const filters = parseVibeRequest("Find 100 prospects in Delhi. Prioritize construction companies for website development and clinics/hotels for automation.");
    expect(filters.website_industries).toEqual(["construction"]);
    expect(filters.automation_industries).toEqual(["clinics", "hotels"]);
    expect(industryMatches("Construction contractor", filters.website_industries)).toBe(true);
    expect(industryMatches("Dental clinics", filters.automation_industries)).toBe(true);
    expect(industryMatches("Construction contractor", filters.automation_industries)).toBe(false);
  });

  it("never infers a missing website from an empty URL or an automation gap from industry alone", () => {
    expect(classifyLeadOpportunity({ website_url: null, assessment_status: null, matches: [] }).category).toBe("unclassified");
    expect(classifyLeadOpportunity({ website_url: "https://clinic.example", assessment_status: "WORKING", matches: [] }).category).toBe("unclassified");
  });

  it("counts reviewed website and automation evidence in separate categories", () => {
    const website = classifyLeadOpportunity({ website_url: null, assessment_status: "NO_OFFICIAL_WEBSITE_DISCOVERED", matches: [
      { service_key: "service_01", status: "verified_gap", reason: "Reviewed searches found no official website", evidence_ids: ["e1"], confidence: 0.8 },
    ] });
    expect(website).toMatchObject({ category: "website", qualified: true });
    const automation = classifyLeadOpportunity({ website_url: "https://clinic.example", assessment_status: "WORKING", matches: [
      { service_key: "service_09", status: "verified_gap", reason: "Reviewed booking workflow", evidence_ids: ["e2"], confidence: 0.8 },
    ] });
    expect(automation).toMatchObject({ category: "automation", qualified: true });
    expect(classifyLeadOpportunity({ website_url: "https://clinic.example", assessment_status: "WORKING", matches: [
      { service_key: "service_09", status: "research_needed", reason: "Could suit a reception workflow", evidence_ids: ["e2"], confidence: 0.4 },
    ] })).toMatchObject({ category: "automation", qualified: false, qualification_status: "hypothesis_needs_research" });
    expect(classifyLeadOpportunity({ website_url: "https://clinic.example", assessment_status: "WORKING", matches: [
      { service_key: "service_15", status: "research_needed", reason: "Published appointment page describes a manual booking request workflow", evidence_ids: ["e2"], confidence: 0.72 },
    ] })).toMatchObject({ category: "automation", qualified: false, qualification_status: "potential_needs_discovery_call" });
  });
  it("ranks categories on their own reviewed match, evidence and contacts", () => {
    const evidence = { match_confidence: 0.8, reviewed_evidence_count: 2, has_sourced_email: true, has_sourced_phone: false };
    expect(opportunityPriority({ category: "website", ...evidence })).toBeGreaterThan(0);
    expect(opportunityPriority({ category: "automation", ...evidence })).toBeGreaterThan(0);
    expect(opportunityPriority({ category: "automation", ...evidence, has_sourced_email: false }))
      .toBeLessThan(opportunityPriority({ category: "automation", ...evidence }));
    expect(() => opportunityPriority({ category: "automation", ...evidence, reviewed_evidence_count: 0 }))
      .toThrow("INVALID_OPPORTUNITY_EVIDENCE");
  });
  it("chooses a website subtype only from a confirmed broad business category", () => {
    expect(websiteServiceLabel("Restaurant")).toBe("Restaurant & hospitality website");
    expect(websiteServiceLabel("Jewellery retail")).toBe("Premium jewellery business website");
    expect(websiteServiceLabel("Construction contractor")).toBe("Company portfolio website");
    expect(websiteServiceLabel(null)).toBe("Professional business website");
  });
});

describe("official-site decision-maker evidence", () => {
  const base = { business_name: "Aster Jewellery", official_page_url: "https://aster.example/about", observed_at: "2026-10-21T00:00:00.000Z" };

  it("associates a public business Gmail address only on the same line as a named role", () => {
    const found = extractPublicDecisionMakers({ ...base, public_page_text: "Priya Shah — Founder — asterstudio@example.com\nContact: help@aster.example" });
    expect(found).toMatchObject([{ full_name: "Priya Shah", role: "Founder", email: "asterstudio@example.com", email_status: "publicly_sourced", source_url: base.official_page_url }]);
  });

  it("does not assign a general address to an owner when no association appears", () => {
    const found = extractPublicDecisionMakers({ ...base, public_page_text: "Priya Shah — Founder\nGeneral enquiries: contact@aster.example" });
    expect(found).toMatchObject([{ full_name: "Priya Shah", email: null, email_status: "unknown" }]);
  });

  it("rejects ambiguous multi-address association and unsafe source URLs", () => {
    const found = extractPublicDecisionMakers({ ...base, public_page_text: "Founder Priya Shah — priya@example.com or team@aster.example" });
    expect(found[0].email).toBeNull();
    expect(() => extractPublicDecisionMakers({ ...base, official_page_url: "http://127.0.0.1/about", public_page_text: "Founder Priya Shah — priya@example.com" })).toThrow("RESEARCH_URL_NOT_PERMITTED");
  });

  it("returns no invented identity from ordinary contact text", () => {
    expect(extractPublicDecisionMakers({ ...base, public_page_text: "We offer jewellery and online ordering. Email us at contact@aster.example." })).toEqual([]);
  });
});
