export const DEFAULT_DISCOVERY_COUNTRIES = [
  "United States", "Australia", "New Zealand", "United Arab Emirates", "United Kingdom",
] as const;

export const SELECTABLE_DISCOVERY_COUNTRIES = [...DEFAULT_DISCOVERY_COUNTRIES, "India"] as const;
export type DiscoveryCountry = typeof SELECTABLE_DISCOVERY_COUNTRIES[number];

// Sunday-first. These are planning targets, never permission to run a provider.
export const DEFAULT_WEEKLY_COUNTRIES = [
  "United States", "New Zealand", "United Arab Emirates", "Australia",
  "United Kingdom", "United States", "Australia",
] as const satisfies readonly DiscoveryCountry[];
export const DEFAULT_DAILY_TARGETS = { internationalWebsite: 350, internationalAutomation: 150, indiaManual: 100 } as const;

export function weeklyMarketForDate(date: Date, timezone = "Asia/Kolkata", schedule: readonly string[] = DEFAULT_WEEKLY_COUNTRIES) {
  if (Number.isNaN(date.getTime()) || schedule.length !== 7) throw new Error("INVALID_WEEKLY_SCHEDULE");
  const countries = schedule.map((value) => canonicalDiscoveryCountry(value));
  if (countries.some((value) => !value || value === "India")) throw new Error("INVALID_WEEKLY_SCHEDULE");
  let weekday: string;
  try { weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date); }
  catch { throw new Error("INVALID_TIMEZONE"); }
  const index = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(weekday);
  if (index < 0) throw new Error("INVALID_TIMEZONE");
  return { today: countries[index]!, next: countries[(index + 1) % 7]!, weekday, timezone,
    internationalTarget: DEFAULT_DAILY_TARGETS.internationalWebsite + DEFAULT_DAILY_TARGETS.internationalAutomation,
    indiaManualTarget: DEFAULT_DAILY_TARGETS.indiaManual };
}

export function weeklyFallbackMarkets(primary: string, schedule: readonly string[], enabled: boolean, verifiedShortfall: number): DiscoveryCountry[] {
  if (!enabled || !Number.isInteger(verifiedShortfall) || verifiedShortfall < 1) return [];
  const canonical = canonicalDiscoveryCountry(primary);
  if (!canonical || canonical === "India" || schedule.length !== 7) throw new Error("INVALID_WEEKLY_SCHEDULE");
  return [...new Set(schedule.map((value) => canonicalDiscoveryCountry(value)))]
    .filter((value): value is DiscoveryCountry => Boolean(value && value !== "India" && value !== canonical));
}

const aliases: ReadonlyArray<{ country: DiscoveryCountry; pattern: RegExp }> = [
  { country: "United States", pattern: /\b(?:USA|United States(?: of America)?)\b|\bU\.S\.A\./gi },
  { country: "Australia", pattern: /\bAustralia\b/gi },
  { country: "New Zealand", pattern: /\b(?:New Zealand|NZ)\b/gi },
  { country: "United Arab Emirates", pattern: /\b(?:United Arab Emirates|UAE)\b/gi },
  { country: "United Kingdom", pattern: /\b(?:United Kingdom|UK|Great Britain|Britain)\b/gi },
  { country: "India", pattern: /\b(?:India|Bharat)\b/gi },
];

export function canonicalDiscoveryCountry(value: string): DiscoveryCountry | null {
  const text = value.trim();
  if (/^IN$/i.test(text)) return "India";
  return SELECTABLE_DISCOVERY_COUNTRIES.find((country) => country.toLowerCase() === text.toLowerCase())
    ?? aliases.find(({ pattern }) => new RegExp(`^(?:${pattern.source})$`, "i").test(text))?.country ?? null;
}

export function mentionedDiscoveryCountries(text: string): DiscoveryCountry[] {
  const mentions: Array<{ country: DiscoveryCountry; index: number }> = [];
  for (const { country, pattern } of aliases) {
    for (const match of text.matchAll(pattern)) mentions.push({ country, index: match.index });
  }
  return [...new Set(mentions.sort((a, b) => a.index - b.index).map((item) => item.country))];
}

export function orderedDiscoveryCountries(values: string[]): DiscoveryCountry[] {
  if (!values.length || values.length > SELECTABLE_DISCOVERY_COUNTRIES.length) throw new Error("INVALID_DISCOVERY_COUNTRIES");
  const countries = values.map((value) => canonicalDiscoveryCountry(value));
  if (countries.some((country) => !country) || new Set(countries).size !== countries.length)
    throw new Error("INVALID_DISCOVERY_COUNTRIES");
  return countries as DiscoveryCountry[];
}

// A page's target country is a proposal until a public source supports it.
// A place name alone is not country evidence: Austin and Newcastle are not unique.
export function hasUnambiguousCountryEvidence(text: string, country: string): boolean {
  const canonical = canonicalDiscoveryCountry(country);
  if (!canonical) return false;
  const mentions = mentionedDiscoveryCountries(text);
  return mentions.length === 1 && mentions[0] === canonical;
}

const callingCodes: Record<DiscoveryCountry, string> = {
  "United States": "+1", Australia: "+61", "New Zealand": "+64",
  "United Arab Emirates": "+971", "United Kingdom": "+44", India: "+91",
};

// Calling code compatibility is a review signal, never proof of a business's
// physical country or the identity of the person answering the number.
export function phoneCountryCompatibility(value: string, country: string):
  "compatible_calling_code" | "different_calling_code" | "unknown_market" | "invalid_e164" {
  const phone = value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return "invalid_e164";
  const canonical = canonicalDiscoveryCountry(country);
  if (!canonical) return "unknown_market";
  return phone.startsWith(callingCodes[canonical]) ? "compatible_calling_code" : "different_calling_code";
}

export function allocateCountryTargets(total: number, countries: string[]): Array<{ country: DiscoveryCountry; target: number }> {
  const ordered = orderedDiscoveryCountries(countries);
  if (!Number.isInteger(total) || total < 1 || total > 500) throw new Error("INVALID_LEAD_TARGET");
  const weightTotal = ordered.length * (ordered.length + 1) / 2;
  const exact = ordered.map((country, index) => ({ country, exact: total * (ordered.length - index) / weightTotal }));
  const allocation = exact.map(({ country, exact: share }) => ({ country, target: Math.floor(share) }));
  let remainder = total - allocation.reduce((sum, item) => sum + item.target, 0);
  for (const index of exact.map((item, index) => ({ index, fraction: item.exact % 1 }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index).map((item) => item.index)) {
    if (remainder-- <= 0) break;
    allocation[index].target++;
  }
  return allocation;
}
