export type WebsiteCheckSignal = {
  signal: "reachable" | "repeated_server_error_review" | "uncertain";
  supportingIds: string[];
};

// Transport observations can prioritize an owner's review, never qualify a
// service. A 2xx response says the site answered, not that it is adequate.
export function websiteCheckSignal(
  observations: Array<{ id: string; checked_url: string; checked_at: string; outcome: string; http_status: number | null }>,
  officialUrl: string | null,
  now = Date.now(),
): WebsiteCheckSignal {
  if (!officialUrl) return { signal: "uncertain", supportingIds: [] };
  const recent = observations.filter((item) => {
    const time = new Date(item.checked_at).getTime();
    return item.checked_url === officialUrl && Number.isFinite(time) && time <= now && time >= now - 30 * 86400000;
  }).sort((a, b) => new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime());
  const latest = recent[0];
  if (!latest) return { signal: "uncertain", supportingIds: [] };
  if (latest.outcome === "ok" && latest.http_status !== null && latest.http_status >= 200 && latest.http_status < 300)
    return { signal: "reachable", supportingIds: [latest.id] };
  if (latest.outcome !== "http_5xx" || latest.http_status === null || latest.http_status < 500 || latest.http_status > 599)
    return { signal: "uncertain", supportingIds: [] };
  const before = recent.slice(1);
  const previous = before.find((item) => item.outcome === "http_5xx" && item.http_status !== null && item.http_status >= 500 && item.http_status <= 599 &&
    new Date(latest.checked_at).getTime() - new Date(item.checked_at).getTime() >= 86400000);
  if (!previous) return { signal: "uncertain", supportingIds: [] };
  const between = before.filter((item) => new Date(item.checked_at).getTime() > new Date(previous.checked_at).getTime());
  if (between.some((item) => item.outcome !== "http_5xx")) return { signal: "uncertain", supportingIds: [] };
  return { signal: "repeated_server_error_review", supportingIds: [previous.id, latest.id] };
}
