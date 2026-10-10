import express from "express";
import { billingController } from "../controllers/billingController";
import { protect } from "../middlewares/authMiddleware";

export const billingRouter = express.Router();

const { createCheckoutSession, createPortalSession, getSubscription, getPlans } =
  billingController;

/**
 * @openapi
 * tags:
 *   name: Billing
 *   description: Subscriptions via Dodo Payments
 */

/**
 * @openapi
 * /billing/plans:
 *   get:
 *     summary: The plans on sale, with the limits each one actually buys
 *     description: >
 *       Served rather than duplicated in the frontend, so the pricing page and
 *       the limits enforced on upload and generate cannot disagree.
 *
 *       Public. It is a price list, and the page that needs it most is the one
 *       shown to someone who has no account yet.
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Every plan including `free`, with the limits each buys
 */
// Deliberately mounted ABOVE the session guard. Behind it, /pricing answered 401
// to every signed-out visitor — the exact audience the page exists for. It reads
// nothing from the request and returns a published price list, so there is
// nothing here a session would protect.
billingRouter.get("/plans", getPlans);

// Everything below acts on behalf of the signed-in user, so the session is
// required up front rather than re-checked in each handler.
billingRouter.use(protect);

/**
 * @openapi
 * /billing/checkout-session:
 *   post:
 *     summary: Start a subscription and get a hosted checkout URL
 *     tags: [Billing]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [starter, pro, studio]
 *                 default: starter
 *                 description: >
 *                   A plan id, never a product id — the client naming a raw
 *                   product could subscribe itself to anything in the account.
 *     responses:
 *       200:
 *         description: Checkout session created
 *       401:
 *         description: Not authenticated
 *       422:
 *         description: Unknown plan
 *       502:
 *         description: Payment provider returned no checkout URL
 *       503:
 *         description: That plan has no product id configured in this environment
 */
billingRouter.post("/checkout-session", createCheckoutSession);

/**
 * @openapi
 * /billing/portal-session:
 *   post:
 *     summary: Get a link to the hosted customer portal
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Portal session created
 *       404:
 *         description: User has no billing account yet
 */
billingRouter.post("/portal-session", createPortalSession);

/**
 * @openapi
 * /billing/subscription:
 *   get:
 *     summary: The signed-in user's current subscription and resolved plan
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Subscription state (null when the user has never subscribed)
 */
billingRouter.get("/subscription", getSubscription);
