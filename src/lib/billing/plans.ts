/**
 * What each plan buys.
 *
 * One table, read by the billing controller and the pricing page. A limit that
 * lives in two places is a limit that will disagree with itself.
 *
 * Product ids are read from the environment rather than written here, because the
 * same plan is a different product in Dodo's test and live modes. They are read at
 * call time for the same reason as src/lib/dodo.ts: `dotenvFlow.config()` runs in
 * the body of src/index.ts, after the whole import graph has been evaluated.
 */

/**
 * Every plan, including the one nobody buys.
 *
 * `free` is a real plan rather than the absence of one. That is the whole shape
 * of the model: a new account is on `free` from the moment it exists, and
 * checkout moves it to a paid plan that charges immediately. There is no trial
 * state in between — see the note on `PLANS.free`.
 */
export type PlanId = "free" | "starter" | "pro" | "studio";

/** The three that have a Dodo product behind them. `free` cannot be bought. */
export type PaidPlanId = Exclude<PlanId, "free">;

/**
 * How often the customer is charged.
 *
 * Dodo prices a subscription on the product, so a plan billed two ways is two
 * products. Only the price and the product id differ between the two.
 */
export type BillingInterval = "month" | "year";

export const BILLING_INTERVALS = ["month", "year"] as const;

export const isBillingInterval = (value: unknown): value is BillingInterval =>
  typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);

export interface Plan {
  id: PlanId;
  label: string;
  /** Monthly price in whole US dollars. Display only — Dodo is the authority. */
  priceUsd: number;
  /**
   * Charged once for twelve months. Roughly a fifth off, which is what buys the
   * cash up front and the twelve months of retention.
   */
  annualPriceUsd: number;
  /**
   * Environment variable carrying this plan's monthly Dodo product id, or null
   * for a plan that is not sold. A null here is what makes `free` unbuyable:
   * `productIdForPlan` cannot be called for it and checkout refuses it outright.
   */
  productEnv: string | null;
  /** And its annual one. A different product, because Dodo prices the product. */
  annualProductEnv: string | null;
  /** Short marketing bullets for the pricing page, ascending by tier. */
  features: string[];
}

/** The plans that can be bought, in upgrade order. */
export const PAID_PLAN_IDS = ["starter", "pro", "studio"] as const;

/** Every plan, `free` first. Iterate this only when free genuinely belongs. */
export const PLAN_IDS = ["free", ...PAID_PLAN_IDS] as const;

export const PLANS: Record<PlanId, Plan> = {
  /**
   * What an account gets for signing up, before it has paid anything.
   *
   * This replaced a 7-day card-required trial. The trial was one product
   * configuration away from working, but it made every plan two states and put
   * a card between a stranger and their first use. A standing free plan says
   * the same thing more simply.
   */
  free: {
    id: "free",
    label: "Free",
    priceUsd: 0,
    annualPriceUsd: 0,
    productEnv: null,
    annualProductEnv: null,
    features: ["Core features", "Community support"],
  },
  starter: {
    id: "starter",
    label: "Starter",
    priceUsd: 19,
    // $15/month, billed yearly.
    annualPriceUsd: 180,
    productEnv: "DODO_PRODUCT_STARTER",
    annualProductEnv: "DODO_PRODUCT_STARTER_ANNUAL",
    features: ["Everything in Free", "Email support"],
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceUsd: 49,
    // $39/month, billed yearly.
    annualPriceUsd: 468,
    productEnv: "DODO_PRODUCT_PRO",
    annualProductEnv: "DODO_PRODUCT_PRO_ANNUAL",
    features: ["Everything in Starter", "Priority support"],
  },
  studio: {
    id: "studio",
    label: "Studio",
    priceUsd: 129,
    // $99/month, billed yearly.
    annualPriceUsd: 1188,
    productEnv: "DODO_PRODUCT_STUDIO",
    annualProductEnv: "DODO_PRODUCT_STUDIO_ANNUAL",
    features: ["Everything in Pro", "Dedicated support"],
  },
};

/** The plan an account is on before it has paid for anything. */
export const FREE_PLAN = PLANS.free;

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);

/**
 * Whether a value names a plan that can actually be checked out.
 *
 * Separate from `isPlanId` because "free" is a legitimate plan everywhere except
 * at checkout, where accepting it would mean asking Dodo for a product that does
 * not exist. The refusal belongs here, not in a thrown error further down.
 */
export const isPaidPlanId = (value: unknown): value is PaidPlanId =>
  typeof value === "string" && (PAID_PLAN_IDS as readonly string[]).includes(value);

/**
 * The Dodo product id for a plan on a given billing cycle.
 *
 * Throws rather than returning null when the variable is unset: a plan on the
 * pricing page that cannot be checked out is worse than a loud configuration
 * error, and every caller that legitimately tolerates an unconfigured plan
 * (the admin panel, `planForProductId`) catches this explicitly.
 */
export const productIdForPlan = (
  planId: PaidPlanId,
  interval: BillingInterval = "month"
): string => {
  const plan = PLANS[planId];
  const key = interval === "year" ? plan.annualProductEnv : plan.productEnv;
  // Only reachable if a paid plan is ever given a null env name, which would be
  // a mistake in the table above rather than a missing variable in a deployment.
  if (!key) throw new Error(`${plan.label} has no Dodo product and cannot be sold`);
  const value = process.env[key];

  if (!value) {
    throw new Error(
      `${key} is not set. Create the ${plan.label} ${
        interval === "year" ? "annual" : "monthly"
      } product in Dodo and add its id — see .env.example.`
    );
  }
  return value;
};

/**
 * Which plan a stored subscription is for, and on which cycle.
 *
 * Answers null for a product id we do not recognise, which is a real case rather
 * than a defensive one: a subscription created from the Dodo dashboard, or one
 * left over from a product that has since been replaced. The caller decides what
 * an unknown product is worth — this file does not guess a plan for it.
 */
export const planForProductId = (
  productId: string | null | undefined
): { plan: Plan; interval: BillingInterval } | null => {
  if (!productId) return null;
  // Paid plans only: `free` has no product, so it can never be the answer to
  // "which plan is this product id".
  for (const id of PAID_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      // Compared against the environment on every call rather than a map built
      // at import time, so a redeploy that changes a product id does not need a
      // process restart to be believed.
      let configured: string | undefined;
      try {
        configured = productIdForPlan(id, interval);
      } catch {
        continue; // Not configured in this environment; not a match.
      }
      if (configured === productId) return { plan: PLANS[id], interval };
    }
  }
  return null;
};

/** The price actually charged for a plan on a cycle, in whole US dollars. */
export const priceFor = (plan: Plan, interval: BillingInterval): number =>
  interval === "year" ? plan.annualPriceUsd : plan.priceUsd;

/**
 * What buying a year saves against twelve monthly charges, as a percentage.
 *
 * Derived rather than written down, so the badge on the pricing page cannot
 * advertise a discount the prices do not give.
 */
export const annualSavingPercent = (plan: Plan): number =>
  // A free plan has no monthly price to divide by, and 0/0 would put NaN on the
  // pricing page. Nothing is saved by buying nothing.
  plan.priceUsd > 0 ? Math.round((1 - plan.annualPriceUsd / (plan.priceUsd * 12)) * 100) : 0;
