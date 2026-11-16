// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: true,
  failUpdate: false,
  updateUser: vi.fn(async () => ({ error: auth.failUpdate ? { message: "Rejected" } : null })),
}));
vi.mock("../apps/web/lib/supabase", () => ({
  supabase: { auth: {
    getSession: async () => ({ data: { session: auth.session ? { user: { id: "owner" } } : null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    updateUser: auth.updateUser,
  } },
}));
import Onboard from "../apps/web/app/onboard/page";

beforeEach(() => { auth.session = true; auth.failUpdate = false; auth.updateUser.mockClear(); });
afterEach(() => cleanup());

test("invited account can choose a password after its link establishes a session", async () => {
  render(<Onboard />);
  const password = await screen.findByLabelText("New password");
  fireEvent.change(password, { target: { value: "synthetic-long-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "synthetic-long-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText(/Password saved/)).toBeTruthy();
  expect(auth.updateUser).toHaveBeenCalledWith({ password: "synthetic-long-password" });
});

test("missing session and mismatched passwords cannot update the account", async () => {
  auth.session = false;
  const first = render(<Onboard />);
  expect(await screen.findByText(/invalid or expired/)).toBeTruthy();
  expect(auth.updateUser).not.toHaveBeenCalled();
  first.unmount();
  auth.session = true;
  render(<Onboard />);
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "synthetic-long-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(screen.getByRole("alert").textContent).toMatch(/same password twice/);
  expect(auth.updateUser).not.toHaveBeenCalled();
});

test("provider rejection leaves password form available for retry", async () => {
  auth.failUpdate = true;
  render(<Onboard />);
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "synthetic-long-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "synthetic-long-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  expect(await screen.findByText(/Unable to set your password/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save password" })).toBeTruthy();
});
