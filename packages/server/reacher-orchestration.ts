// Reacher orchestration: connects email verification results to the existing
// Vibe contact reconciliation system. Every discovered email is independently
// assessed; results preserve source provenance and feed into
// reconcileContactObservations without overwriting existing evidence.
import {
  verifyEmailAddress,
  type VerificationResult,
  type VerificationStatus,
  type AdvancedEmailVerifier,
  type DnsResolver,
  CloudflareDnsResolver,
  starterDisposableDomains,
} from "./email-verification.ts";
import { reconcileContactObservations, type ContactObservation } from "./vibe-contact-enrichment.ts";

// Result of running Reacher verification against one discovered contact.
export type ReacherVerificationOutcome = {
  contact: ContactObservation;
  verification: VerificationResult;
  disposition: "approved" | "hold_review" | "blocked";
};

// Map a Reacher/basic-DNS verification result to a ChainCraft disposition.
export function mapVerificationToDisposition(result: VerificationResult): {
  disposition: "approved" | "hold_review" | "blocked";
  reason: string;
} {
  if (result.status === "invalid" || result.status === "suppressed") {
    return {
      disposition: "blocked",
      reason: `Mailbox ${result.status}: ${result.evidence.reason}`,
    };
  }
  if (result.status === "valid") {
    return {
      disposition: "approved",
      reason: `Reacher verified ${result.evidence.reason}`,
    };
  }
  // unknown or risky: owner review required before any outreach.
  return {
    disposition: "hold_review",
    reason: `Mailbox ${result.status}: ${result.evidence.reason}`,
  };
}

// Verify one discovered contact observation through basic DNS + optional
// Reacher advanced SMTP checks. Returns a contact observation tagged with
// verification evidence suitable for reconcileContactObservations.
export async function verifyDiscoveredContact(
  contact: ContactObservation,
  input: {
    resolver: DnsResolver;
    advanced?: AdvancedEmailVerifier;
    disposableDomains?: ReadonlySet<string>;
    observedAt?: string;
  },
): Promise<ReacherVerificationOutcome> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const result = await verifyEmailAddress({
    email: contact.value,
    resolver: input.resolver,
    disposableDomains: input.disposableDomains,
    advanced: input.advanced,
  });
  const { disposition, reason } = mapVerificationToDisposition(result);
  const observation: ContactObservation = {
    ...contact,
    observed_at: observedAt,
    // Append verification evidence to the excerpt without overwriting the
    // original discovery source. The extractor already guarantees the value
    // appears in the excerpt; we add a bracketed verification note.
    evidence_excerpt: `${contact.evidence_excerpt} [verification:${result.status}|${reason}]`.slice(0, 320),
  };
  return { contact: observation, verification: result, disposition };
}

// Verify all email-type contact observations for one lead through Reacher /
// basic DNS, then reconcile against existing evidence. Suppressed and invalid
// addresses are blocked; risky/unknown are held for review; valid are
// approved. Existing source evidence is never overwritten.
export async function verifyLeadContacts(
  contacts: ContactObservation[],
  input: {
    resolver: DnsResolver;
    advanced?: AdvancedEmailVerifier;
    disposableDomains?: ReadonlySet<string>;
    observedAt?: string;
  },
): Promise<{
  outcomes: ReacherVerificationOutcome[];
  reconciled: ReturnType<typeof reconcileContactObservations>;
  blocked: ReacherVerificationOutcome[];
  approved: ReacherVerificationOutcome[];
  hold: ReacherVerificationOutcome[];
}> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const emailContacts = contacts.filter((c) => c.kind === "email");
  const outcomes: ReacherVerificationOutcome[] = [];

  for (const contact of emailContacts) {
    const outcome = await verifyDiscoveredContact(contact, {
      resolver: input.resolver,
      advanced: input.advanced,
      disposableDomains: input.disposableDomains,
      observedAt,
    });
    outcomes.push(outcome);
  }

  const blocked = outcomes.filter((o) => o.disposition === "blocked");
  const approved = outcomes.filter((o) => o.disposition === "approved");
  const hold = outcomes.filter((o) => o.disposition === "hold_review");

  // Only approved and hold-review observations enter reconciliation. Blocked
  // addresses are recorded as outcomes but never written to CRM contact points.
  const reconcilable = [...approved, ...hold].map((o) => o.contact);
  const reconciled = reconcileContactObservations(reconcilable);

  return { outcomes, reconciled, blocked, approved, hold };
}

export type { VerificationResult, VerificationStatus, AdvancedEmailVerifier, DnsResolver };
export { CloudflareDnsResolver, starterDisposableDomains };
