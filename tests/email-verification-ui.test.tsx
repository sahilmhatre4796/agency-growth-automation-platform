// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  jobs: [] as Array<{ id: string; contact_id: string; state: string; attempts: number; last_error_code: null; created_at: string }>,
}));

vi.mock("../apps/web/lib/supabase", () => ({
  supabase: {
    rpc: async () => ({ data: { total_checked: 0, valid: 0, invalid: 0, unknown: 0, risky: 0, suppressed: 0, pending: fixture.jobs.length, errors: 0, last_checked_at: null }, error: null }),
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        not: () => query,
        order: () => query,
        limit: async () => ({ data: table === "contacts" ? [{ id: "contact-1", lead_id: "lead-1", email_normalized: "qa@example.invalid" }] : table === "email_verification_jobs" ? fixture.jobs : [], error: null }),
      };
      return query;
    },
  },
}));

import { EmailVerification } from "../apps/web/components/email-verification";

afterEach(() => { cleanup(); fixture.jobs = []; });

test("an unqueued contact can request verification", async () => {
  render(<EmailVerification demo={false} orgId="org-1" role="admin" />);
  expect(await screen.findByRole("button", { name: "Verify eligible batch (1)" })).not.toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("CRM contact"), { target: { value: "contact-1" } });
  expect((screen.getByRole("button", { name: "Verify contact" }) as HTMLButtonElement).disabled).toBe(false);
});

test("an active durable job is not offered for duplicate verification", async () => {
  fixture.jobs = [{ id: "job-1", contact_id: "contact-1", state: "queued", attempts: 0, last_error_code: null, created_at: "2026-10-21T00:00:00Z" }];
  render(<EmailVerification demo={false} orgId="org-1" role="admin" />);
  expect((await screen.findByRole("button", { name: "Verify eligible batch (0)" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("CRM contact"), { target: { value: "contact-1" } });
  expect((screen.getByRole("button", { name: "Verify contact" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Reverify" }) as HTMLButtonElement).disabled).toBe(true);
});
