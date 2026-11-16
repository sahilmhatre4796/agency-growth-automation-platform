// Conservative publisher grouping: a shared hosting suffix may hold unrelated
// sites, but counting those sites as one source cannot fabricate corroboration.
const compoundSuffixes = new Set([
  "ac.uk", "co.uk", "gov.uk", "org.uk", "com.au", "gov.au", "net.au", "org.au",
  "co.nz", "govt.nz", "org.nz", "co.in", "com.ae", "gov.ae",
]);

export function sourceAuthority(input: string): string {
  const host = new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  const count = compoundSuffixes.has(labels.slice(-2).join(".")) ? 3 : 2;
  // shortcut: unknown compound public suffixes may undercount independent sites;
  // use a maintained public-suffix list if that blocks real corroboration.
  return labels.slice(-count).join(".");
}
