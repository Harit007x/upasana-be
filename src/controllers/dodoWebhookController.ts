import { Request, Response } from "express";
import type { Subscription } from "dodopayments/resources/subscriptions";
import type { UnwrapWebhookEvent } from "dodopayments/resources/webhooks/webhooks";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { dodo } from "../lib/dodo";
import { sendEmail } from "../lib/email";
import {
  paymentProblemEmail,
  subscriptionActivatedEmail,
  subscriptionCancelledEmail,
  subscriptionRenewedEmail,
} from "../lib/email-templates";
import { planForProductId, priceFor } from "../lib/billing/plans";

/**
 * Dodo Payments webhook receiver.
 *
 * Three things about this endpoint are load-bearing:
 *
 * 1. **It reads a raw body.** The signature is an HMAC over the exact bytes Dodo
 *    sent. The route is therefore mounted with `express.raw()` *before* the
 *    global `express.json()` in src/index.ts — verifying against a re-serialized
 *    `JSON.stringify(req.body)` appears to work until a payload contains a
 *    non-ASCII character, at which point every delivery silently fails to verify.
 * 2. **It is idempotent.** Dodo retries up to 8 times over ~18 hours, so the same
 *    event will arrive twice sooner or later. The `webhook-id` header is claimed
 *    in the database before any work happens.
 * 3. **It answers fast.** The delivery timeout is 15 seconds. Anything slow
 *    (email, provisioning) belongs in a queue, not in this request.
 */

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Resolves the user a subscription belongs to.
 *
 * Prefers the `userId` we stamped into metadata at checkout, and falls back to the
 * customer id. Both are checked because either can be missing: metadata is absent
 * on subscriptions created outside our own checkout flow (the Dodo dashboard, for
 * instance), and the customer link is absent if the user row was deleted.
 */
const resolveUserId = async (subscription: Subscription): Promise<string | null> => {
  // Metadata is a free-form bag on Dodo's side, so the value is not necessarily
  // the string we put there — anything that is not a plausible id is skipped
  // rather than queried. Mongo rejects a malformed ObjectId by throwing, which
  // would read as a handler failure and burn all 8 retry attempts.
  const fromMetadata = subscription.metadata?.userId;
  if (typeof fromMetadata === "string" && /^[a-f\d]{24}$/i.test(fromMetadata)) {
    const user = await prisma.user.findUnique({ where: { id: fromMetadata }, select: { id: true } });
    if (user) return user.id;
  }

  // `findFirst`, not `findUnique`: the uniqueness of this column is enforced by
  // a partial index MongoDB builds outside the Prisma schema, so Prisma does not
  // know the column is unique. See `User.dodoCustomerId`.
  const user = await prisma.user.findFirst({
    where: { dodoCustomerId: subscription.customer.customer_id },
    select: { id: true },
  });

  return user?.id ?? null;
};

/**
 * Writes Dodo's version of a subscription into our mirror.
 *
 * Every subscription event carries the full subscription object, so each one can
 * be applied on its own without reference to what came before. That is what makes
 * out-of-order delivery survivable — and Dodo makes no ordering promise.
 */
const syncSubscription = async (subscription: Subscription): Promise<string | null> => {
  const userId = await resolveUserId(subscription);

  if (!userId) {
    // Not an error worth retrying: no local user will ever match. Log loudly and
    // acknowledge, so the delivery does not churn through all 8 attempts.
    console.warn(
      `[Dodo] Subscription ${subscription.subscription_id} has no matching local user (customer ${subscription.customer.customer_id})`
    );
    return null;
  }

  const fields = {
    userId,
    productId: subscription.product_id,
    status: subscription.status,
    currentPeriodEnd: subscription.next_billing_date ? new Date(subscription.next_billing_date) : null,
    cancelAtPeriodEnd: subscription.cancel_at_next_billing_date,
    // Dodo has no `trialing` status — a subscription inside its trial is plainly
    // `active` — so trial-ness is resolved here, once, from the two fields that
    // do carry it. Both are stable for the life of the subscription, which is
    // what makes this safe to recompute on every event: out-of-order deliveries
    // all arrive at the same answer.
    trialEndsAt:
      subscription.trial_period_days > 0
        ? new Date(
            new Date(subscription.created_at).getTime() +
              subscription.trial_period_days * 24 * 60 * 60 * 1000
          )
        : null,
  };

  await prisma.subscription.upsert({
    where: { dodoSubscriptionId: subscription.subscription_id },
    create: { dodoSubscriptionId: subscription.subscription_id, ...fields },
    update: fields,
  });

  return userId;
};

type SubscriptionLifecycleEvent =
  | "subscription.active"
  | "subscription.renewed"
  | "subscription.on_hold"
  | "subscription.failed"
  | "subscription.cancelled"
  | "subscription.expired"
  | "subscription.plan_changed"
  | "subscription.updated";

/**
 * Sends the one acknowledgment email a subscription event is worth, if any.
 *
 * Deliberately **not awaited by its caller** — see the module docstring's point 3.
 * There is no queue here (nothing in this codebase needs one yet), so instead this
 * runs after the response-determining work is done and is fire-and-forget from
 * `applyEvent`'s point of view: a slow or failed send cannot delay the webhook ack
 * or turn a successful sync into a retried delivery. Errors are caught and logged
 * by the caller, never thrown back into the request.
 *
 * `plan_changed` and `updated` send nothing — neither is a change a user asked for
 * in the moment, and `updated` in particular can fire on Dodo-side bookkeeping that
 * has nothing to do with the subscriber.
 */
const notifySubscriptionEvent = async (
  eventType: SubscriptionLifecycleEvent,
  userId: string,
  subscription: Subscription
): Promise<void> => {
  const resolved = planForProductId(subscription.product_id);
  if (!resolved) return; // A product id from outside our own catalogue — nothing to name in an email.

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!user) return;

  const { plan, interval } = resolved;
  const priceUsd = priceFor(plan, interval);
  const nextBillingDate = subscription.next_billing_date ? new Date(subscription.next_billing_date) : null;

  switch (eventType) {
    case "subscription.active": {
      const { subject, html } = subscriptionActivatedEmail({ name: user.name, planLabel: plan.label, priceUsd, interval });
      await sendEmail({ to: user.email, subject, html });
      return;
    }
    case "subscription.renewed": {
      const { subject, html } = subscriptionRenewedEmail({
        name: user.name,
        planLabel: plan.label,
        priceUsd,
        interval,
        nextBillingDate,
      });
      await sendEmail({ to: user.email, subject, html });
      return;
    }
    case "subscription.on_hold":
    case "subscription.failed": {
      const { subject, html } = paymentProblemEmail({ name: user.name, planLabel: plan.label });
      await sendEmail({ to: user.email, subject, html });
      return;
    }
    case "subscription.cancelled":
    case "subscription.expired": {
      const { subject, html } = subscriptionCancelledEmail({ name: user.name, accessUntil: nextBillingDate });
      await sendEmail({ to: user.email, subject, html });
      return;
    }
    case "subscription.plan_changed":
    case "subscription.updated":
      return;
  }
};

/**
 * Applies one verified event.
 *
 * Throwing from here means "please retry": the idempotency claim is released and
 * a non-2xx goes back to Dodo. Returning normally means the event is done with,
 * including events we intentionally ignore.
 */
const applyEvent = async (event: UnwrapWebhookEvent): Promise<void> => {
  switch (event.type) {
    // Entitlement transitions. All of them carry the whole subscription, so the
    // mirror is simply overwritten and `status` decides what the user can do.
    //
    //   active     → paid up, grant access
    //   renewed    → next period charged, extend
    //   on_hold    → renewal failed, suspend but keep the row recoverable
    //   failed     → initial mandate never authorised; terminal, never grant
    //   cancelled  → ended by customer or us
    //   expired    → term ran out
    case "subscription.active":
    case "subscription.renewed":
    case "subscription.on_hold":
    case "subscription.failed":
    case "subscription.cancelled":
    case "subscription.expired":
    case "subscription.plan_changed":
    case "subscription.updated": {
      const userId = await syncSubscription(event.data);
      if (userId) {
        // Not awaited — see notifySubscriptionEvent's own doc comment. The webhook
        // ack must not wait on Resend.
        notifySubscriptionEvent(event.type, userId, event.data).catch((error) =>
          console.error(`[Email] ${event.type} notification failed for user ${userId}:`, error)
        );
      }
      return;
    }

    // Payments are recorded for support and reconciliation, not for entitlement:
    // a subscription's own events are the authority on access. Fulfilling on
    // payment alone double-grants, since a renewal fires both.
    case "payment.succeeded":
    case "payment.failed":
      console.log(`[Dodo] ${event.type} for payment ${event.data.payment_id}`);
      // TODO: persist to a `payment` model for the billing history screen.
      return;

    case "refund.succeeded":
    case "dispute.opened":
    case "dispute.lost":
      // TODO: revoking access on a chargeback is a policy decision, not a
      // technical one. Left unhandled until that policy exists.
      console.warn(`[Dodo] ${event.type} received and not yet handled`);
      return;

    default:
      // Unknown or unsubscribed event types are acknowledged, never failed.
      // Dodo adds events over time, and retrying something we will never
      // understand just burns the retry budget.
      console.log(`[Dodo] Ignoring event type ${event.type}`);
      return;
  }
};

export const handleDodoWebhook = async (req: Request, res: Response): Promise<void> => {
  // Guarantees the raw-body mounting above is actually in place. Without this the
  // failure mode is a signature mismatch, which reads like a wrong secret and
  // sends you looking in the wrong place.
  if (!Buffer.isBuffer(req.body)) {
    console.error(
      "[Dodo] Webhook body is not a Buffer — the route must be mounted with express.raw() before express.json()"
    );
    res.status(500).json({ success: false, message: "Webhook receiver misconfigured" });
    return;
  }

  const webhookId = req.header("webhook-id");
  const webhookSignature = req.header("webhook-signature");
  const webhookTimestamp = req.header("webhook-timestamp");

  if (!webhookId || !webhookSignature || !webhookTimestamp) {
    res.status(400).json({ success: false, message: "Missing webhook headers" });
    return;
  }

  // Resolved before the verification block so that a missing API key or webhook
  // secret is reported as the configuration error it is, rather than surfacing as
  // "invalid signature" and sending you hunting for a mismatched secret.
  let client: ReturnType<typeof dodo>;
  try {
    client = dodo();
  } catch (error) {
    console.error("[Dodo] Webhook receiver is not configured:", error);
    res.status(500).json({ success: false, message: "Webhook receiver misconfigured" });
    return;
  }

  let event: UnwrapWebhookEvent;
  try {
    // Verifies the signature and the timestamp, then parses. Throws on any of
    // those failing, which is the only thing standing between this endpoint and
    // anyone who learns its URL.
    event = client.webhooks.unwrap(req.body.toString("utf8"), {
      headers: {
        "webhook-id": webhookId,
        "webhook-signature": webhookSignature,
        "webhook-timestamp": webhookTimestamp,
      },
    });
  } catch (error) {
    console.error("[Dodo] Webhook signature verification failed:", error);
    res.status(401).json({ success: false, message: "Invalid signature" });
    return;
  }

  // Claim the delivery before doing any work. Losing the race means a duplicate,
  // which has already been handled or is being handled right now — either way
  // this delivery is done.
  try {
    await prisma.processedWebhook.create({ data: { webhookId, eventType: event.type } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    console.error("[Dodo] Could not record webhook:", error);
    res.status(500).json({ success: false, message: "Could not record webhook" });
    return;
  }

  try {
    await applyEvent(event);
  } catch (error) {
    // Release the claim so Dodo's next attempt is allowed to try again, rather
    // than being turned away as a duplicate of a delivery that never landed.
    await prisma.processedWebhook
      .deleteMany({ where: { webhookId } })
      .catch((cleanupError) => console.error("[Dodo] Could not release webhook claim:", cleanupError));

    console.error(`[Dodo] Failed to handle ${event.type}:`, error);
    res.status(500).json({ success: false, message: "Webhook handler failed" });
    return;
  }

  res.status(200).json({ received: true });
};
