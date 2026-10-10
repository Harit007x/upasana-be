import { Request, Response } from "express";
import { prisma } from "../utils/db";
import { dodo } from "../lib/dodo";
import {
  BILLING_INTERVALS,
  BillingInterval,
  PAID_PLAN_IDS,
  PLANS,
  PLAN_IDS,
  Plan,
  annualSavingPercent,
  isBillingInterval,
  isPaidPlanId,
  priceFor,
  productIdForPlan,
  planForProductId,
} from "../lib/billing/plans";

/**
 * Customer-facing billing endpoints. Every route here runs behind `protect`, so
 * `req.user` is the authenticated user and the client never gets to say *which*
 * user or customer it is acting for.
 */

/** The reasons an account can be treated as free, for the dashboard's copy. */
type FreeReason = "NO_SUBSCRIPTION" | "SUBSCRIPTION_INCOMPLETE" | "SUBSCRIPTION_INACTIVE" | null;

/**
 * The subscription row that decides what a user gets right now.
 *
 * A user can end up with more than one `Subscription` row — an abandoned
 * checkout, a cancelled plan, a new one after that — so this picks the one
 * that matters: the active one if there is any, otherwise the most recently
 * created row, otherwise nothing at all. Kept as one function so every reader
 * agrees on which subscription is "current" rather than each picking its own.
 */
const currentSubscription = async (userId: string) => {
  const subscriptions = await prisma.subscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return subscriptions.find((s) => s.status === "active") ?? subscriptions[0] ?? null;
};

/**
 * Returns the Dodo customer id for a user, creating it on first use.
 *
 * Deliberately lazy: a user who never subscribes is never sent to the payment
 * provider. The id is cached on the user row so we do not create a duplicate
 * customer on every checkout attempt.
 */
const ensureDodoCustomer = async (userId: string): Promise<string> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, dodoCustomerId: true },
  });

  if (!user) throw new Error(`User ${userId} not found`);
  if (user.dodoCustomerId) return user.dodoCustomerId;

  const customer = await dodo().customers.create({
    email: user.email,
    name: user.name,
    // Lets us resolve a webhook back to a user even if the local row is missing.
    metadata: { userId: user.id },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { dodoCustomerId: customer.customer_id },
  });

  return customer.customer_id;
};

/**
 * Starts a subscription. Answers with a hosted checkout URL for the client to
 * redirect to; nothing is granted here — the local mirror follows the
 * `subscription.active` webhook.
 */
const createCheckoutSession = async (req: Request, res: Response): Promise<void> => {
  try {
    // The client names a plan, never a product id: a raw id from the body would
    // let anyone subscribe themselves to any product in the Dodo account,
    // including one priced at zero.
    const planId = req.body?.plan ?? "starter";
    // `isPaidPlanId`, not `isPlanId`: "free" is a real plan everywhere else, but
    // it has no Dodo product, so checking out on it is a request that cannot be
    // fulfilled. Refusing here names the reason; letting it through would fail
    // later as a missing product id and read like a deployment gap.
    if (!isPaidPlanId(planId)) {
      res.status(422).json({
        success: false,
        code: "UNKNOWN_PLAN",
        message: `Unknown plan. Choose one of: ${PAID_PLAN_IDS.join(", ")}`,
      });
      return;
    }

    // Which cycle. Defaulted rather than required, so a client written before
    // annual existed still checks out on the monthly product.
    const interval = req.body?.interval ?? "month";
    if (!isBillingInterval(interval)) {
      res.status(422).json({
        success: false,
        code: "UNKNOWN_INTERVAL",
        message: `Unknown billing interval. Choose one of: ${BILLING_INTERVALS.join(", ")}`,
      });
      return;
    }

    let productId: string;
    try {
      productId = productIdForPlan(planId, interval);
    } catch (error) {
      // A plan that exists in code but has no product id in this environment is
      // a deployment gap, not a bad request. Reporting it as a 500 sends whoever
      // is on call looking for a crash instead of a missing variable.
      console.error("Checkout Session Error:", error);
      res.status(503).json({
        success: false,
        code: "PLAN_UNAVAILABLE",
        message: "That plan is not available right now",
      });
      return;
    }

    const customerId = await ensureDodoCustomer(req.user.id);

    const session = await dodo().checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { customer_id: customerId },
      return_url: `${process.env.FRONTEND_URL}/billing/return`,
      // Carried through onto the subscription, so a webhook can be tied back to
      // a user without a round trip.
      metadata: { userId: req.user.id, planId, interval },

      // Pins the currency. Dodo locks a subscription's currency after the first
      // successful charge, so a plan billed in the wrong one cannot be corrected
      // later without cancelling and re-subscribing a real customer.
      //
      // Note this field is ignored unless *adaptive pricing* is enabled on the
      // Dodo account — with it disabled the product's own currency already
      // applies to everyone, which is the same outcome. Setting it here means
      // the behaviour does not change if that account setting is ever turned on.
      //
      // `billing_address` is deliberately not sent: it is the customer's
      // address, not ours, and asserting a country we do not know would put a
      // false address on a real invoice. Dodo collects it at checkout.
      billing_currency: "USD",
    });

    if (!session.checkout_url) {
      res.status(502).json({ success: false, message: "Payment provider returned no checkout URL" });
      return;
    }

    res.status(200).json({ success: true, data: { url: session.checkout_url } });
  } catch (error) {
    console.error("Checkout Session Error:", error);
    res.status(500).json({ success: false, message: "Could not start checkout" });
  }
};

/**
 * Hands back a link to Dodo's hosted customer portal, where the user updates
 * their payment method, cancels, or downloads invoices. Cheaper and safer than
 * rebuilding any of that ourselves.
 */
const createPortalSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dodoCustomerId } = (await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { dodoCustomerId: true },
    })) ?? { dodoCustomerId: null };

    // No customer means they have never been to checkout, so there is nothing to
    // manage. Saying so beats creating an empty customer as a side effect.
    if (!dodoCustomerId) {
      res.status(404).json({ success: false, message: "No billing account yet" });
      return;
    }

    const session = await dodo().customers.customerPortal.create(dodoCustomerId, {
      return_url: `${process.env.FRONTEND_URL}/settings`,
    });

    res.status(200).json({ success: true, data: { url: session.link } });
  } catch (error) {
    console.error("Portal Session Error:", error);
    res.status(500).json({ success: false, message: "Could not open the billing portal" });
  }
};

/**
 * The app's own view of the user's subscription. Read from the local mirror,
 * never from the Dodo API: this is on the hot path for the dashboard, and the
 * mirror is kept current by webhooks.
 *
 * `plan` is never null: an account with no active subscription is on Free,
 * exactly like a brand-new signup. `freeReason` says why, so the dashboard can
 * tell "you never subscribed" from "your subscription lapsed" — both land on
 * Free, but they read very differently to the person seeing them.
 */
const getSubscription = async (req: Request, res: Response): Promise<void> => {
  try {
    const current = await currentSubscription(req.user.id);
    const subscription = current && {
      dodoSubscriptionId: current.dodoSubscriptionId,
      productId: current.productId,
      status: current.status,
      currentPeriodEnd: current.currentPeriodEnd,
      cancelAtPeriodEnd: current.cancelAtPeriodEnd,
    };

    let isActive = false;
    let freeReason: FreeReason = null;
    let plan: Plan;
    let interval: BillingInterval = "month";

    if (!current) {
      // Never subscribed at all.
      freeReason = "NO_SUBSCRIPTION";
      plan = PLANS.free;
    } else if (current.status === "active") {
      isActive = true;
      const resolved = planForProductId(current.productId);
      if (resolved) {
        plan = resolved.plan;
        interval = resolved.interval;
      } else {
        // A product id this build does not recognise on an otherwise-active
        // subscription is a configuration drift, not a reason to crash the
        // dashboard. Falling back to Starter keeps the account looking paid
        // while whoever is on call sees the warning and fixes the mapping.
        console.warn(`Active subscription with unrecognised product id: ${current.productId}`);
        plan = PLANS.starter;
      }
    } else if (current.status === "failed" || current.status === "pending") {
      // Never made it to active — an incomplete or failed first charge.
      freeReason = "SUBSCRIPTION_INCOMPLETE";
      plan = PLANS.free;
    } else {
      // Paid before, not paid now (cancelled, expired, on_hold, ...).
      freeReason = "SUBSCRIPTION_INACTIVE";
      plan = PLANS.free;
    }

    res.status(200).json({
      success: true,
      data: {
        subscription,
        isActive,
        freeReason,
        plan: {
          id: plan.id,
          label: plan.label,
          // What they are actually charged, on the cycle they are on — not the
          // monthly price with a yearly subscription behind it. Zero on free.
          priceUsd: priceFor(plan, interval),
          interval,
        },
      },
    });
  } catch (error) {
    console.error("Get Subscription Error:", error);
    res.status(500).json({ success: false, message: "Could not load your subscription" });
  }
};

/**
 * What is on sale.
 *
 * Served rather than duplicated in the frontend so the pricing page and the
 * plans actually sold can never disagree.
 *
 * `free` is served as a plan like any other. A pricing page that invents its
 * own free column with its own hardcoded numbers is exactly the drift this
 * endpoint exists to prevent.
 */
const getPlans = async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({
    success: true,
    data: {
      plans: PLAN_IDS.map((id) => {
        // The env var names are ours, not the customer's business.
        const { productEnv, annualProductEnv, ...plan } = PLANS[id];
        return {
          ...plan,
          // Derived here rather than written into the page, so the badge cannot
          // advertise a discount the prices do not actually give.
          annualSavingPercent: annualSavingPercent(PLANS[id]),
          annualMonthlyEquivalent: Math.round(PLANS[id].annualPriceUsd / 12),
        };
      }),
    },
  });
};

export const billingController = {
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  getPlans,
};
