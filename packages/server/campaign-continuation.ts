// Durable campaign continuation (Phase 44).
//
// One owner START arms a whole batch; from then on the work is claimed from the
// queue, not from a browser. This module holds the parts that both the local
// worker and the Edge Function need:
//
//   claimCampaignContinuation  - which armed campaign may run next
//   advanceCampaignBatch       - activate the next combination, or stop the batch
//   runCampaignContinuation    - a bounded loop that keeps the batch moving
//
// The loop is deliberately bounded: no unbounded worker, no unbounded Edge
// Function loop. Every step is one durable page, so a crash, a killed worker or
// a closed browser never loses or duplicates work: the next invocation leases
// the same queued page again (lease + unique (campaign_id, search_page)).

export type ContinuationCampaign = {
  org_id: string;
  campaign_id: string;
  search_page: number;
};

export type ContinuationDb = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

export async function claimCampaignContinuation(
  db: ContinuationDb,
  limit = 1,
): Promise<ContinuationCampaign[]> {
  const { data, error } = await db.rpc("claim_campaign_continuation", { p_limit: limit });
  if (error) throw new Error(`CAMPAIGN_CLAIM_FAILED:${error.message}`);
  return (data ?? []) as ContinuationCampaign[];
}

export async function advanceCampaignBatch(
  db: ContinuationDb,
  orgId: string,
  campaignId: string,
): Promise<string | null> {
  const { data, error } = await db.rpc("advance_campaign_batch", {
    p_org: orgId,
    p_campaign: campaignId,
  });
  if (error) throw new Error(`CAMPAIGN_ADVANCE_FAILED:${error.message}`);
  return typeof data === "string" ? data : null;
}

export type ContinuationBounds = {
  /** Hard cap on processed pages in one worker run. */
  maxPages: number;
  /** Hard wall-clock cap for one worker run (milliseconds). */
  maxDurationMs: number;
  /** Pause between pages so a single worker cannot monopolize the queue. */
  delayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ContinuationStepResult = {
  /** Pages processed by this step. */
  processed: number;
  /** Campaigns that finished and were advanced (or stopped) by this step. */
  advanced?: string[];
  /** True when the step found nothing to do. */
  idle?: boolean;
};

/**
 * Run the bounded continuation loop.
 *
 * `step` performs one durable unit of work (typically: claim an armed campaign,
 * run one page, advance the batch). The loop stops at the first idle step, when
 * the page cap is reached, when the deadline passes, or when a step fails. A
 * failure is reported, never silently swallowed: the caller decides whether to
 * retry, and the queue keeps the unfinished page for the next attempt.
 */
export async function runCampaignContinuation(
  step: () => Promise<ContinuationStepResult>,
  bounds: ContinuationBounds,
): Promise<{ pages: number; advanced: string[]; stoppedBy: "idle" | "page_cap" | "deadline" | "error"; error?: string }> {
  const now = bounds.now ?? (() => Date.now());
  const sleep = bounds.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const advanced: string[] = [];
  let pages = 0;
  for (;;) {
    if (pages >= bounds.maxPages) return { pages, advanced, stoppedBy: "page_cap" };
    if (now() - startedAt >= bounds.maxDurationMs) return { pages, advanced, stoppedBy: "deadline" };
    let result: ContinuationStepResult;
    try {
      result = await step();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { pages, advanced, stoppedBy: "error", error: message };
    }
    if (result.idle || result.processed === 0) return { pages, advanced, stoppedBy: "idle" };
    pages += result.processed;
    advanced.push(...(result.advanced ?? []));
    if (bounds.delayMs && bounds.delayMs > 0) await sleep(bounds.delayMs);
  }
}
