// Campaign continuation worker (Phase 44): keeps an armed batch moving while
// no browser is open.
//
// The worker does not execute pages itself. The Edge Function owns the page
// execution (lease -> reserve credits -> search -> ingest -> finish -> advance)
// and keeps all durable state in Postgres, so this worker is only a bounded
// dispatcher: it asks the function to process the next queued page and stops
// when the queue is empty, the page cap is reached or the deadline passes.
//
// Fail-closed: disabled unless ENABLE_CAMPAIGN_CONTINUATION is explicitly
// "true". No provider is enabled and no credit is spent by this file.
//
//   npm run worker:campaign-continuation
import { runCampaignContinuation } from "../packages/server/campaign-continuation.ts";

const MAX_PAGES = Number(process.env.CAMPAIGN_CONTINUATION_MAX_PAGES ?? "20");
const MAX_DURATION_MS = Number(process.env.CAMPAIGN_CONTINUATION_MAX_DURATION_MS ?? "600000");
const DELAY_MS = Number(process.env.CAMPAIGN_CONTINUATION_DELAY_MS ?? "2000");

type WorkerResponse = {
  processed?: number;
  completed?: number;
  failed?: number;
  campaigns_advanced?: string[];
  error?: string;
};

async function requestPage(url: string, secret: string): Promise<WorkerResponse> {
  const response = await fetch(`${url}/functions/v1/serper-discovery-jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cron-Signature": secret,
    },
    body: JSON.stringify({ mode: "campaign" }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: WorkerResponse = {};
  try {
    body = text ? (JSON.parse(text) as WorkerResponse) : {};
  } catch {
    throw new Error(`WORKER_UNREADABLE_RESPONSE:${response.status}`);
  }
  if (response.status === 503) {
    // Discovery disabled or not configured: nothing to do, not a failure.
    return { processed: 0, error: body.error ?? "DISCOVERY_DISABLED" };
  }
  if (!response.ok) {
    throw new Error(`WORKER_HTTP_${response.status}:${body.error ?? text.slice(0, 120)}`);
  }
  return body;
}

export function createContinuationWorker(options: {
  url: string;
  secret: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const step = async () => {
    const body = await requestPage(options.url, options.secret);
    return {
      processed: body.processed ?? 0,
      advanced: body.campaigns_advanced ?? [],
      idle: (body.processed ?? 0) === 0,
    };
  };
  return runCampaignContinuation(step, {
    maxPages: MAX_PAGES,
    maxDurationMs: MAX_DURATION_MS,
    delayMs: DELAY_MS,
    sleep: options.sleep,
    now: options.now,
  });
}

if (import.meta.main) {
  if (process.env.ENABLE_CAMPAIGN_CONTINUATION !== "true") {
    throw new Error("CAMPAIGN_CONTINUATION_DISABLED");
  }
  const url = process.env.SUPABASE_URL;
  const secret = process.env.INTERNAL_CRON_SECRET ?? "";
  if (!url || secret.length < 32) throw new Error("CAMPAIGN_CONTINUATION_CONFIG_REQUIRED");
  const result = await createContinuationWorker({ url, secret });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.stoppedBy === "error") process.exit(1);
}
