import DodoPayments from "dodopayments";

/**
 * The Dodo Payments client, built on first use rather than at import time.
 *
 * That matters here: `dotenvFlow.config()` runs in the body of src/index.ts,
 * which is *after* every `import` in the module graph has already been
 * evaluated. Reading `process.env` at import time would therefore see whatever
 * happened to be in the environment before dotenv-flow's overrides were applied.
 * Deferring the read until the first request sidesteps the ordering entirely.
 */
let client: DodoPayments | null = null;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to your .env — see .env.example for where to get the value.`
    );
  }
  return value;
};

/** `test_mode` unless explicitly told otherwise, so a missing var cannot bill anyone. */
export const dodoEnvironment = (): "test_mode" | "live_mode" =>
  process.env.DODO_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";

export const dodo = (): DodoPayments => {
  if (client) return client;

  if (process.env.NODE_ENV === "production" && dodoEnvironment() === "test_mode") {
    console.warn(
      "⚠️  Dodo Payments is in test_mode while NODE_ENV=production. Real customers cannot pay. Set DODO_ENVIRONMENT=live_mode."
    );
  }

  client = new DodoPayments({
    bearerToken: requireEnv("DODO_PAYMENTS_API_KEY"),
    environment: dodoEnvironment(),
    // Used by `client.webhooks.unwrap()` to verify signatures.
    webhookKey: requireEnv("DODO_PAYMENTS_WEBHOOK_KEY"),
  });

  return client;
};

/**
 * Product ids live in src/lib/billing/plans.ts, alongside what each plan buys —
 * `productIdForPlan()` is the lookup.
 */
