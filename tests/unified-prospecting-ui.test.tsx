// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const data = vi.hoisted(() => {
  const now = "2026-10-22T00:00:00.000Z";
  return {
    leads: [
      { id: "web", business_name: "Synthetic Corner Cafe", business_category: "restaurant", city: "Pune", country: "India", website_url: null, source_type: "harvey", status: "new" },
      { id: "auto", business_name: "Synthetic Clinic", business_category: "clinic", city: "Pune", country: "India", website_url: "https://clinic.example", source_type: "serper", status: "new" },
      { id: "potential", business_name: "Synthetic Coaching", business_category: "coaching", city: "Pune", country: "India", website_url: "https://coaching.example", source_type: "serper", status: "new" },
      { id: "unknown", business_name: "Synthetic Unreviewed", business_category: "clinic", city: "Pune", country: "India", website_url: null, source_type: "harvey", status: "new" },
    ],
    contacts: [], business_research_reports: [], consent_records: [], personalized_email_drafts: [],
    lead_website_assessments: [
      { lead_id: "web", status: "NO_OFFICIAL_WEBSITE_DISCOVERED", reason: "Reviewed searches found no official site", observed_at: now },
      { lead_id: "auto", status: "WORKING", reason: "Official site loads", observed_at: now },
      { lead_id: "potential", status: "WORKING", reason: "Official site loads", observed_at: now },
    ],
    lead_qualifications: [], email_verification_records: [],
    discovery_targeting: { serper_discovery_enabled: false, vibe_contact_discovery_enabled: false, max_new_prospects: 0 },
    organizations: { research_monthly_credit_cap: 0 }, research_credit_usage: [],
    service_catalog: [
      { id: "website-service", service_key: "service_01", name: "Premium business websites" },
      { id: "reception-service", service_key: "service_09", name: "AI receptionists" },
      { id: "booking-service", service_key: "service_15", name: "Appointment and booking systems" },
    ],
    lead_service_matches: [
      { lead_id: "web", service_id: "website-service", status: "verified_gap", reason: "Owner reviewed two public website searches", evidence_ids: ["web-evidence"], confidence: 0.8, assessed_at: now },
      { lead_id: "auto", service_id: "reception-service", status: "verified_gap", reason: "Owner reviewed published appointment workflow", evidence_ids: ["auto-evidence"], confidence: 0.75, assessed_at: now },
      { lead_id: "potential", service_id: "booking-service", status: "research_needed", reason: "Published consultation page describes a booking request workflow", evidence_ids: ["potential-evidence"], confidence: 0.72, assessed_at: now },
    ],
    lead_evidence: [
      { id: "web-evidence", lead_id: "web", source_url: "https://directory.example/cafe", claim: "Public listing for cafe", observed_at: now, reviewed_by: "owner" },
      { id: "auto-evidence", lead_id: "auto", source_url: "https://clinic.example/appointments", claim: "Published appointment workflow", observed_at: now, reviewed_by: "owner" },
      { id: "potential-evidence", lead_id: "potential", source_url: "https://coaching.example/consultations", claim: "Published consultation request", observed_at: now, reviewed_by: "owner" },
    ],
    discovery_runs: [], discovery_campaigns: [], lead_discovery_sources: [], discovery_candidates: [], vibe_contact_points: [
      { id: "unknown-email", lead_id: "unknown", kind: "email", normalized_value: "hello@unreviewed.example", display_value: "hello@unreviewed.example", email_type: "business", contact_name: null, role: null, review_status: "pending", preferred: false, last_cross_checked_at: now },
    ], vibe_contact_sources: [
      { id: "unknown-source", point_id: "unknown-email", source_provider: "official_website", source_url: "https://unreviewed.example/contact", evidence_excerpt: "hello@unreviewed.example", observed_at: now, confidence: 0.8 },
    ], vibe_contact_discovery_jobs: [],
  };
});

vi.mock("../apps/web/lib/supabase", () => ({ supabase: {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: "owner" } }, error: null }) },
  from(table: string) {
    const value = (data as Record<string, unknown>)[table];
    if (value === undefined) throw new Error(`Unexpected table ${table}`);
    const result = () => Promise.resolve({ data: value, error: null });
    const builder = { select: () => builder, eq: () => builder, order: () => builder, limit: result,
      insert: (payload: Record<string, unknown>) => ({ select: () => ({ single: () => {
        (data as Record<string, unknown>)[table] = payload;
        return Promise.resolve({ data: { org_id: payload.org_id }, error: null });
      } }) }),
      maybeSingle: result, single: result };
    return builder;
  },
} }));

import { VibeProspecting } from "../apps/web/components/vibe-prospecting";
afterEach(() => cleanup());

test("India research has no 70/30 quota and keeps unsupported opportunities on hold", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prospect request" }), { target: { value: "Find 10 businesses in Pune, India using my default 70/30 lead strategy." } });
    fireEvent.click(screen.getByRole("button", { name: "Interpret request locally" }));
    expect(screen.getByText(/India manual-calling research has no 70\/30 service quota/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    expect(await screen.findByText(/Evidence-supported website opportunities: 1 · Evidence-supported automation opportunities: 1/)).toBeTruthy();
    const websitePanel = screen.getByRole("heading", { name: "Website development leads" }).closest("section")!;
    expect(within(websitePanel).getByText("Synthetic Corner Cafe")).toBeTruthy();
    expect(within(websitePanel).queryByText("Synthetic Clinic")).toBeNull();
    const contactsPanel = screen.getByRole("heading", { name: "Contact research" }).closest("section")!;
    expect(within(contactsPanel).getByText("Synthetic Unreviewed")).toBeTruthy();
    expect(within(contactsPanel).getByText("hello@unreviewed.example")).toBeTruthy();
    expect(within(within(contactsPanel).getByRole("row", { name: /Synthetic Unreviewed/ }))
      .getByText("Service gap unreviewed")).toBeTruthy();
    expect(within(contactsPanel).getByText(/official_website: 1 sourced, 1 sole-source, 0 cross-source/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /AI & automation/ }));
    expect(within(websitePanel).getByText("Synthetic Clinic")).toBeTruthy();
    expect(within(websitePanel).queryByText("Synthetic Coaching")).toBeNull();
    expect(within(websitePanel).getByText(/1 automation hypotheses still need owner service-gap review/)).toBeTruthy();
    expect(within(websitePanel).queryByText("Synthetic Unreviewed")).toBeNull();
    fireEvent.click(within(within(contactsPanel).getByRole("row", { name: /Synthetic Unreviewed/ })).getByRole("button", { name: "Review evidence" }));
    expect(screen.getByRole("heading", { name: "Synthetic Unreviewed · contact review" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Lead-to-draft review" })).toBeTruthy();
    expect(screen.getByText(/Sourced email awaits contact review/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Advance eligible steps" }));
    expect(await screen.findByText(/BUSINESS IDENTITY REVIEW REQUIRED/)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

test("stored discovery finds unreviewed source categories but excludes disqualified titles", async () => {
  const leads = data.leads as unknown as Array<Record<string, unknown>>;
  const discoverySources = data.lead_discovery_sources as unknown as Array<Record<string, unknown>>;
  leads.push(
    { id: "listing", business_name: "Synthetic Listing", business_category: null, city: "Pune", country: "India", website_url: null, source_type: "serper", status: "researching" },
    { id: "rejected", business_name: "Synthetic Rejected", business_category: null, city: "Pune", country: "India", website_url: null, source_type: "serper", status: "disqualified" },
  );
  discoverySources.push(
    { lead_id: "listing", discovery_run_id: "run-1", proposed_category: "textiles" },
    { lead_id: "rejected", discovery_run_id: "run-1", proposed_category: "textiles" },
  );
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prospect request" }), { target: { value: "Find 10 businesses in Pune, India." } });
    fireEvent.click(screen.getByRole("button", { name: "Interpret request locally" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Industry" }), { target: { value: "textiles" } });
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    expect(await screen.findByText(/Screened stored Indian businesses: 1/)).toBeTruthy();
    const contactsPanel = screen.getByRole("heading", { name: "Contact research" }).closest("section")!;
    expect(within(contactsPanel).getByText("Synthetic Listing")).toBeTruthy();
    expect(within(contactsPanel).queryByText("Synthetic Rejected")).toBeNull();
  } finally {
    leads.splice(leads.findIndex((lead) => lead.id === "listing"), 1);
    leads.splice(leads.findIndex((lead) => lead.id === "rejected"), 1);
    discoverySources.splice(0);
  }
});

test("contact research retains sourced CRM phones without claiming Vibe enrichment", async () => {
  const contacts = data.contacts as unknown as Array<Record<string, unknown>>;
  contacts.push({ id: "crm-phone", lead_id: "unknown", contact_name: null, role: null,
    email_normalized: null, phone_e164: "+1555010006", source_url: "https://directory.example/contact" });
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prospect request" }), { target: { value: "Find 10 businesses in Pune, India." } });
    fireEvent.click(screen.getByRole("button", { name: "Interpret request locally" }));
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    const panel = (await screen.findByRole("heading", { name: "Contact research" })).closest("section")!;
    const row = within(panel).getByRole("row", { name: /Synthetic Unreviewed/ });
    expect(within(row).getByText("+1555010006")).toBeTruthy();
    expect(within(row).getByText(/1 Vibe points · 1 CRM contacts with sources/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Review evidence" }));
    expect(screen.getByText(/CRM-recorded phone: \+1555010006 · source not yet cross-checked in Vibe/)).toBeTruthy();
  } finally { contacts.splice(contacts.findIndex((entry) => entry.id === "crm-phone"), 1); }
});

test("sourced CRM contacts remain searchable when Vibe has no contact point", async () => {
  const leads = data.leads as unknown as Array<Record<string, unknown>>;
  const contacts = data.contacts as unknown as Array<Record<string, unknown>>;
  leads.push({ id: "crm-only", business_name: "Synthetic Supplier", business_category: "supplier",
    city: "Pune", country: "India", website_url: null, source_type: "harvey", status: "researching" });
  contacts.push({ id: "crm-sourced", lead_id: "crm-only", email_normalized: "hello@supplier.example",
    phone_e164: "+1555010007", source_url: "https://directory.example/supplier" });
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prospect request" }), { target: { value: "Find 10 businesses in Pune, India." } });
    fireEvent.click(screen.getByRole("button", { name: "Interpret request locally" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Require a sourced public email" }));
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    const panel = (await screen.findByRole("heading", { name: "Contact research" })).closest("section")!;
    expect(within(panel).getByRole("row", { name: /Synthetic Supplier/ })).toBeTruthy();
    expect(screen.getByText(/2 businesses with a sourced email/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Contact state" }), { target: { value: "needs_verification" } });
    expect(within(panel).getByRole("row", { name: /Synthetic Supplier/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter results" }), { target: { value: "hello@supplier.example" } });
    expect(within(panel).getByRole("row", { name: /Synthetic Supplier/ })).toBeTruthy();
    expect(within(panel).queryByRole("row", { name: /Synthetic Unreviewed/ })).toBeNull();
  } finally {
    leads.splice(leads.findIndex((lead) => lead.id === "crm-only"), 1);
    contacts.splice(contacts.findIndex((contact) => contact.id === "crm-sourced"), 1);
  }
});

test("scheduled primary country excludes India and manual selection separates same-city businesses", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  const leads = data.leads as unknown as Array<Record<string, unknown>>;
  leads.push(
    { id: "us", business_name: "Synthetic Market Dental", business_category: "dental", city: "Austin", country: "United States", website_url: null, source_type: "serper", status: "researching" },
    { id: "au", business_name: "Synthetic Market Dental", business_category: "dental", city: "Austin", country: "Australia", website_url: null, source_type: "serper", status: "researching" },
    { id: "in", business_name: "Synthetic Market Dental", business_category: "dental", city: "Austin", country: "India", website_url: null, source_type: "serper", status: "researching" },
  );
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prospect request" }), { target: { value: "Find 10 dental businesses in Austin with public contacts" } });
    fireEvent.click(screen.getByRole("button", { name: "Interpret request locally" }));
    expect((screen.getByRole("checkbox", { name: "India" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    expect(await screen.findByText(/Screened stored businesses: 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Australia" }));
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    expect(await screen.findByText(/Screened stored businesses: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "United States" }));
    fireEvent.click(screen.getByRole("button", { name: /Search stored prospects/ }));
    expect(await screen.findByText(/Screened stored businesses: 1/)).toBeTruthy();
  } finally {
    vi.useRealTimers();
    for (const id of ["us", "au", "in"]) leads.splice(leads.findIndex((lead) => lead.id === id), 1);
  }
});

test("owner can save a disabled weekly plan when the organization has no targeting row", async () => {
  const prior = data.discovery_targeting;
  (data as Record<string, unknown>).discovery_targeting = null;
  try {
    render(<VibeProspecting demo={false} orgId="synthetic-org" role="admin" onOpenCRM={() => {}} onOpenResearch={() => {}} onOpenVerification={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save weekly plan" }));
    expect(await screen.findByText(/Weekly targeting plan saved/)).toBeTruthy();
    expect((data.discovery_targeting as unknown as Record<string, unknown>).weekly_countries).toEqual([
      "United States", "New Zealand", "United Arab Emirates", "Australia", "United Kingdom", "United States", "Australia",
    ]);
    expect((data.discovery_targeting as unknown as Record<string, unknown>).serper_discovery_enabled).toBeUndefined();
  } finally { data.discovery_targeting = prior; }
});
