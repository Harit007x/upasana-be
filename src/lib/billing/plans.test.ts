/**
 * The plan table is read by the billing controller and the pricing page. Most
 * of what is asserted here is consistency between those readers rather than
 * any single value: a limit that disagrees with itself is the failure this
 * table exists to prevent, and it is silent — nobody notices a customer being
 * billed against the wrong number.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  annualSavingPercent,
  BILLING_INTERVALS,
  isBillingInterval,
  isPaidPlanId,
  isPlanId,
  PAID_PLAN_IDS,
  PLAN_IDS,
  PLANS,
  planForProductId,
  priceFor,
  productIdForPlan,
} from "./plans";

const ENV_KEYS = [
  "DODO_PRODUCT_STARTER",
  "DODO_PRODUCT_STARTER_ANNUAL",
  "DODO_PRODUCT_PRO",
  "DODO_PRODUCT_PRO_ANNUAL",
  "DODO_PRODUCT_STUDIO",
  "DODO_PRODUCT_STUDIO_ANNUAL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the table itself", () => {
  it("lists free first and every paid plan after it", () => {
    expect(PLAN_IDS).toEqual(["free", ...PAID_PLAN_IDS]);
  });

  it("keys every plan by its own id", () => {
    for (const id of PLAN_IDS) expect(PLANS[id].id).toBe(id);
  });

  it("increases price monotonically up the paid ladder", () => {
    for (let i = 1; i < PAID_PLAN_IDS.length; i++) {
      const lower = PLANS[PAID_PLAN_IDS[i - 1]];
      const upper = PLANS[PAID_PLAN_IDS[i]];
      expect(upper.priceUsd).toBeGreaterThan(lower.priceUsd);
      expect(upper.annualPriceUsd).toBeGreaterThan(lower.annualPriceUsd);
    }
  });

  it("makes free unbuyable and every paid plan buyable", () => {
    expect(PLANS.free.productEnv).toBeNull();
    expect(PLANS.free.annualProductEnv).toBeNull();
    for (const id of PAID_PLAN_IDS) {
      expect(PLANS[id].productEnv).toBeTruthy();
      expect(PLANS[id].annualProductEnv).toBeTruthy();
    }
  });

  it("prices a year below twelve months, so the annual badge is never a lie", () => {
    for (const id of PAID_PLAN_IDS) {
      const plan = PLANS[id];
      expect(plan.annualPriceUsd).toBeLessThan(plan.priceUsd * 12);
    }
  });

  it("gives every plan at least one feature bullet", () => {
    for (const id of PLAN_IDS) {
      expect(Array.isArray(PLANS[id].features)).toBe(true);
      expect(PLANS[id].features.length).toBeGreaterThan(0);
    }
  });
});

describe("guards", () => {
  it("recognises exactly the plan ids", () => {
    for (const id of PLAN_IDS) expect(isPlanId(id)).toBe(true);
    for (const junk of ["", "FREE", "enterprise", null, undefined, 0, {}, ["free"]]) {
      expect(isPlanId(junk)).toBe(false);
    }
  });

  it("refuses free at checkout while still calling it a plan", () => {
    expect(isPlanId("free")).toBe(true);
    expect(isPaidPlanId("free")).toBe(false);
    for (const id of PAID_PLAN_IDS) expect(isPaidPlanId(id)).toBe(true);
  });

  it("recognises exactly the billing intervals", () => {
    for (const i of BILLING_INTERVALS) expect(isBillingInterval(i)).toBe(true);
    for (const junk of ["monthly", "yearly", "", null, 1]) expect(isBillingInterval(junk)).toBe(false);
  });
});

describe("productIdForPlan", () => {
  it("reads the plan and cycle's own variable", () => {
    process.env.DODO_PRODUCT_PRO = "prod_pro_m";
    process.env.DODO_PRODUCT_PRO_ANNUAL = "prod_pro_y";
    expect(productIdForPlan("pro", "month")).toBe("prod_pro_m");
    expect(productIdForPlan("pro", "year")).toBe("prod_pro_y");
  });

  it("defaults to the monthly cycle", () => {
    process.env.DODO_PRODUCT_PRO = "prod_pro_m";
    expect(productIdForPlan("pro")).toBe("prod_pro_m");
  });

  it("names the missing variable for every plan and cycle", () => {
    expect(() => productIdForPlan("starter", "month")).toThrow(/DODO_PRODUCT_STARTER/);
    expect(() => productIdForPlan("starter", "year")).toThrow(/STARTER_ANNUAL/);
    expect(() => productIdForPlan("pro", "month")).toThrow(/DODO_PRODUCT_PRO/);
  });

  it("names the missing variable rather than failing checkout opaquely", () => {
    expect(() => productIdForPlan("studio", "year")).toThrow(/DODO_PRODUCT_STUDIO_ANNUAL/);
    expect(() => productIdForPlan("studio", "year")).toThrow(/\.env\.example/);
  });

  it("is read at call time, so a redeployed id needs no restart", () => {
    process.env.DODO_PRODUCT_PRO = "first";
    expect(productIdForPlan("pro")).toBe("first");
    process.env.DODO_PRODUCT_PRO = "second";
    expect(productIdForPlan("pro")).toBe("second");
  });

  it("treats an empty string as unset rather than as a product id", () => {
    process.env.DODO_PRODUCT_PRO = "";
    expect(() => productIdForPlan("pro")).toThrow(/DODO_PRODUCT_PRO/);
  });
});

describe("planForProductId", () => {
  beforeEach(() => {
    process.env.DODO_PRODUCT_STARTER = "p_start_m";
    process.env.DODO_PRODUCT_STARTER_ANNUAL = "p_start_y";
    process.env.DODO_PRODUCT_PRO = "p_pro_m";
    process.env.DODO_PRODUCT_PRO_ANNUAL = "p_pro_y";
  });

  it("answers the plan and cycle behind a known product", () => {
    expect(planForProductId("p_pro_y")).toEqual({ plan: PLANS.pro, interval: "year" });
    expect(planForProductId("p_start_m")).toEqual({ plan: PLANS.starter, interval: "month" });
  });

  it("answers null for a product this build does not know", () => {
    expect(planForProductId("prod_from_the_dashboard")).toBeNull();
  });

  it("answers null for nothing at all, rather than guessing", () => {
    expect(planForProductId(null)).toBeNull();
    expect(planForProductId(undefined)).toBeNull();
    expect(planForProductId("")).toBeNull();
  });

  it("skips a plan this environment has not configured instead of throwing", () => {
    // Studio has no product id here; the lookup must still answer for Pro.
    expect(planForProductId("p_pro_m")).toEqual({ plan: PLANS.pro, interval: "month" });
  });

  it("never answers free, which has no product to be bought with", () => {
    for (const id of ["p_start_m", "p_start_y", "p_pro_m", "p_pro_y"]) {
      expect(planForProductId(id)?.plan.id).not.toBe("free");
    }
  });
});

describe("pricing display", () => {
  it("charges the cycle's own price", () => {
    expect(priceFor(PLANS.pro, "month")).toBe(PLANS.pro.priceUsd);
    expect(priceFor(PLANS.pro, "year")).toBe(PLANS.pro.annualPriceUsd);
  });

  it("derives the annual saving from the prices actually charged", () => {
    for (const id of PAID_PLAN_IDS) {
      const plan = PLANS[id];
      const expected = Math.round((1 - plan.annualPriceUsd / (plan.priceUsd * 12)) * 100);
      expect(annualSavingPercent(plan)).toBe(expected);
      expect(annualSavingPercent(plan)).toBeGreaterThan(0);
    }
  });

  it("puts zero rather than NaN on the free plan's badge", () => {
    expect(annualSavingPercent(PLANS.free)).toBe(0);
  });
});
