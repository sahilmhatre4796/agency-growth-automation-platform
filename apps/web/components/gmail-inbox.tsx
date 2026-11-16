"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Account = { connection_id: string; address: string };
type Message = { id: string; connection_id: string; thread_id: string; direction: string; subject: string | null; body: string | null; classification: string; occurred_at: string };
type Thread = { id: string; lead_id: string | null; contact_id: string | null; campaign_id: string | null };
type Review = { message_id: string; peer_email: string; reason: string; state: string };
type ParseReview = { id: string; connection_id: string; provider_message_id: string; reason: string; created_at: string };

export function GmailInbox({ demo, orgId, role }: { demo: boolean; orgId: string; role: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [parseReviews, setParseReviews] = useState<ParseReview[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewBusy, setReviewBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const client = supabase;
    if (demo || role !== "admin" || !client || !orgId) return;
    const [a, m, t, r, p] = await Promise.all([
      client.rpc("gmail_account_summary", { p_org: orgId }),
      client.from("gmail_messages").select("id,connection_id,thread_id,direction,subject,body,classification,occurred_at").eq("org_id", orgId).order("occurred_at", { ascending: false }).limit(100),
      client.from("gmail_threads").select("id,lead_id,contact_id,campaign_id").eq("org_id", orgId).limit(100),
      client.from("gmail_message_reviews").select("message_id,peer_email,reason,state").eq("org_id", orgId).eq("state", "review_needed").order("created_at", { ascending: false }).limit(500),
      client.from("gmail_parse_reviews").select("id,connection_id,provider_message_id,reason,created_at").eq("org_id", orgId).eq("state", "review_needed").order("created_at", { ascending: false }).limit(500),
    ]);
    if (a.error || m.error || t.error || r.error || p.error) throw new Error("Stored Gmail history unavailable");
    const recent = (m.data ?? []) as Message[];
    const pending = (r.data ?? []) as Review[];
    const missing = pending.map((review) => review.message_id).filter((id) => !recent.some((message) => message.id === id));
    const older = await Promise.all(Array.from({ length: Math.ceil(missing.length / 50) }, (_, index) =>
      client.from("gmail_messages")
        .select("id,connection_id,thread_id,direction,subject,body,classification,occurred_at")
        .eq("org_id", orgId).in("id", missing.slice(index * 50, index * 50 + 50))));
    if (older.some((result) => result.error)) throw new Error("Pending Gmail reviews could not be loaded");
    setAccounts((a.data ?? []) as Account[]);
    setMessages([...recent, ...older.flatMap((result) => (result.data ?? []) as Message[])]
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at)));
    setThreads((t.data ?? []) as Thread[]); setReviews(pending); setParseReviews((p.data ?? []) as ParseReview[]);
  }, [demo, orgId, role]);
  useEffect(() => { void Promise.resolve().then(refresh).catch((cause) => setError(cause.message)); }, [refresh]);
  async function dismissUnrelated(messageId: string) {
    if (!supabase) return;
    setReviewBusy(true); setError("");
    try {
      const { error: reviewError } = await supabase.rpc("dismiss_unrelated_gmail_review", {
        p_org: orgId, p_message: messageId, p_note: (reviewNotes[messageId] ?? "").trim(),
      });
      if (reviewError) throw new Error("Review could not be saved. Confirm that the message is unrelated and provide a specific reason.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be saved."); }
    finally { setReviewBusy(false); }
  }
  async function dismissParseReview(reviewId: string) {
    if (!supabase) return;
    setReviewBusy(true); setError("");
    try {
      const { error: reviewError } = await supabase.rpc("dismiss_unrelated_gmail_parse_review", {
        p_org: orgId, p_review: reviewId, p_note: (reviewNotes[reviewId] ?? "").trim(),
      });
      if (reviewError) throw new Error("Review could not be saved. Inspect the original account and explain why this message is unrelated.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be saved."); }
    finally { setReviewBusy(false); }
  }
  const visible = messages.filter((message) => !filter || message.connection_id === filter);
  return <section className="panel">
    <div className="panel-heading"><h2>Unified Gmail history</h2><span className="status">{messages.length} stored messages</span></div>
    <p className="muted">Inbox and sent history is stored per account. Classification flags need human review. Refresh after a sync run to see new messages.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="button-row"><label>Account<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.connection_id} value={a.connection_id}>{a.address}</option>)}</select></label><button className="secondary" disabled={demo || role !== "admin"} onClick={() => void refresh().catch((cause) => setError(cause.message))}>Refresh stored history</button></div>
    {demo && <p>No Gmail messages exist in the demonstration workspace.</p>}
    {!demo && role !== "admin" && <p>Administrator access is required to view mailbox history.</p>}
    {!demo && role === "admin" && !visible.length && <p>No synchronized Gmail messages match this account.</p>}
    {!demo && role === "admin" && parseReviews.filter((item) => !filter || item.connection_id === filter).map((review) => {
      const account = accounts.find((item) => item.connection_id === review.connection_id);
      return <article className="verification-record" key={review.id}>
        <strong>Unparsed Gmail message · {review.reason.replaceAll("_", " ")}</strong>
        <p>{account?.address ?? "Account unavailable"} · provider message {review.provider_message_id} · {new Date(review.created_at).toLocaleString()}</p>
        <p>Sending was paused for this account. Inspect the message in Gmail, respond personally if it is a prospect, and leave the account paused until its status is clear.</p>
        {account?.address && <a href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(account.address)}`} target="_blank" rel="noopener noreferrer">Open original Gmail account</a>}
        <label>Why this message is unrelated<textarea value={reviewNotes[review.id] ?? ""} onChange={(event) => setReviewNotes({ ...reviewNotes, [review.id]: event.target.value })} maxLength={500} rows={2}/></label>
        <button className="secondary" disabled={reviewBusy || (reviewNotes[review.id] ?? "").trim().length < 20} onClick={() => void dismissParseReview(review.id)}>Mark unrelated after review</button>
      </article>;
    })}
    {visible.map((message) => {
      const thread = threads.find((item) => item.id === message.thread_id);
      const account = accounts.find((item) => item.connection_id === message.connection_id);
      const review = reviews.find((item) => item.message_id === message.id);
      return <article className="gmail-message" key={message.id}>
        <div><strong>{message.subject || "No subject"}</strong><span className="status">{review ? "Sender match needs review" : `${message.direction} · ${message.classification}`}</span></div>
        <small>{account?.address ?? "Account unavailable"} · {new Date(message.occurred_at).toLocaleString()} · {review ? `Unmatched sender ${review.peer_email} · ${review.reason.replaceAll("_", " ")}` : `Lead ${thread?.lead_id ?? "unmatched"}`}</small>
        <p>{message.body || "No plain-text body stored"}</p>
        {message.direction === "inbound" && account?.address && <p><a className="secondary" href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(account.address)}`} target="_blank" rel="noopener noreferrer">Open original Gmail account to reply personally</a></p>}
        {review && <div className="verification-record"><p>Ambiguous incoming mail blocks automated follow-ups from this account until reviewed. If this is a prospect reply, respond personally and keep the sequence paused.</p>
          <label>Reason this message is unrelated<textarea value={reviewNotes[message.id] ?? ""} onChange={(event) => setReviewNotes({ ...reviewNotes, [message.id]: event.target.value })} maxLength={500} rows={2}/></label>
          <button className="secondary" disabled={reviewBusy || (reviewNotes[message.id] ?? "").trim().length < 15} onClick={() => void dismissUnrelated(message.id)}>Mark unrelated after mailbox review</button>
        </div>}
      </article>;
    })}
  </section>;
}
