import { expect, test, vi } from "vitest";
import {
  runJobs,
  type JobStore,
  type LeasedJob,
} from "../packages/server/worker";
const job: LeasedJob = {
  id: "fixture-job",
  org_id: "fixture-org",
  kind: "email.send",
  lease_token: "lease",
  policy_version: "policy-v1",
  payload: {},
};
test("all external kinds suppressed even when workspace reports enabled", async () => {
  const store: JobStore = {
    lease: async () =>
      ["email.send", "whatsapp.send", "calendar.book", "voice.call"].map(
        (kind) => ({ ...job, kind }),
      ),
    paused: vi.fn(async () => false),
    finish: vi.fn(async () => true),
  };
  expect(await runJobs(store, {})).toMatchObject({
    suppressed: 4,
    completed: 0,
  });
  expect(store.paused).toHaveBeenCalledTimes(4);
});
test("unknown tool names and stale policies never execute handlers", async () => {
  const handler = vi.fn(async () => {});
  const store: JobStore = {
    lease: async () => [
      { ...job, kind: "run-shell" },
      { ...job, kind: "notification.create", policy_version: "untrusted" },
    ],
    paused: async () => true,
    finish: vi.fn(async () => true),
  };
  expect(
    await runJobs(store, { "notification.create": handler }),
  ).toMatchObject({ failed: 1, suppressed: 1 });
  expect(handler).not.toHaveBeenCalled();
});
test("transient handler failure requeues using persistent store; no browser timer required", async () => {
  const store: JobStore = {
    lease: async () => [{ ...job, kind: "notification.create" }],
    paused: async () => true,
    finish: vi.fn(async () => true),
  };
  await runJobs(store, {
    "notification.create": async () => {
      throw new Error("fixture unavailable");
    },
  });
  expect(store.finish).toHaveBeenCalledWith(
    expect.anything(),
    "queued",
    "JOB_RETRY_REQUIRED",
  );
});
