import { Request, Response } from "express";

import { z } from "zod";
import { Prisma, type AccommodationPlace, type Registration } from "@prisma/client";

import {
  ALLOTTABLE_STATUSES,
  buildStayNotice,
  fullyAllotted,
  nightsOf,
  occupantsOf,
  placeInputSchema,
  roomProblem,
  sameNotice,
  stayNoticeLine,
  stayNoticeMessage,
  toAllotmentDto,
  toPlaceDto,
  withRoomIds,
  type Occupant,
  type StayNotice,
} from "../lib/accommodation";
import { EVENT_NAME } from "../lib/event";
import { WHATSAPP_TEMPLATES, isWhatsAppConfigured, sendWhatsAppTemplate } from "../lib/whatsapp";
import { registrationScope } from "../middlewares/authMiddleware";
import { prisma } from "../utils/db";

/**
 * Accommodation: places and their rooms, who sleeps where, and telling them.
 *
 * Every desk role reads (`overview`), a sanchalak only their own mandal's
 * people. The seva team (staff, admin) allots, releases and sends room
 * details; only admins add or change places. See src/lib/accommodation.ts for
 * the rules.
 */

const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Unknown id");

function validationError(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  res.status(400).json({
    success: false,
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Some details are missing or invalid.",
    errors: issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/** A refusal decided inside a transaction, answered once it has rolled back. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const refuse = (res: Response, refusal: Refusal) =>
  res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message });

/**
 * Runs a transaction, again if MongoDB aborted it because another one wrote
 * the same place at the same time (Prisma's P2034). The second attempt sees
 * the other's beds, so the room checks are made against what is really there.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!conflict || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
    }
  }
}

const byOrder = { orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }] };

/** What the team was last told, against what is allotted now. */
function noticeState(registration: Registration, current: StayNotice | null) {
  return {
    registrationId: registration.id,
    sentAt: registration.stayNoticeSentAt?.toISOString(),
    sentByName: registration.stayNoticeSentByName ?? undefined,
    // Sent, and nothing about anyone's room has changed since.
    upToDate: !!registration.stayNoticeSentAt && !!current && sameNotice(current, registration.stayNotice),
  };
}

/**
 * Everything the Accommodation screens need in one go: places with rooms,
 * every allotment the viewer may see, and for each registration with rooms
 * whether its room details were sent and are still right.
 */
const overview = async (req: Request, res: Response): Promise<void> => {
  const scope = registrationScope(req.user);
  const scoped = "mandal" in scope;

  const [places, allAllotments] = await Promise.all([
    prisma.accommodationPlace.findMany(byOrder),
    prisma.roomAllotment.findMany(),
  ]);
  const registrations = await prisma.registration.findMany({
    where: { id: { in: [...new Set(allAllotments.map((a) => a.registrationId))] }, ...scope },
  });
  const visible = new Set(registrations.map((r) => r.id));
  const allotments = scoped ? allAllotments.filter((a) => visible.has(a.registrationId)) : allAllotments;
  const placeMap = new Map(places.map((p) => [p.id, p]));

  res.status(200).json({
    success: true,
    data: {
      places: places.map(toPlaceDto),
      allotments: allotments.map(toAllotmentDto),
      notices: registrations
        .filter((r) => r.stayNoticeSentAt || allotments.some((a) => a.registrationId === r.id))
        .map((r) => noticeState(r, buildStayNotice(r, allotments, placeMap))),
      whatsApp: isWhatsAppConfigured(),
    },
  });
};

const createPlace = async (req: Request, res: Response): Promise<void> => {
  const parsed = placeInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  const last = await prisma.accommodationPlace.findFirst({ orderBy: { sortOrder: "desc" } });
  try {
    const place = await prisma.accommodationPlace.create({
      data: { ...parsed.data, rooms: withRoomIds(parsed.data.rooms), sortOrder: (last?.sortOrder ?? 0) + 1 },
    });
    res.status(201).json({ success: true, data: toPlaceDto(place) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ success: false, code: "NAME_TAKEN", message: `There is already a place called ${parsed.data.name}.` });
      return;
    }
    throw error;
  }
};

/**
 * Changes a place's details and rooms. A room with people in it cannot be
 * removed, and cannot be changed into something they no longer fit — fewer
 * beds than people on some night, or a gents room with a woman in it. The
 * team moves them first; nobody is moved silently.
 */
const updatePlace = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isObjectId(id)) return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Place not found" });
  const parsed = placeInputSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);

  try {
    const place = await withRetry(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.accommodationPlace.findUnique({ where: { id } });
        if (!existing) throw new Refusal(404, "NOT_FOUND", "Place not found");
        const rooms = withRoomIds(parsed.data.rooms, existing.rooms.map((r) => r.id));

        const allotments = await tx.roomAllotment.findMany({ where: { placeId: id } });
        const registrations = new Map(
          (
            await tx.registration.findMany({ where: { id: { in: [...new Set(allotments.map((a) => a.registrationId))] } } })
          ).map((r) => [r.id, r])
        );
        for (const old of existing.rooms) {
          const inRoom = allotments.filter((a) => a.roomId === old.id);
          if (inRoom.length === 0) continue;
          const now = rooms.find((r) => r.id === old.id);
          if (!now) {
            throw new Refusal(409, "ROOM_IN_USE", `Room ${old.label} has people in it — move them to another room first.`);
          }
          const problem = roomProblem(now, occupantsOf(inRoom, registrations));
          if (problem) throw new Refusal(409, "ROOM_IN_USE", `${problem}. Move someone out first.`);
        }

        return tx.accommodationPlace.update({
          where: { id },
          data: { ...parsed.data, rooms, version: { increment: 1 } },
        });
      })
    );
    res.status(200).json({ success: true, data: toPlaceDto(place) });
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ success: false, code: "NAME_TAKEN", message: `There is already a place called ${parsed.data.name}.` });
      return;
    }
    throw error;
  }
};

const deletePlace = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const place = isObjectId(id) ? await prisma.accommodationPlace.findUnique({ where: { id } }) : null;
  if (!place) return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Place not found" });
  const used = await prisma.roomAllotment.count({ where: { placeId: id } });
  if (used > 0) {
    res.status(409).json({
      success: false,
      code: "PLACE_IN_USE",
      message: `${used} ${used === 1 ? "person is" : "people are"} staying at ${place.name}. Move them before removing it.`,
    });
    return;
  }
  await prisma.accommodationPlace.delete({ where: { id } });
  res.status(200).json({ success: true, data: { id } });
};

const allotSchema = z.object({
  registrationId: objectId,
  memberIds: z.array(z.string().max(40)).min(1, "Pick who goes in this room").max(100),
  placeId: objectId,
  roomId: z.string().min(1).max(40),
});

/** The registration's allotments after a change, for the response. */
const allotmentsOf = (registrationId: string) =>
  prisma.roomAllotment.findMany({ where: { registrationId } }).then((rows) => rows.map(toAllotmentDto));

/**
 * Puts some of a registration's people in one room — moving them, if they
 * had a room already. Checked inside a transaction that also writes the place,
 * so two volunteers filling the same room at once cannot both get its last bed.
 */
const allot = async (req: Request, res: Response): Promise<void> => {
  const parsed = allotSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { registrationId, placeId, roomId } = parsed.data;
  const memberIds = [...new Set(parsed.data.memberIds)];

  const registration = await prisma.registration.findUnique({ where: { id: registrationId } });
  if (!registration) return void res.status(404).json({ success: false, code: "NOT_FOUND", message: "Registration not found" });
  if (!ALLOTTABLE_STATUSES.has(registration.status)) {
    res.status(409).json({
      success: false,
      code: "NOT_CONFIRMED",
      message:
        registration.status === "cancelled"
          ? `${registration.code} is cancelled.`
          : `Confirm ${registration.code} before giving it rooms.`,
    });
    return;
  }
  if (!registration.accommodationRequired) {
    res.status(409).json({
      success: false,
      code: "NO_STAY_REQUESTED",
      message: `${registration.code} did not ask for accommodation. Tick it on the registration first.`,
    });
    return;
  }
  const members = memberIds.map((id) => registration.members.find((m) => m.id === id));
  if (members.some((m) => !m)) {
    res.status(400).json({ success: false, code: "UNKNOWN_MEMBER", message: "Someone picked is no longer on this registration. Reload and try again." });
    return;
  }
  const sameDay = members.find((m) => m && nightsOf(m).length === 0);
  if (sameDay) {
    res.status(409).json({
      success: false,
      code: "NO_NIGHTS",
      message: `${sameDay.fullName} leaves the day they arrive — there is no night to give a bed for.`,
    });
    return;
  }

  try {
    await withRetry(() =>
      prisma.$transaction(async (tx) => {
        // Writing the place first is what makes a concurrent allotment into
        // it conflict, instead of both reading the same free bed.
        const place = await tx.accommodationPlace
          .update({ where: { id: placeId }, data: { version: { increment: 1 } } })
          .catch((error: unknown) => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
              throw new Refusal(404, "NOT_FOUND", "That place no longer exists. Reload and try again.");
            }
            throw error;
          });
        const room = place.rooms.find((r) => r.id === roomId);
        if (!room) throw new Refusal(404, "NOT_FOUND", "That room no longer exists. Reload and try again.");

        const inRoom = await tx.roomAllotment.findMany({ where: { placeId, roomId } });
        const others = inRoom.filter((a) => !(a.registrationId === registrationId && memberIds.includes(a.memberId)));
        const otherRegistrations = new Map(
          (
            await tx.registration.findMany({ where: { id: { in: [...new Set(others.map((a) => a.registrationId))] } } })
          ).map((r) => [r.id, r])
        );
        const incoming: Occupant[] = members.map((m) => ({
          registrationId,
          memberId: m!.id,
          fullName: m!.fullName,
          gender: m!.gender,
          nights: nightsOf(m!),
        }));
        const problem = roomProblem(room, [...occupantsOf(others, otherRegistrations), ...incoming]);
        if (problem) throw new Refusal(409, "ROOM_PROBLEM", `${problem}.`);

        for (const memberId of memberIds) {
          await tx.roomAllotment.upsert({
            where: { registrationId_memberId: { registrationId, memberId } },
            create: { registrationId, memberId, placeId, roomId, allottedByName: req.user.name },
            update: { placeId, roomId, allottedByName: req.user.name, allottedAt: new Date() },
          });
        }
      })
    );
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    throw error;
  }

  res.status(200).json({ success: true, data: await allotmentsOf(registrationId) });
};

const releaseSchema = z.object({
  registrationId: objectId,
  memberIds: z.array(z.string().max(40)).min(1, "Pick who to take out of their room").max(100),
});

/** Takes people out of their rooms. Allowed whatever the status: freeing a bed is never wrong. */
const release = async (req: Request, res: Response): Promise<void> => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.issues);
  const { registrationId, memberIds } = parsed.data;
  await prisma.roomAllotment.deleteMany({ where: { registrationId, memberId: { in: memberIds } } });
  res.status(200).json({ success: true, data: await allotmentsOf(registrationId) });
};

/** The registration with its current notice, or a refusal. */
async function noticeFor(id: string) {
  const registration = isObjectId(id) ? await prisma.registration.findUnique({ where: { id } }) : null;
  if (!registration) throw new Refusal(404, "NOT_FOUND", "Registration not found");
  if (!ALLOTTABLE_STATUSES.has(registration.status)) {
    throw new Refusal(409, "NOT_CONFIRMED", `${registration.code} is not confirmed, so its room details are not final.`);
  }
  const [allotments, places] = await Promise.all([
    prisma.roomAllotment.findMany({ where: { registrationId: id } }),
    prisma.accommodationPlace.findMany(),
  ]);
  const notice = buildStayNotice(registration, allotments, new Map(places.map((p) => [p.id, p])));
  if (!notice) throw new Refusal(409, "NOTHING_ALLOTTED", `Nobody in ${registration.code} has a room yet.`);
  const contact = registration.contactMobile ?? registration.members[0]?.mobile;
  if (!contact) throw new Refusal(409, "NO_CONTACT", `${registration.code} has no contact number to send to.`);
  return { registration, notice, contact, complete: fullyAllotted(registration, allotments) };
}

function recordSent(registration: Registration, notice: StayNotice, by: string) {
  return prisma.registration.update({
    where: { id: registration.id },
    data: {
      stayNotice: notice as unknown as Prisma.InputJsonValue,
      stayNoticeSentAt: new Date(),
      stayNoticeSentByName: by,
    },
  });
}

const sendTo = (registration: Registration, notice: StayNotice, contact: string) =>
  sendWhatsAppTemplate({
    to: contact,
    template: WHATSAPP_TEMPLATES.stayDetails(),
    body: [registration.members[0]?.fullName ?? "", EVENT_NAME, stayNoticeLine(notice)],
    usage: { endpoint: "whatsapp:stay-details" },
  });

const noticeSchema = z.object({
  /** The team member sent it from their own WhatsApp; just record it. */
  manual: z.boolean().optional(),
});

/**
 * Sends one registration its room details on WhatsApp. Without WhatsApp set
 * up on the server, answers with the message and a wa.me link instead, so a
 * team member can send it from their own phone and then mark it sent
 * (`manual: true`).
 */
const sendNotice = async (req: Request, res: Response): Promise<void> => {
  const parsed = noticeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error.issues);

  let found: Awaited<ReturnType<typeof noticeFor>>;
  try {
    found = await noticeFor(String(req.params.id));
  } catch (error) {
    if (error instanceof Refusal) return void refuse(res, error);
    throw error;
  }
  const { registration, notice, contact } = found;

  if (parsed.data.manual) {
    await recordSent(registration, notice, req.user.name);
    res.status(200).json({ success: true, data: { sent: true, channel: "manual" } });
    return;
  }

  if (!isWhatsAppConfigured()) {
    const message = stayNoticeMessage(registration, notice);
    res.status(200).json({
      success: true,
      data: {
        sent: false,
        message,
        whatsappUrl: `https://wa.me/${contact.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`,
      },
    });
    return;
  }

  try {
    await sendTo(registration, notice, contact);
  } catch (error) {
    console.error(`[WhatsApp] Room details for ${registration.code} failed:`, error);
    res.status(502).json({
      success: false,
      code: "SEND_FAILED",
      message: "WhatsApp did not accept the message. Try again, or send it from your own phone.",
    });
    return;
  }
  await recordSent(registration, notice, req.user.name);
  res.status(200).json({ success: true, data: { sent: true, channel: "whatsapp" } });
};

/**
 * "Send all": room details to every confirmed registration whose people all
 * have rooms and who has not been told — or was told something that has
 * changed since. Needs WhatsApp on the server; one by one is the fallback.
 */
const sendAllNotices = async (req: Request, res: Response): Promise<void> => {
  if (!isWhatsAppConfigured()) {
    res.status(503).json({
      success: false,
      code: "WHATSAPP_NOT_CONFIGURED",
      message: "WhatsApp is not set up on the server yet. Send room details one by one from your own phone.",
    });
    return;
  }

  const [allotments, places] = await Promise.all([prisma.roomAllotment.findMany(), prisma.accommodationPlace.findMany()]);
  const placeMap = new Map<string, AccommodationPlace>(places.map((p) => [p.id, p]));
  const registrations = await prisma.registration.findMany({
    where: { id: { in: [...new Set(allotments.map((a) => a.registrationId))] }, status: { in: [...ALLOTTABLE_STATUSES] } },
    orderBy: { sequence: "asc" },
  });

  let sent = 0;
  let incomplete = 0;
  const failed: string[] = [];
  for (const registration of registrations) {
    const notice = buildStayNotice(registration, allotments, placeMap);
    if (!notice || (registration.stayNoticeSentAt && sameNotice(notice, registration.stayNotice))) continue;
    if (!fullyAllotted(registration, allotments)) {
      incomplete++;
      continue;
    }
    const contact = registration.contactMobile ?? registration.members[0]?.mobile;
    if (!contact) {
      failed.push(registration.code);
      continue;
    }
    try {
      await sendTo(registration, notice, contact);
      await recordSent(registration, notice, req.user.name);
      sent++;
    } catch (error) {
      console.error(`[WhatsApp] Room details for ${registration.code} failed:`, error);
      failed.push(registration.code);
    }
  }

  res.status(200).json({ success: true, data: { sent, failed, incomplete } });
};

export const accommodationController = {
  overview,
  createPlace,
  updatePlace,
  deletePlace,
  allot,
  release,
  sendNotice,
  sendAllNotices,
};
