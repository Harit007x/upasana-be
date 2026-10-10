import { Request, Response } from "express";

import { PLAN_IDS, PLANS, priceFor, annualSavingPercent, productIdForPlan } from "../lib/billing/plans";

/**
 * Read-only view over the plan table (`src/lib/billing/plans.ts`). Plans are
 * code-defined constants, not database rows, so this is display only.
 *
 * Dodo product ids are resolved from the environment at request time (see
 * `productIdForPlan`), the same way checkout resolves them — so what the
 * admin panel shows is exactly what a checkout right now would use, not a
 * cached guess. `free` has no product and `productIdForPlan` throws for it
 * (and for any paid plan whose env var is unset in this deployment); both
 * cases are reported as "not configured" rather than a 500.
 */

const resolveProductId = (planId: (typeof PLAN_IDS)[number], interval: "month" | "year"): string | null => {
  if (planId === "free") return null;
  try {
    return productIdForPlan(planId, interval);
  } catch {
    return null;
  }
};

const toClientPlan = (id: (typeof PLAN_IDS)[number]) => {
  const plan = PLANS[id];
  return {
    id: plan.id,
    label: plan.label,
    priceUsd: plan.priceUsd,
    annualPriceUsd: plan.annualPriceUsd,
    annualSavingPercent: annualSavingPercent(plan),
    effectiveMonthlyOnAnnualUsd: plan.priceUsd > 0 ? Math.round((plan.annualPriceUsd / 12) * 100) / 100 : 0,
    features: plan.features,
    productEnv: plan.productEnv,
    annualProductEnv: plan.annualProductEnv,
    productId: resolveProductId(id, "month"),
    annualProductId: resolveProductId(id, "year"),
  };
};

const listAll = (_req: Request, res: Response): void => {
  res.status(200).json({ success: true, data: { plans: PLAN_IDS.map(toClientPlan) } });
};

export const adminPlansController = {
  listAll,
};
