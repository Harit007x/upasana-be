import express from "express";
import { healthController } from "../controllers/healthController";
import { authRouter } from "./authRoutes";
import { billingRouter } from "./billingRoutes";
import { userRouter } from "./userRoutes";
import { adminRouter } from "./adminRoutes";
import { registrationRouter } from "./registrationRoutes";
import { inviteRouter } from "./inviteRoutes";
import { otpRouter } from "./otpRoutes";
import { scheduleRouter } from "./scheduleRoutes";
import { accommodationRouter } from "./accommodationRoutes";

export const router = express.Router();

const { getHealth } = healthController;

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Service health check (verifies database connectivity)
 *     tags: [General]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded (database unreachable)
 */
router.get("/health", getHealth);
router.use("/auth", authRouter);
router.use("/billing", billingRouter);
router.use("/users", userRouter);
router.use("/admin", adminRouter);
router.use("/registrations", registrationRouter);
router.use("/invites", inviteRouter);
router.use("/otp", otpRouter);
router.use("/schedule", scheduleRouter);
router.use("/accommodation", accommodationRouter);

// Note: the Dodo webhook is *not* mounted here. It needs the raw request body for
// signature verification, so it is registered in src/index.ts ahead of the global
// JSON parser.
