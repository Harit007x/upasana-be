import { recordUsage } from "./usage";

/**
 * WhatsApp messages, sent through MSG91.
 *
 * The only file that knows about MSG91. Moving to Meta's Cloud API directly, or
 * another provider, means rewriting `sendWhatsAppTemplate` and nothing else.
 *
 * WhatsApp only lets a business start a conversation with a **template** Meta
 * has approved, so every message here is a template name plus the values for
 * its `{{1}}`, `{{2}}`… placeholders. The templates themselves are created in
 * the MSG91 dashboard; setup.md lists the exact wording each one needs.
 *
 * Read from the environment at call time, never at import: env is loaded in
 * src/env.ts, and a module-scope read here would freeze whatever came first —
 * the same reason src/lib/email.ts builds its client lazily.
 */

const ENDPOINT = "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
const TIMEOUT_MS = 10_000;

/**
 * Meta's India rate for a utility or authentication template, ₹0.115, in USD
 * for the usage ledger. Approximate on purpose: the ledger is for spotting spend, and the
 * exact figure is on MSG91's invoice.
 */
const UTILITY_COST_USD = 0.0014;

/** Approved template names, each overridable from .env in case MSG91 wants a different one. */
export const WHATSAPP_TEMPLATES = {
  /** {{1}} inviter, {{2}} event, {{3}} role ("an admin", "Mandal sanchalak for Surat"); button: the token. */
  teamInvite: () => process.env.MSG91_TEMPLATE_INVITE || "team_invite",
  /** An Authentication-category template: the code in the body and on its copy-code button. */
  otp: () => process.env.MSG91_TEMPLATE_OTP || "registration_otp",
  /** {{1}} contact's name, {{2}} event, {{3}} where everyone stays, on one line. */
  stayDetails: () => process.env.MSG91_TEMPLATE_STAY || "room_details",
};

export class WhatsAppUnavailableError extends Error {
  constructor() {
    super("WhatsApp is not configured: set MSG91_AUTH_KEY and MSG91_WHATSAPP_NUMBER");
    this.name = "WhatsAppUnavailableError";
  }
}

const isSet = (value: string | undefined): value is string =>
  !!value && value.trim() !== "" && value !== "replace-me";

/** Whether the server can send WhatsApp messages at all. */
export function isWhatsAppConfigured(): boolean {
  return isSet(process.env.MSG91_AUTH_KEY) && isSet(process.env.MSG91_WHATSAPP_NUMBER);
}

/** MSG91 wants numbers as bare digits with the country code: "+919876543210" → "919876543210". */
const digits = (phone: string) => phone.replace(/\D/g, "");

/**
 * Sends one approved template to one number.
 *
 * Throws `WhatsAppUnavailableError` when MSG91 is not configured, and an Error
 * carrying MSG91's own message when the send is refused — callers decide what
 * a failed message means for the request in front of them.
 */
export async function sendWhatsAppTemplate(options: {
  /** E.164, e.g. "+919876543210". */
  to: string;
  template: string;
  /** Values for the body's {{1}}, {{2}}…, in order. */
  body?: string[];
  /** Value for a "Visit website" button's dynamic URL suffix. */
  buttonUrl?: string;
  /** Usage-ledger attribution. */
  usage: { endpoint: string; userId?: string };
}): Promise<void> {
  if (!isWhatsAppConfigured()) throw new WhatsAppUnavailableError();

  const components: Record<string, { type: string; value: string; subtype?: string }> = {};
  (options.body ?? []).forEach((value, index) => {
    components[`body_${index + 1}`] = { type: "text", value };
  });
  if (options.buttonUrl !== undefined) {
    components.button_1 = { subtype: "url", type: "text", value: options.buttonUrl };
  }

  const namespace = process.env.MSG91_WHATSAPP_NAMESPACE;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authkey: process.env.MSG91_AUTH_KEY as string,
    },
    body: JSON.stringify({
      integrated_number: digits(process.env.MSG91_WHATSAPP_NUMBER as string),
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: options.template,
          language: { code: process.env.MSG91_WHATSAPP_LANGUAGE || "en", policy: "deterministic" },
          ...(isSet(namespace) ? { namespace } : {}),
          to_and_components: [{ to: [digits(options.to)], components }],
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // MSG91 can answer 200 with `hasError: true`, so the status code alone is
  // not enough. A non-JSON body (a gateway error page) is a failure too.
  const result = (await response.json().catch(() => null)) as
    | { hasError?: boolean; status?: string; errors?: unknown; message?: string }
    | null;
  if (!response.ok || !result || result.hasError || result.status === "fail") {
    const detail = result?.errors ?? result?.message ?? `HTTP ${response.status}`;
    throw new Error(`MSG91 refused the WhatsApp message: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }

  await recordUsage({ ...options.usage, costUsd: UTILITY_COST_USD });
}
