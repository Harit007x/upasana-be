/**
 * Every transactional email this app sends, in one place.
 *
 * Styled with inline CSS only — no `<style>` block, no external stylesheet — because
 * that is the one thing every mail client, from Gmail's clipped-`<style>` rendering to
 * Outlook's Word engine, agrees to honour. `emailLayout` is the shared chrome (mark,
 * wordmark, card, footer); each `*Email` function below is just the copy for one event.
 *
 * Layout is tables, not flex or grid, for the same reason: Outlook renders through Word,
 * which has no support for either, and a `display: flex` header there collapses into a
 * stack. Tables are the only box model that survives the whole client matrix.
 */

export interface EmailContent {
  subject: string;
  html: string;
}

/* The brand palette. Swap these for your own — every button and accent in the
   product should use the same values, so an email in the wrong accent never
   reads as a template someone bought. */
const ACTION = "#2563eb"; // --accent-fill: every button, everywhere
const ON_TINT = "#0037b4"; // --accent-on-tint: brand ink small enough to stay legible
const INK = "#1c1c20"; // --gray-900
const MUTED = "#66666e"; // --gray-500
const BORDER = "#d8d8de"; // --gray-200
const RULE = "#ececf0"; // --gray-100, for rules INSIDE the card
const CANVAS = "#f5f5f7"; // --gray-50
const SURFACE = "#ffffff";

/* Your product's name and marketing site, read from the environment so a
   deployment can rebrand without a code change. Defaults are placeholders —
   set BRAND_NAME and SITE_URL in .env before you send anything real.

   Functions, not constants, for the same reason `appUrl` below is one:
   `dotenvFlow.config()` runs inside index.ts's body, after the whole import
   graph is evaluated, so a module-level `process.env` read here would freeze
   the pre-override value. */
const brandName = (): string => process.env.BRAND_NAME || "Acme";
const siteUrl = (): string =>
  (process.env.SITE_URL || "http://localhost:5173").replace(/\/+$/, "");

/* Hosted on the marketing site, not attached and not inlined as a data URI:
   Gmail strips `data:` image sources outright, and CID attachments turn every
   transactional send into a multipart message for one 1.5 KB file. A public URL
   on a domain the recipient already trusts is the only approach all three of
   Gmail, Outlook and Apple Mail render.
   PNG, not an SVG — no major mail client renders SVG. Rasterise at 3x (108px
   for a 36px box) so it stays sharp on the retina displays most mail is read
   on. Drop yours at this path, or point BRAND_MARK_URL elsewhere. */
const markUrl = (): string => process.env.BRAND_MARK_URL || `${siteUrl()}/email/mark.png`;

/**
 * An absolute link into the app.
 *
 * Read at call time rather than into a module constant: `dotenvFlow.config()`
 * runs inside `index.ts`'s body, after the whole import graph is evaluated, so a
 * constant here would freeze the pre-override value — the same trap `email.ts`
 * documents for the Resend client and `dodo.ts` for the billing client.
 */
function appUrl(path: string): string {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${base}${path}`;
}

function button(label: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 26px 0 6px;">
      <tr>
        <td style="border-radius: 10px; background: ${ACTION};">
          <a href="${url}"
             style="display: inline-block; padding: 13px 26px; font-size: 15px; font-weight: 600;
                    line-height: 20px; color: #ffffff; text-decoration: none; border-radius: 10px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

/**
 * The same destination as the button, spelled out.
 *
 * Only worth the clutter where the link is the entire point of the email and a
 * blocked or mangled button leaves the reader with nowhere to go — a password
 * reset, not a receipt. `word-break` because reset URLs carry a long token and
 * an unbroken one forces the whole card to scroll sideways on a phone.
 */
function linkFallback(url: string): string {
  return `<p style="margin: 16px 0 0; font-size: 12px; line-height: 18px; color: ${MUTED};">
      Button not working? Paste this into your browser:<br />
      <span style="color: ${ON_TINT}; word-break: break-all;">${url}</span>
    </p>`;
}

/**
 * The small caps label above each heading — "Billing", "Action needed".
 *
 * It is the cheapest thing that makes a stack of these read as one system
 * rather than six unrelated notices: the reader knows what kind of email this
 * is before parsing a sentence, and it carries the brand colour at a size where
 * cobalt is still legible against white.
 */
function eyebrow(text: string): string {
  return `<p style="margin: 0 0 10px; font-size: 11px; font-weight: 700; line-height: 16px;
    letter-spacing: 0.08em; text-transform: uppercase; color: ${ON_TINT};">${text}</p>`;
}

function heading(text: string): string {
  return `<h1 style="margin: 0 0 14px; font-size: 22px; line-height: 30px; font-weight: 700;
    letter-spacing: -0.015em; color: ${INK};">${text}</h1>`;
}

function paragraph(text: string): string {
  return `<p style="margin: 0 0 12px; font-size: 15px; line-height: 24px; color: ${INK};">${text}</p>`;
}

function muted(text: string): string {
  return `<p style="margin: 20px 0 0; font-size: 13px; line-height: 20px; color: ${MUTED};">${text}</p>`;
}

function link(label: string, url: string): string {
  return `<a href="${url}" style="color: ${ON_TINT}; text-decoration: underline;">${label}</a>`;
}

/**
 * Label/value rows under a hairline — plan, price, next billing date.
 *
 * Billing facts belong in a table rather than a sentence. A reader scanning a
 * receipt is looking for one number, and prose makes them read the whole
 * paragraph to find it; this also survives translation and forwarding to an
 * accountant, which "your subscription renewed at $29/month" does not.
 */
function detailRows(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding: 11px 0; border-top: 1px solid ${RULE}; font-size: 14px;
                   line-height: 20px; color: ${MUTED};">${label}</td>
        <td align="right" style="padding: 11px 0; border-top: 1px solid ${RULE}; font-size: 14px;
                   line-height: 20px; font-weight: 600; color: ${INK};">${value}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="margin: 20px 0 4px; border-collapse: collapse;">${cells}</table>`;
}

/**
 * The shared card: brand lockup, white content panel, muted footer.
 *
 * `preheader` is the hidden preview-text snippet inbox lists show beside the subject —
 * without it, clients fall back to quoting the email's own first line (usually "Hi,").
 *
 * The lockup is a raster mark beside LIVE TEXT, never one flattened image. Most
 * clients block remote images until the reader allows them, and a header that is
 * entirely an image renders as an empty box — so the wordmark is real text that
 * always draws, and the mark's `alt` covers the gap when it does not.
 */
function emailLayout(options: { preheader: string; body: string }): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Opt out of the automatic dark-mode inversion Apple Mail and Outlook apply
         to light emails. Left on, they recolour the card and the ink independently
         and the cobalt button lands on a near-black panel it was never contrasted
         against. Declaring the email light keeps one intended rendering. -->
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="margin: 0; padding: 0; background: ${CANVAS}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <span style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${options.preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${CANVAS}; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px;">
            <tr>
              <td style="padding: 0 4px 18px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right: 10px; vertical-align: middle;">
                      <img src="${markUrl()}" width="32" height="32" alt="${brandName()}"
                           style="display: block; width: 32px; height: 32px; border: 0;" />
                    </td>
                    <td style="vertical-align: middle;">
                      <span style="font-size: 19px; font-weight: 700; color: ${INK}; letter-spacing: -0.015em;">${brandName()}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background: ${SURFACE}; border: 1px solid ${BORDER}; border-radius: 14px; padding: 32px;">
                ${options.body}
              </td>
            </tr>
            <tr>
              <td style="padding: 22px 8px 0;">
                <p style="margin: 0; font-size: 12px; line-height: 18px; color: ${MUTED};">
                  <a href="${siteUrl()}" style="color: ${MUTED}; text-decoration: underline;">${siteUrl().replace(/^https?:\/\//, "")}</a>
                  &nbsp;·&nbsp; This is a transactional email about your account.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function resetPasswordEmail(options: { url: string }): EmailContent {
  return {
    subject: `Reset your ${brandName()} password`,
    html: emailLayout({
      preheader: "Reset your password — this link expires in an hour.",
      body: [
        eyebrow("Security"),
        heading("Reset your password"),
        paragraph(
          "Someone asked to reset the password on this account. If that was you, choose a new one below — the link expires in an hour."
        ),
        button("Choose a new password", options.url),
        linkFallback(options.url),
        muted("If you didn't request this, you can ignore this email and your password will stay the same."),
      ].join(""),
    }),
  };
}

/**
 * Sent from `auth.ts`'s user-create hook, so the recipient already HAS an
 * account — which is why the call to action goes into the app and not to a
 * signup form they cannot use.
 *
 * `/dashboard` rather than `/onboarding`, even though a brand-new account has
 * not onboarded: the app's own guard forwards an un-onboarded user to
 * onboarding, so this one link stays correct whether they read the email
 * thirty seconds or three days after signing up. Pointing at `/onboarding`
 * directly would strand anyone who had already finished it.
 */
export function welcomeEmail(options: { name: string }): EmailContent {
  return {
    subject: `Welcome to ${brandName()}`,
    html: emailLayout({
      preheader: "Your account is ready.",
      body: [
        eyebrow("Your account"),
        heading(`Welcome, ${escapeHtml(options.name)}`),
        paragraph("Your account is ready to go — no card needed to get started."),
        button("Open the app", appUrl("/dashboard")),
        muted("You're on the Free plan. Upgrade any time from account settings."),
        muted("If you didn't create this account, you can ignore this email."),
      ].join(""),
    }),
  };
}

export function subscriptionActivatedEmail(options: {
  name: string;
  planLabel: string;
  priceUsd: number;
  interval: "month" | "year";
}): EmailContent {
  const cadence = options.interval === "year" ? "year" : "month";
  return {
    subject: `You're on the ${options.planLabel} plan`,
    html: emailLayout({
      preheader: `Your ${options.planLabel} plan is active.`,
      body: [
        eyebrow("Billing"),
        heading(`You're on ${options.planLabel}`),
        paragraph(
          `Hi ${escapeHtml(options.name)} — your subscription is active and your new plan's features are available now.`
        ),
        detailRows([
          ["Plan", escapeHtml(options.planLabel)],
          ["Price", `$${options.priceUsd}/${cadence}`],
          ["Billed to", "The card on file"],
        ]),
        button(`Open ${brandName()}`, appUrl("/dashboard")),
        muted(`Manage or cancel your plan any time from ${link("account settings", appUrl("/settings"))}.`),
      ].join(""),
    }),
  };
}

export function subscriptionRenewedEmail(options: {
  name: string;
  planLabel: string;
  priceUsd: number;
  interval: "month" | "year";
  nextBillingDate: Date | null;
}): EmailContent {
  const cadence = options.interval === "year" ? "year" : "month";
  const next = options.nextBillingDate
    ? options.nextBillingDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  return {
    subject: `Your ${options.planLabel} plan renewed`,
    html: emailLayout({
      preheader: `$${options.priceUsd} charged for another ${cadence} of ${options.planLabel}.`,
      body: [
        eyebrow("Receipt"),
        heading("Your plan renewed"),
        paragraph(`Hi ${escapeHtml(options.name)} — nothing to do here, this is just your receipt.`),
        detailRows([
          ["Plan", escapeHtml(options.planLabel)],
          ["Amount", `$${options.priceUsd}`],
          ["Period", `One ${cadence}`],
          ...(next ? ([["Next billing date", next]] as Array<[string, string]>) : []),
        ]),
        muted(`Manage your plan any time from ${link("account settings", appUrl("/settings"))}.`),
      ].join(""),
    }),
  };
}

export function paymentProblemEmail(options: { name: string; planLabel: string }): EmailContent {
  return {
    subject: `We couldn't renew your ${brandName()} plan`,
    html: emailLayout({
      preheader: "Update your payment method to keep your plan active.",
      body: [
        eyebrow("Action needed"),
        heading("We couldn't charge your card"),
        paragraph(
          `Hi ${escapeHtml(options.name)} — the payment for your ${escapeHtml(options.planLabel)} plan didn't go through. Your account keeps its current access for now, but will be suspended if this isn't resolved.`
        ),
        /* A button, not the prose pointer this used to be. This is the one
           email whose entire purpose is a single action, and asking someone to
           navigate to a settings page themselves is where dunning emails lose
           the recovery they exist to get. */
        button("Update payment method", appUrl("/settings")),
        muted("Cards usually fail for an expiry date or a bank hold, not a balance — it is normally a one-minute fix."),
      ].join(""),
    }),
  };
}

export function subscriptionCancelledEmail(options: { name: string; accessUntil: Date | null }): EmailContent {
  const until = options.accessUntil
    ? options.accessUntil.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  return {
    subject: `Your ${brandName()} subscription was cancelled`,
    html: emailLayout({
      preheader: "Sorry to see you go.",
      body: [
        eyebrow("Billing"),
        heading("Subscription cancelled"),
        paragraph(`Hi ${escapeHtml(options.name)} — your subscription has been cancelled, and you won't be billed again.`),
        paragraph(
          until
            ? `You'll keep your plan's access until ${until}, then your account moves to the Free plan.`
            : "Your account has moved to the Free plan."
        ),
        /* A link rather than a button. The reader has just chosen to leave;
           a full-width call to action reads as not taking no for an answer. */
        muted(`Changed your mind? You can resubscribe any time from ${link("account settings", appUrl("/settings"))}.`),
      ].join(""),
    }),
  };
}

/**
 * Sent from `POST /admin/invites` when an admin invites someone by email. The
 * link goes to the app's own invite page, which handles sign-in or sign-up
 * first — the recipient may not have an account yet.
 */
export function adminInviteEmail(options: {
  inviterName: string;
  name?: string;
  /** "an admin", "Mandal sanchalak for Surat" — see roleDescription in event.ts. */
  roleText: string;
  url: string;
  expiresAt: Date;
}): EmailContent {
  const expires = options.expiresAt.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return {
    subject: `${options.inviterName} invited you to join ${brandName()} as ${options.roleText}`,
    html: emailLayout({
      preheader: `Accept the invite before ${expires}.`,
      body: [
        eyebrow("Team access"),
        heading(options.name ? `${escapeHtml(options.name)}, you're invited` : "You're invited"),
        paragraph(
          `${escapeHtml(options.inviterName)} has invited you to join ${brandName()} as ${escapeHtml(options.roleText)}.`
        ),
        button("Accept invite", options.url),
        linkFallback(options.url),
        muted(
          `Sign in or create an account with this email address to accept. The link works once and expires on ${expires}.`
        ),
        muted("If you weren't expecting this, you can ignore this email."),
      ].join(""),
    }),
  };
}

/** The only user-supplied strings interpolated into these templates are names, so this is the one escape that matters. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
