export type ProviderResult<T> = { data: T; mode: "fake"; verifiedLive: false };
export interface AIProvider {
  generate(context: {
    evidenceIds: string[];
  }): Promise<
    ProviderResult<{
      subject: string;
      body: string;
      evidenceIds: string[];
      reviewRequired: true;
    }>
  >;
}
export interface MailProvider {
  send(): Promise<never>;
}
export interface MessagingProvider {
  send(): Promise<never>;
}
export interface CalendarProvider {
  availability(): Promise<ProviderResult<string[]>>;
  book(): Promise<never>;
}
export interface LeadSourceAdapter {
  discover(): Promise<ProviderResult<unknown[]>>;
}
export interface AuditAdapter {
  audit(): Promise<ProviderResult<{ observations: string[] }>>;
}
export interface NotificationProvider {
  notify(message: string): Promise<ProviderResult<string>>;
}
const disabled = async (): Promise<never> => {
  throw new Error("LIVE_OPERATIONS_DISABLED");
};
export function fakeProviders() {
  const ai: AIProvider = {
    generate: async ({ evidenceIds }) => ({
      mode: "fake",
      verifiedLive: false,
      data: {
        subject: "Website consultation",
        body: "Would a conversation about your website be useful? Please let us know if you prefer no further contact.",
        evidenceIds,
        reviewRequired: true,
      },
    }),
  };
  const mail: MailProvider = { send: disabled };
  const messaging: MessagingProvider = { send: disabled };
  const calendar: CalendarProvider = {
    availability: async () => ({ mode: "fake", verifiedLive: false, data: [] }),
    book: disabled,
  };
  const source: LeadSourceAdapter = {
    discover: async () => ({ mode: "fake", verifiedLive: false, data: [] }),
  };
  const audit: AuditAdapter = {
    audit: async () => ({
      mode: "fake",
      verifiedLive: false,
      data: { observations: [] },
    }),
  };
  const notification: NotificationProvider = {
    notify: async (message) => ({
      mode: "fake",
      verifiedLive: false,
      data: message,
    }),
  };
  return { ai, mail, messaging, calendar, source, audit, notification };
}
