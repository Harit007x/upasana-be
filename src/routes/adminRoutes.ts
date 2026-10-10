import express from "express";
import { adminController } from "../controllers/adminController";
import { adminUsersController } from "../controllers/adminUsersController";
import { adminPlansController } from "../controllers/adminPlansController";
import { adminInvitesController } from "../controllers/adminInvitesController";
import { adminSampleDataController } from "../controllers/adminSampleDataController";
import { protect, requireAdmin } from "../middlewares/authMiddleware";

export const adminRouter = express.Router();

const { getMe } = adminController;

/**
 * @openapi
 * tags:
 *   name: Admin
 *   description: Admin-only endpoints, gated by an admin role on the caller
 */

// Every route below requires both a valid session AND an admin role. There is
// no self-serve way to acquire that role — see the comment on `User.role` in
// schema.prisma.
adminRouter.use(protect, requireAdmin);

/**
 * @openapi
 * /admin/me:
 *   get:
 *     summary: The signed-in admin's own record
 *     description: >
 *       Cheap way for the admin panel to confirm the session it holds is both
 *       valid and actually admin — a 403 here means the account is signed in
 *       but not promoted, distinct from a 401 meaning not signed in at all.
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: The admin user
 *       401:
 *         description: Not signed in
 *       403:
 *         description: Signed in but not an admin
 */
adminRouter.get("/me", getMe);

/**
 * @openapi
 * tags:
 *   name: Admin Users
 *   description: Read-only user list and detail — accounts, status, plan and activity history
 */
const { listAll: listUsers, getOne: getUser } = adminUsersController;

/**
 * @openapi
 * /admin/users:
 *   get:
 *     summary: List users, filterable and paginated
 *     tags: [Admin Users]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Matches name or email, case-insensitive
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [user, admin] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, deleted] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: A page of users, each with its resolved plan
 */
adminRouter.get("/users", listUsers);

/**
 * @openapi
 * /admin/users/{id}:
 *   get:
 *     summary: One user's profile, plan, and account activity history
 *     tags: [Admin Users]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The user
 *       404:
 *         description: Unknown user id (`UNKNOWN_USER`)
 */
adminRouter.get("/users/:id", getUser);

/**
 * @openapi
 * tags:
 *   name: Admin Plans
 *   description: Read-only view of the plan table — pricing and Dodo product wiring
 */
const { listAll: listPlans } = adminPlansController;

/**
 * @openapi
 * /admin/plans:
 *   get:
 *     summary: Every plan, including free, with its resolved Dodo product ids
 *     description: >
 *       Plans are code-defined constants (src/lib/billing/plans.ts), not
 *       database rows — there is no edit endpoint. Product ids are resolved
 *       from the environment at request time, exactly as checkout resolves
 *       them, so a plan whose env var is unset in this deployment reports
 *       `productId: null` rather than a 500.
 *     tags: [Admin Plans]
 *     responses:
 *       200:
 *         description: All plans, free first
 */
adminRouter.get("/plans", listPlans);

/**
 * @openapi
 * tags:
 *   name: Admin Team
 *   description: Who the admins are, and inviting more of them
 */
const { listTeam, createInvite, revokeInvite } = adminInvitesController;

/**
 * @openapi
 * /admin/team:
 *   get:
 *     summary: Current admins and pending invites
 *     tags: [Admin Team]
 *     responses:
 *       200:
 *         description: "`{ admins, invites, delivery }` — admins oldest first, pending invites newest first, and whether email and WhatsApp sending are configured"
 */
adminRouter.get("/team", listTeam);

/**
 * @openapi
 * /admin/invites:
 *   post:
 *     summary: Invite someone to be an admin, by email or mobile
 *     description: >
 *       Creates a single-use link that expires in 7 days and revokes any earlier
 *       pending link for the same address, then sends it — by email (Resend)
 *       or on WhatsApp (MSG91). The `url` is always returned so the admin can
 *       share it themselves; `sent` says whether the server delivered it and
 *       `notSentReason` (not_configured | failed) why not.
 *     tags: [Admin Team]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 properties:
 *                   channel: { type: string, enum: [email] }
 *                   email: { type: string }
 *                   name: { type: string }
 *               - type: object
 *                 properties:
 *                   channel: { type: string, enum: [mobile] }
 *                   mobile: { type: string, description: "E.164, e.g. +919876543210" }
 *                   name: { type: string }
 *     responses:
 *       201:
 *         description: "`{ invite, url, sent, notSentReason? }`"
 *       400:
 *         description: VALIDATION_ERROR
 *       409:
 *         description: ALREADY_ADMIN — that email already belongs to an admin
 */
adminRouter.post("/invites", createInvite);

/**
 * @openapi
 * /admin/invites/{id}:
 *   delete:
 *     summary: Revoke a pending invite
 *     tags: [Admin Team]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Revoked
 *       404:
 *         description: NOT_FOUND — no pending invite with that id
 */
adminRouter.delete("/invites/:id", revokeInvite);

const {
  status: sampleDataStatus,
  add: addSampleData,
  remove: removeSampleData,
} = adminSampleDataController;

/**
 * @openapi
 * /admin/sample-data:
 *   get:
 *     summary: How many dummy registrations are loaded
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ count, total }`"
 *   post:
 *     summary: Load the dummy registrations
 *     description: Adds any of the 64 samples that are missing. Real registrations are not touched.
 *     tags: [Admin]
 *     responses:
 *       201:
 *         description: "`{ added, count }`"
 *       409:
 *         description: SAMPLE_CODES_TAKEN — a real registration holds a sample code
 *   delete:
 *     summary: Remove the dummy registrations
 *     description: Deletes only registrations flagged as samples.
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: "`{ removed, count }`"
 */
adminRouter.get("/sample-data", sampleDataStatus);
adminRouter.post("/sample-data", addSampleData);
adminRouter.delete("/sample-data", removeSampleData);
