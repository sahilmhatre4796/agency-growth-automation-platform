// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { leadInput } from "../packages/shared/crm";
import type { Detail, RecordLead } from "../apps/web/lib/crm-store";

const state = vi.hoisted(() => ({ leads: [] as unknown[], details: {} as Record<string, unknown> }));
vi.mock("../apps/web/lib/crm-store", () => ({ crmStore: () => ({
  list: async () => state.leads,
  detail: async (id: string) => state.details[id],
}) }));
vi.mock("../apps/web/components/india-manual-calling-queue", () => ({ IndiaManualCallingQueue: () => null }));
import { CRM } from "../apps/web/components/crm";

afterEach(cleanup);

function lead(id: string, name: string, email: string, website = "", city = "Modesto"): RecordLead {
  return { ...leadInput.parse({ business_name: name, city, state_region: "California", country: "USA", website_url: website, status: "researching" }),
    id, email, needs: website ? "Existing website; automation use case remains exploratory." : "Research hold; pending owner review. Conditional professional website opportunity only; no confirmed need or service gap.",
    public_address: website ? null : id === "divine" ? "1100 Carver Rd" : "1012 N Carpenter Rd", is_demo: false, created_at: "2026-10-26T00:00:00Z", deal_value_paise: null };
}

function detail(email: string, phone: string, assessment: Detail["websiteAssessment"]): Detail {
  return { websiteAssessment: assessment,
    contacts: [
      { id: "email", email, phone_e164: null, contact_name: null, role: null, source_url: "https://explore.overturemaps.org/", verified_at: null },
      { id: "phone", email: null, phone_e164: phone, contact_name: null, role: null, source_url: "https://directory.example/business", verified_at: null },
    ],
    publicContacts: [], publicContactSources: [], notes: [], tasks: [], scores: [], activity: [],
    evidence: [{ id: "evidence", claim: "Public listing names this business and location.", source_url: "https://directory.example/business", observed_at: "2026-10-26T00:00:00Z", confidence: 0.7, reviewed: false, kind: "observation" }],
  };
}

test.each([
  ["wilson", "Wilson Welding Works", "wilsonwelding@example.com", "+1555010004"],
  ["divine", "Divine Creations Printing", "divinecreationsprinting@example.com", "+1555010008"],
])("%s shows unknown website, conditional service and pending contact/evidence review", async (id, name, email, phone) => {
  state.leads = [lead(id, name, email)];
  state.details = { [id]: detail(email, phone, { status: "UNKNOWN", official_url: null, reason: "No independently verified official website discovered.", observed_at: "2026-10-26T00:00:00Z" }) };
  render(<CRM demo={false} orgId="synthetic-org" role="admin" onChange={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  const review = await screen.findByRole("region", { name: "Website and service review" });
  expect(within(review).getByText(/Website assessment: UNKNOWN/)).toBeTruthy();
  expect(within(review).getByText(/No independently verified official website discovered/)).toBeTruthy();
  expect(within(review).getByText(/Conditional professional website opportunity/)).toBeTruthy();
  expect(within(review).getByText(/1 evidence item\(s\) pending owner review/)).toBeTruthy();
  expect(screen.getByText(id === "divine" ? /1100 Carver Rd/ : /1012 N Carpenter Rd/)).toBeTruthy();
  expect(screen.getByText(email)).toBeTruthy();
  expect(screen.getByText(/Mailbox verification not recorded/)).toBeTruthy();
  expect(screen.getByText(phone)).toBeTruthy();
  expect(screen.getByText(/Pending owner review · observation/)).toBeTruthy();
  expect(screen.queryByText(/Reviewed CRM contact/)).toBeNull();
  expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
});

test("confirmed official website remains visible with its saved working assessment", async () => {
  const website = "https://archplumbinginc.com/";
  state.leads = [lead("working", "Arch Plumbing Inc.", "service@archplumbinginc.com", website, "San Francisco")];
  state.details = { working: detail("service@archplumbinginc.com", "+1555010011", { status: "WORKING", official_url: website, reason: "Reviewed official site responds successfully.", observed_at: "2026-10-26T00:00:00Z" }) };
  render(<CRM demo={false} orgId="synthetic-org" role="admin" onChange={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Arch Plumbing Inc." }));
  const review = await screen.findByRole("region", { name: "Website and service review" });
  expect(within(review).getByText(/Website assessment: WORKING/)).toBeTruthy();
  expect(within(review).getByRole("link", { name: website }).getAttribute("href")).toBe(website);
});
