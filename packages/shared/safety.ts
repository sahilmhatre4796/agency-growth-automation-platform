export type Role = "admin" | "sales" | "analyst";
export const FEATURES = Object.freeze({
  liveEmail: false,
  liveWhatsApp: false,
  billableAI: false,
  aiCalling: false,
  inboundVoice: false,
  recording: false,
});
export type PolicyContext = {
  role: Role;
  orgMatches: boolean;
  paused: boolean;
  approved: boolean;
  permission: boolean;
  suppressed: boolean;
  connected: boolean;
  remaining: number;
  withinWindow: boolean;
  duplicate: boolean;
};
export function outboundDecision(context: PolicyContext): {
  allowed: false;
  reason: string;
} {
  const reason = !context.orgMatches
    ? "ORG_MISMATCH"
    : context.role !== "admin"
      ? "FORBIDDEN"
      : context.paused
        ? "WORKSPACE_PAUSED"
        : context.suppressed
          ? "SUPPRESSED"
          : !context.approved
            ? "APPROVAL_REQUIRED"
            : !context.permission
              ? "PERMISSION_REQUIRED"
              : !context.connected
                ? "NOT_CONNECTED"
                : context.remaining <= 0
                  ? "QUOTA_EXHAUSTED"
                  : !context.withinWindow
                    ? "OUTSIDE_WINDOW"
                    : context.duplicate
                      ? "DUPLICATE"
                      : "LIVE_OPERATIONS_DISABLED";
  return { allowed: false, reason };
}
