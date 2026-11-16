"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
type Message = {
  id: string;
  lead_id: string;
  body: string | null;
  classification: string;
  occurred_at: string;
};
export function WhatsApp({ demo, orgId }: { demo: boolean; orgId: string }) {
  const [messages, setMessages] = useState<Message[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(demo);
  useEffect(() => {
    if (demo || !supabase || !orgId) return;
    let alive = true;
    supabase
      .from("communication_messages")
      .select("id,lead_id,body,classification,occurred_at")
      .eq("org_id", orgId)
      .eq("channel", "whatsapp")
      .order("occurred_at", { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (alive) {
          setReady(true);
          if (error)
            setError(
              "Conversations unavailable. Check database migrations and access.",
            );
          else setMessages(data ?? []);
        }
      });
    return () => {
      alive = false;
    };
  }, [demo, orgId]);
  return (
    <>
      <div className="safety-banner">
        <span>Official WhatsApp module · Outbound disabled</span>
        <span>Live provider Not Verified</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel" style={{ marginTop: 20 }}>
        <h2>WhatsApp conversations</h2>
        <p>
          Account setup, verified webhook testing, approved templates and opt-in
          review are required before activation. The existing business number
          has not been migrated.
        </p>
        <span className="status">
          {demo ? "Demonstration · No messages" : "Stored inbound records only"}
        </span>
        {!ready ? (
          <p role="status">Loading conversations…</p>
        ) : messages.length ? (
          messages.map((m) => (
            <article className="evidence" key={m.id}>
              <span className="status">
                {m.classification === "unsubscribe"
                  ? "Opt-out · Suppressed"
                  : `${m.classification} · Human review`}
              </span>
              <p>{m.body ?? "Non-text message received"}</p>
              <small>
                {new Date(m.occurred_at).toLocaleString()} · CRM lead{" "}
                {m.lead_id}
              </small>
            </article>
          ))
        ) : (
          <div className="empty">
            <h3>No inbound messages recorded.</h3>
            <p>
              Unsigned or duplicate webhook events cannot create a second
              conversation entry.
            </p>
          </div>
        )}
        <p className="muted">
          Sending and account migration are unavailable. Incoming opt-outs
          persist suppression and cancel pending follow-ups in one database
          transaction. End-to-end Meta test-number verification is still
          required.
        </p>
      </section>
    </>
  );
}
