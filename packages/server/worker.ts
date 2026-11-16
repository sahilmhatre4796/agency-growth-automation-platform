export type LeasedJob = {
  id: string;
  org_id: string;
  kind: string;
  lease_token: string;
  policy_version: string;
  payload: unknown;
};
export interface JobStore {
  lease(limit: number): Promise<LeasedJob[]>;
  paused(orgId: string): Promise<boolean>;
  finish(
    job: LeasedJob,
    state: "completed" | "suppressed" | "queued" | "failed",
    error?: string,
  ): Promise<boolean>;
}
export type SafeHandler = (job: LeasedJob) => Promise<void>;
const outboundKinds = new Set([
  "email.send",
  "whatsapp.send",
  "calendar.book",
  "voice.call",
]);
export async function runJobs(
  store: JobStore,
  handlers: Partial<Record<"notification.create" | "lead.score", SafeHandler>>,
) {
  const jobs = await store.lease(10);
  let completed = 0,
    suppressed = 0,
    failed = 0;
  for (const job of jobs) {
    try {
      // Every attempt reloads current policy. No model chooses executable tools.
      if (job.policy_version !== "policy-v1") {
        await store.finish(job, "suppressed", "STALE_POLICY");
        suppressed++;
        continue;
      }
      if (outboundKinds.has(job.kind)) {
        await store.paused(job.org_id);
        await store.finish(job, "suppressed", "LIVE_OPERATIONS_DISABLED");
        suppressed++;
        continue;
      }
      if (!["notification.create", "lead.score"].includes(job.kind)) {
        await store.finish(job, "failed", "UNKNOWN_JOB_KIND");
        failed++;
        continue;
      }
      const handler =
        handlers[job.kind as "notification.create" | "lead.score"];
      if (!handler) {
        await store.finish(job, "failed", "HANDLER_UNAVAILABLE");
        failed++;
        continue;
      }
      await handler(job);
      if (!(await store.finish(job, "completed")))
        throw new Error("LEASE_LOST");
      completed++;
    } catch {
      await store.finish(job, "queued", "JOB_RETRY_REQUIRED");
      failed++;
    }
  }
  return { leased: jobs.length, completed, suppressed, failed };
}
