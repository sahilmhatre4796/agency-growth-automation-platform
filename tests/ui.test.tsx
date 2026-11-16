// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../apps/web/lib/supabase", () => ({ supabase: null }));
import Home from "../apps/web/app/page";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("anonymous route shows demonstration workspace without credentials", () => {
  render(<Home />);
  expect(screen.getByText(/Fictional records, no live activity/)).toBeTruthy();
  expect(screen.getByText("Example Interiors")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sign in/i })).toBeNull();
});
test("demo is explicitly labeled; search and sign-out work", async () => {
  render(<Home />);
  expect(screen.getByText(/Fictional records, no live activity/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View leads" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Search leads" }),
    {
      target: { value: "Artisan" },
    },
  );
  expect(screen.queryByText("Example Interiors")).toBeNull();
  expect(screen.getByText("Sample Artisan Shop")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", {
    name: "Welcome to your command center.",
  });
  expect(screen.queryByText("Sample Artisan Shop")).toBeNull();
});
test("pending module has no live controls", () => {
  render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
  expect(screen.getByText("Live provider Not Verified")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
});
test("CRM lead creation persists across reload and still has unknown permission", async () => {
  const first = render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "View leads" }));
  fireEvent.click(await screen.findByRole("button", { name: "New lead" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Business name" }), {
    target: { value: "Fictional QA Studio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
  await screen.findByText("Fictional QA Studio");
  expect(screen.getAllByText("Unknown / review").length).toBeGreaterThan(0);
  first.unmount();
  render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "View leads" }));
  expect(await screen.findByText("Fictional QA Studio")).toBeTruthy();
});
test("demo draft requires factual review before approval and has no send control", async () => {
  render(<Home />);
  fireEvent.click(screen.getByRole("button", { name: "Email" }));
  const select = await screen.findByLabelText("Draft lead");
  await screen.findByRole("option", { name: "Example Interiors" });
  fireEvent.change(select, { target: { value: "demo-1" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Create grounded demo draft" }),
  );
  const approval = await screen.findByRole("button", {
    name: "Approve content",
  });
  expect((approval as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(approval);
  expect(
    await screen.findByText("Content approved. Live sending remains disabled."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});
