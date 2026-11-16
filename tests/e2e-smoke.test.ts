// Playwright smoke tests for ChainCraft Sales Command Center.
// These exercise the actual local application (dev server on http://127.0.0.1:3000).
import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:3000";

async function gotoSection(page: import("@playwright/test").Page, section: string) {
  await page.locator("button.nav-item", { hasText: section }).first().click();
}

test("homepage loads and shows demo workspace when Supabase is unconfigured", async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveURL(BASE);
  await expect(page.getByText(/Fictional records, no live activity/)).toBeVisible();
  await expect(page.getByText("Example Interiors")).toBeVisible();
  await expect(page.getByText("Sample Artisan Shop")).toBeVisible();
});

test("workspace navigation sections are present", async ({ page }) => {
  await page.goto(BASE);
  for (const section of [
    "Overview", "Leads", "Discover", "Vibe Prospecting", "Email",
    "Email Verification", "Business Research", "WhatsApp", "LinkedIn Assistant",
    "Calendar", "Automation", "Analytics", "Settings",
  ]) {
    await expect(page.locator("button.nav-item", { hasText: section }).first()).toBeVisible();
  }
});

test("CRM lead list and detail work in demo mode", async ({ page }) => {
  await page.goto(BASE);
  await page.getByRole("button", { name: "View leads" }).click();
  await expect(page.getByText("Example Interiors")).toBeVisible();
  await page.getByRole("button", { name: "Open Example Interiors" }).click();
  await expect(page.getByRole("heading", { name: "Example Interiors", exact: true })).toBeVisible();
});

test("CRM create lead persists in demo mode", async ({ page }) => {
  await page.goto(BASE);
  await page.getByRole("button", { name: "View leads" }).click();
  await page.getByRole("button", { name: "New lead" }).click();
  await page.getByRole("textbox", { name: "Business name" }).fill("Playwright Test Business");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByText("Playwright Test Business")).toBeVisible();
});

test("Vibe Prospecting page loads in demo mode", async ({ page }) => {
  await page.goto(BASE);
  await gotoSection(page, "Vibe Prospecting");
  await expect(page.getByText(/Prospect request/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Interpret request locally" })).toBeVisible();
});

test("Email Verification page loads", async ({ page }) => {
  await page.goto(BASE);
  await gotoSection(page, "Email Verification");
  await expect(page.getByRole("heading", { name: "Email Verification", exact: true })).toBeVisible();
});

test("Business Research page loads", async ({ page }) => {
  await page.goto(BASE);
  await gotoSection(page, "Business Research");
  await expect(page.getByRole("heading", { name: "Business Research", exact: true })).toBeVisible();
});

test("Settings page shows disabled outbound features", async ({ page }) => {
  await page.goto(BASE);
  await gotoSection(page, "Settings");
  await expect(page.getByText("Disabled").first()).toBeVisible();
});

test("LinkedIn Assistant prepare copy works", async ({ page }) => {
  await page.goto(BASE);
  await gotoSection(page, "LinkedIn Assistant");
  // Leads load asynchronously from the demo store; wait for the select to appear.
  const leadSelect = page.locator("select[aria-label='LinkedIn business']");
  await expect(leadSelect).toBeVisible({ timeout: 15000 });
  // Select a lead so the "Prepare suggested copy" button becomes enabled.
  await leadSelect.selectOption({ label: "Example Interiors" });
  await page.getByRole("button", { name: "Prepare suggested copy" }).click();
  // Wait for the suggested copy to be populated into the textarea.
  const copy = page.locator("#linkedin-copy");
  await expect(copy).not.toHaveValue("", { timeout: 15000 });
});

test("CRM lead edit form works", async ({ page }) => {
  await page.goto(BASE);
  await page.getByRole("button", { name: "View leads" }).click();
  await page.getByRole("button", { name: "Open Example Interiors" }).click();
  await expect(page.getByRole("heading", { name: "Example Interiors", exact: true })).toBeVisible();
  // The edit form loads asynchronously after the detail view mounts.
  await expect(page.locator("summary", { hasText: "Edit business details" })).toBeVisible({ timeout: 15000 });
  await page.locator("summary", { hasText: "Edit business details" }).click();
  // Wait for the Save lead button to appear after the form opens.
  await expect(page.getByRole("button", { name: "Save business details" })).toBeVisible({ timeout: 15000 });
  await page.getByRole("textbox", { name: "Business name" }).fill("Edited Interiors");
  await page.getByRole("button", { name: "Save business details" }).click();
  await expect(page.getByText("Edited Interiors")).toBeVisible();
});
