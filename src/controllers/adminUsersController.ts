import { Request, Response } from "express";
import type { Prisma, Subscription } from "@prisma/client";

import { prisma } from "../utils/db";
import { PLANS, planForProductId, type Plan } from "../lib/billing/plans";

/**
 * Admin views over `User` — a list grid with search/role/status filters, and a
 * per-user detail (profile, plan, and billing/auth/account activity history).
 *
 * Entirely read-only: there is no admin action here that writes to somebody
 * else's account.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * The subscription that decides a user's plan — prefer one that is actually
 * active, fall back to the newest row otherwise. The same rule
 * `billingController.ts`'s `currentSubscription` applies for a single user;
 * this operates on an already-fetched, already-grouped batch for a whole page.
 */
const pickCurrent = (subs: Subscription[]): Subscription | null =>
  subs.find((s) => s.status === "active") ?? subs[0] ?? null;

const planFor = (sub: Subscription | null): Plan =>
  sub?.status === "active" ? planForProductId(sub.productId)?.plan ?? PLANS.starter : PLANS.free;

type ActivityCategory = "billing" | "auth" | "account";

interface ActivityEntry {
  id: string;
  category: ActivityCategory;
  title: string;
  description: string | null;
  at: Date;
}

const titleCase = (value: string): string =>
  value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Billing, auth and account-lifecycle history for one user, merged into a
 * single timeline.
 *
 * Nothing here is an append-only event log at the source: `Subscription` is
 * upserted in place per `dodoSubscriptionId` (one row per real subscription,
 * not one per status change — see dodoWebhookController.ts), so a
 * subscription contributes its current state as of `updatedAt`, not every
 * transition it went through. `Session` rows double as sign-in events since
 * Better Auth creates one per login and this codebase has no separate auth
 * log.
 */
const buildActivity = (
  subscriptions: Subscription[],
  sessions: { id: string; createdAt: Date; ipAddress: string | null; userAgent: string | null }[],
  accounts: { id: string; providerId: string; createdAt: Date }[],
  auditLog: { id: string; action: string; detail: string | null; createdAt: Date }[]
): ActivityEntry[] => {
  const billing: ActivityEntry[] = subscriptions.map((sub) => {
    const plan = planForProductId(sub.productId)?.plan;
    const renews = sub.currentPeriodEnd
      ? `${sub.cancelAtPeriodEnd ? "cancels" : "renews"} ${sub.currentPeriodEnd.toISOString().slice(0, 10)}`
      : "no renewal date on file";
    return {
      id: `sub:${sub.id}`,
      category: "billing",
      title: `Subscription ${sub.status}`,
      description: `${plan?.label ?? sub.productId} · ${renews}`,
      at: sub.updatedAt,
    };
  });

  const auth: ActivityEntry[] = [
    ...sessions.map((s) => ({
      id: `session:${s.id}`,
      category: "auth" as const,
      title: "Signed in",
      description: [s.ipAddress, s.userAgent].filter(Boolean).join(" · ") || null,
      at: s.createdAt,
    })),
    ...accounts.map((a) => ({
      id: `account:${a.id}`,
      category: "auth" as const,
      title: a.providerId === "credential" ? "Created password login" : `Connected ${titleCase(a.providerId)} account`,
      description: null,
      at: a.createdAt,
    })),
  ];

  const account: ActivityEntry[] = auditLog.map((entry) => ({
    id: `audit:${entry.id}`,
    category: "account",
    title: titleCase(entry.action),
    description: entry.detail,
    at: entry.createdAt,
  }));

  return [...billing, ...auth, ...account].sort((a, b) => b.at.getTime() - a.at.getTime());
};

const userSummarySelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  emailVerified: true,
  image: true,
  createdAt: true,
  onboardedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const listAll = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));

    // Built as an AND of conditions, not a flat object, because "active"
    // needs its own OR (below) and a flat object can only hold one OR key —
    // a second assignment would silently clobber the search filter's.
    const and: Prisma.UserWhereInput[] = [];
    if (q) {
      and.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      });
    }
    if (role === "admin" || role === "user") and.push({ role });
    if (status === "active") {
      // `deletedAt: null` alone misses every user created before this field
      // existed: MongoDB has no backfill on `prisma db push`, so those
      // documents don't carry the key at all, and Prisma's null-equality
      // filter on Mongo does not match a missing field (confirmed: it
      // matched 1 of 8 users, the only one with `deletedAt` explicitly
      // written as null). `isSet: false` is what actually catches "missing".
      and.push({ OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] });
    } else if (status === "deleted") {
      // No such gap here: a deleted account always got a real Date written
      // by userController.deleteAccount, so `not: null` already excludes
      // both null and missing correctly (verified: 0 false positives).
      and.push({ deletedAt: { not: null } });
    }
    const where: Prisma.UserWhereInput = and.length ? { AND: and } : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: userSummarySelect,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const ids = users.map((u) => u.id);

    // Batched, not per-row: one query for every subscription across this page
    // rather than N.
    const subscriptions = ids.length
      ? await prisma.subscription.findMany({ where: { userId: { in: ids } }, orderBy: { createdAt: "desc" } })
      : [];

    const subsByUser = new Map<string, Subscription[]>();
    for (const sub of subscriptions) {
      const list = subsByUser.get(sub.userId) ?? [];
      list.push(sub);
      subsByUser.set(sub.userId, list);
    }

    const rows = users.map((u) => {
      const plan = planFor(pickCurrent(subsByUser.get(u.id) ?? []));
      return {
        ...u,
        plan: { id: plan.id, label: plan.label },
        paid: plan.id !== "free",
      };
    });

    res.status(200).json({ success: true, data: { users: rows, total, page, pageSize } });
  } catch (error) {
    console.error("Admin List Users Error:", error);
    res.status(500).json({ success: false, message: "Could not load users" });
  }
};

const getOne = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...userSummarySelect,
        updatedAt: true,
        dodoCustomerId: true,
      },
    });
    if (!user) {
      res.status(404).json({ success: false, code: "UNKNOWN_USER", message: "No such user" });
      return;
    }

    const [auditLog, subscriptions, sessions, accounts] = await Promise.all([
      prisma.accountAuditLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, action: true, detail: true, createdAt: true },
      }),
      // Every subscription mirror row this user has ever had, not just the
      // one currently in force — a lapsed or superseded subscription is
      // still part of their billing history.
      prisma.subscription.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" } }),
      prisma.session.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, createdAt: true, ipAddress: true, userAgent: true },
      }),
      prisma.account.findMany({
        where: { userId: id },
        select: { id: true, providerId: true, createdAt: true },
      }),
    ]);

    const plan = planFor(pickCurrent(subscriptions));

    res.status(200).json({
      success: true,
      data: {
        user,
        plan: { id: plan.id, label: plan.label },
        paid: plan.id !== "free",
        activity: buildActivity(subscriptions, sessions, accounts, auditLog),
      },
    });
  } catch (error) {
    console.error("Admin Get User Error:", error);
    res.status(500).json({ success: false, message: "Could not load this user" });
  }
};

export const adminUsersController = {
  listAll,
  getOne,
};
