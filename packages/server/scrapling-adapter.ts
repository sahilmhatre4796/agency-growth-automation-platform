// Optional Scrapling source: the local Python worker fetches public pages on
// the lead's recorded official domain; this adapter converts its report into
// contact observations. Scrapling is never a search or Maps provider, never
// verifies a mailbox, and its page text is untrusted data, never instructions.
import { z } from "zod";
import {
  extractPublicEmailCandidates,
  extractPublicPhoneCandidates,
  type ContactObservation,
} from "./vibe-contact-enrichment.ts";

export const scraplingPageSchema = z.object({
  url: z.url().startsWith("https://"),
  title: z.string().max(300),
  observed_at: z.iso.datetime({ offset: true }),
  text: z.string().max(100000),
  http_status: z.number().int().min(100).max(599).nullable(),
  discovered_from: z.enum(["seed", "link"]),
}).strict();

export const scraplingReportSchema = z.object({
  scraper: z.literal("scrapling"),
  lead_id: z.uuid(),
  business_name: z.string().min(1).max(200),
  official_url: z.url().startsWith("https://"),
  fetched_at: z.iso.datetime({ offset: true }),
  pages: z.array(scraplingPageSchema).min(1).max(10),
  errors: z.array(z.string().max(300)).max(10).default([]),
}).strict();

export type ScraplingReport = z.infer<typeof scraplingReportSchema>;

export function scraplingEnabled(env: Record<string, string | undefined>): boolean {
  return env.ENABLE_SCRAPLING === "true";
}

const officialHost = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

// Only pages on the recorded official domain may contribute. The report is
// validated first; a forged or off-domain page yields nothing.
export function extractScraplingObservations(report: ScraplingReport, input: {
  lead_id: string; official_url: string; business_name: string;
  env: Record<string, string | undefined>;
}): ContactObservation[] {
  if (!scraplingEnabled(input.env)) return [];
  const parsed = scraplingReportSchema.parse(report);
  if (parsed.lead_id !== input.lead_id || officialHost(parsed.official_url) !== officialHost(input.official_url))
    throw new Error("SCRAPLING_REPORT_IDENTITY_MISMATCH");
  const host = officialHost(input.official_url);
  const observations: ContactObservation[] = [];
  for (const page of parsed.pages) {
    if (officialHost(page.url) !== host) continue;
    const candidates = [
      ...extractPublicEmailCandidates({ source_url: page.url, page_text: page.text,
        observed_at: page.observed_at, business_name: input.business_name, official_domain_confirmed: true }),
      ...extractPublicPhoneCandidates({ source_url: page.url, page_text: page.text,
        observed_at: page.observed_at, business_name: input.business_name, official_domain_confirmed: true }),
    ];
    for (const candidate of candidates)
      observations.push({ ...candidate, lead_id: input.lead_id, source_provider: "scrapling" });
  }
  return observations;
}
