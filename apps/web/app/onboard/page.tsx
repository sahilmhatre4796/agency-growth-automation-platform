"use client";

import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../../lib/supabase";

export default function Onboard() {
  const [state, setState] = useState<"loading" | "ready" | "missing" | "saving" | "done">(supabase ? "loading" : "missing");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (active) setState(!error && data.session ? "ready" : "missing");
    }).catch(() => { if (active) setState("missing"); });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (active) setState(session ? "ready" : "missing");
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  async function setPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password.length < 12 || password !== form.get("confirm")) {
      setMessage("Use at least 12 characters and enter the same password twice.");
      return;
    }
    setState("saving");
    setMessage("");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setState("ready");
      setMessage("Unable to set your password. Request a new link or try again.");
      return;
    }
    setState("done");
    setMessage("Password saved. Your private workspace is ready.");
  }

  return <main className="login"><section className="login-card">
    <span className="eyebrow">CHAINCRAFT STUDIO</span>
    <h1>Secure account setup</h1>
    {state === "loading" && <p role="status">Checking your invitation…</p>}
    {state === "missing" && <p role="alert">This link is invalid or expired. Request a fresh invitation or password link from the sign-in page.</p>}
    {(state === "ready" || state === "saving") && <form onSubmit={setPassword}>
      <p>Choose a password for your invited account. The link must be opened in this browser.</p>
      <label htmlFor="new-password">New password</label>
      <input id="new-password" name="password" type="password" minLength={12} required autoComplete="new-password" />
      <label htmlFor="confirm-password">Confirm password</label>
      <input id="confirm-password" name="confirm" type="password" minLength={12} required autoComplete="new-password" />
      <button className="primary" disabled={state === "saving"}>Save password</button>
    </form>}
    {message && <p role={state === "done" ? "status" : "alert"}>{message}</p>}
    {state === "done" && <a href="/">Open workspace</a>}
    {state === "missing" && <a href="/">Return to sign in</a>}
  </section></main>;
}
