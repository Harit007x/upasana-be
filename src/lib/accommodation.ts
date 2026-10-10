import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AccommodationPlace, Registration, RoomAllotment } from "@prisma/client";

import { EVENT_NAME, MOBILE_E164, NIGHTS, formatDay } from "./event";

/**
 * Where devotees stay: places (guest houses, later hotels) with rooms, and one
 * allotment per person.
 *
 * A person's nights come from their own arrival and departure, so a bed freed
 * after the first night can go to someone arriving for the second. The rules
 * for who may share a room (`roomProblem`) are mirrored in the frontend's
 * src/features/accommodation/rules.ts, which uses them to show which rooms
 * fit before anyone presses Save; the server checks them again on every
 * allotment.
 */

export const PLACE_KINDS = ["guest_house", "hotel"] as const;
export const ROOM_KINDS = ["gents", "ladies", "family"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/**
 * Registrations whose people can be given a room. Confirmed only — checked in
 * comes after confirmed. A pending one has not been looked at yet, and a
 * cancelled one has its beds released.
 */
export const ALLOTTABLE_STATUSES = new Set(["confirmed", "checked_in"]);

type Stay = { arrival: { date: string }; departure: { date: string } };

/** The nights someone sleeps over: from their arrival day up to, not including, the day they leave. */
export function nightsOf(member: Stay): string[] {
  return NIGHTS.filter((night) => night >= member.arrival.date && night < member.departure.date);
}

/** Someone in a room, as the room rules see them. */
export type Occupant = {
  registrationId: string;
  memberId: string;
  fullName: string;
  gender: string;
  nights: string[];
};

type RoomRules = { label: string; beds: number; kind: string };

/**
 * What is wrong with these people sharing this room, or null when nothing is.
 *
 * - Gents and ladies rooms take only men or only women.
 * - A family room takes one registration's people, of any gender.
 * - On no night are there more people than beds.
 *
 * The first two are agreed for now and expected to be revisited; keep them
 * here, in one place.
 */
export function roomProblem(room: RoomRules, occupants: Occupant[]): string | null {
  if (room.kind === "gents") {
    const woman = occupants.find((o) => o.gender !== "male");
    if (woman) return `Room ${room.label} is a gents room — ${woman.fullName} is female`;
  }
  if (room.kind === "ladies") {
    const man = occupants.find((o) => o.gender !== "female");
    if (man) return `Room ${room.label} is a ladies room — ${man.fullName} is male`;
  }
  if (room.kind === "family" && new Set(occupants.map((o) => o.registrationId)).size > 1) {
    return `Room ${room.label} is a family room — one family only`;
  }
  for (const night of NIGHTS) {
    const count = occupants.filter((o) => o.nights.includes(night)).length;
    if (count > room.beds) {
      return `Room ${room.label} has ${room.beds} ${room.beds === 1 ? "bed" : "beds"} but ${count} people on the night of ${formatDay(night)}`;
    }
  }
  return null;
}

/** The people in `allotments` who still exist on their registration, ready for `roomProblem`. */
export function occupantsOf(allotments: RoomAllotment[], registrations: Map<string, Registration>): Occupant[] {
  return allotments.flatMap((a) => {
    const member = registrations.get(a.registrationId)?.members.find((m) => m.id === a.memberId);
    return member
      ? [{ registrationId: a.registrationId, memberId: a.memberId, fullName: member.fullName, gender: member.gender, nights: nightsOf(member) }]
      : [];
  });
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const roomInput = z.object({
  /** Kept from an earlier save; empty for a new room. */
  id: z.string().max(40).optional(),
  label: z.string().trim().min(1, "Give the room a number or name").max(30, "Keep the room name short"),
  beds: z.number({ error: "Enter the beds" }).int().min(1, "At least 1 bed").max(50, "At most 50 beds"),
  kind: z.enum(ROOM_KINDS, { error: "Pick gents, ladies or family" }),
  groundFloor: z.boolean(),
});

export const placeInputSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the place's name").max(120),
    kind: z.enum(PLACE_KINDS, { error: "Pick guest house or hotel" }),
    address: z.string().trim().min(3, "Enter the address").max(300),
    area: optionalText(80),
    mapUrl: optionalText(500).refine((v) => !v || /^https:\/\/\S+$/.test(v), "Paste a link starting with https://"),
    coordinatorName: optionalText(120),
    coordinatorMobile: z
      .string()
      .regex(MOBILE_E164, "Enter a valid mobile number")
      .optional()
      .nullable()
      .transform((v) => v ?? null),
    notes: optionalText(1000),
    rooms: z.array(roomInput).max(500, "At most 500 rooms in one place"),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.rooms.forEach((room, index) => {
      const key = room.label.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["rooms", index, "label"], message: `Room ${room.label} is listed twice` });
      }
      seen.set(key, index);
    });
  });

export type PlaceInput = z.infer<typeof placeInputSchema>;

/**
 * Room ids for a save: an id the place already had is kept (allotments point
 * at it, so renaming room "12" to "G-12" keeps its people); anything else
 * gets a new one.
 */
export function withRoomIds(rooms: PlaceInput["rooms"], existingIds: readonly string[] = []) {
  const known = new Set(existingIds);
  const used = new Set<string>();
  return rooms.map(({ id, ...room }) => {
    if (id && known.has(id) && !used.has(id)) {
      used.add(id);
      return { ...room, id };
    }
    let fresh: string;
    do fresh = `r${randomBytes(4).toString("hex")}`;
    while (known.has(fresh) || used.has(fresh));
    used.add(fresh);
    return { ...room, id: fresh };
  });
}

/** Drops nulls, so optional fields arrive absent as the frontend's types expect. */
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | undefined;
  };
}

export function toPlaceDto(place: AccommodationPlace) {
  return compact({
    id: place.id,
    name: place.name,
    kind: place.kind,
    address: place.address,
    area: place.area,
    mapUrl: place.mapUrl,
    coordinatorName: place.coordinatorName,
    coordinatorMobile: place.coordinatorMobile,
    notes: place.notes,
    sortOrder: place.sortOrder,
    rooms: place.rooms,
  });
}

export function toAllotmentDto(a: RoomAllotment) {
  return {
    id: a.id,
    registrationId: a.registrationId,
    memberId: a.memberId,
    placeId: a.placeId,
    roomId: a.roomId,
    allottedByName: a.allottedByName,
    allottedAt: a.allottedAt.toISOString(),
  };
}

/**
 * Where a registration's people stay, as told to them: by place, then room.
 * Built the same way every time, so comparing a fresh one with the one stored
 * when it was sent says whether anything changed since.
 */
export type StayNotice = {
  places: {
    name: string;
    address: string;
    area?: string;
    mapUrl?: string;
    coordinatorName?: string;
    coordinatorMobile?: string;
    rooms: { label: string; people: string[] }[];
  }[];
};

const byLabel = new Intl.Collator("en", { numeric: true }).compare;

/** Null when nobody in the registration has a room. */
export function buildStayNotice(
  registration: Registration,
  allotments: RoomAllotment[],
  places: Map<string, AccommodationPlace>
): StayNotice | null {
  const mine = allotments.filter((a) => a.registrationId === registration.id);
  const used = [...new Set(mine.map((a) => a.placeId))]
    .map((id) => places.get(id))
    .filter((p): p is AccommodationPlace => !!p)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const result: StayNotice["places"] = used.map((place) => {
    const here = mine.filter((a) => a.placeId === place.id);
    const rooms = place.rooms
      .filter((room) => here.some((a) => a.roomId === room.id))
      .sort((a, b) => byLabel(a.label, b.label))
      .map((room) => ({
        label: room.label,
        // In the order the registration lists them: the contact first.
        people: registration.members
          .filter((m) => here.some((a) => a.roomId === room.id && a.memberId === m.id))
          .map((m) => m.fullName),
      }))
      .filter((room) => room.people.length > 0);
    return {
      name: place.name,
      address: place.address,
      ...(place.area ? { area: place.area } : {}),
      ...(place.mapUrl ? { mapUrl: place.mapUrl } : {}),
      ...(place.coordinatorName ? { coordinatorName: place.coordinatorName } : {}),
      ...(place.coordinatorMobile ? { coordinatorMobile: place.coordinatorMobile } : {}),
      rooms,
    };
  });
  const withPeople = result.filter((p) => p.rooms.length > 0);
  return withPeople.length > 0 ? { places: withPeople } : null;
}

/** Whether two notices say the same thing. */
export const sameNotice = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** "+91 98765 43210" */
const formatMobile = (e164: string) => {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
};

/** One place: where it is, who is in which room, and how to get there and whom to call. */
function placeParts(place: StayNotice["places"][number]) {
  const extras: string[] = [];
  if (place.mapUrl) extras.push(`Map: ${place.mapUrl}`);
  if (place.coordinatorName || place.coordinatorMobile) {
    extras.push(
      `Contact: ${[place.coordinatorName, place.coordinatorMobile && formatMobile(place.coordinatorMobile)].filter(Boolean).join(", ")}`
    );
  }
  return {
    heading: `${place.name}, ${place.address}`,
    rooms: place.rooms.map((r) => `Room ${r.label}: ${r.people.join(", ")}`),
    extras,
  };
}

/**
 * The details as one line, for the WhatsApp template's `{{3}}`: Meta refuses
 * a placeholder value with line breaks, tabs or long runs of spaces, and caps
 * the body's length.
 */
export function stayNoticeLine(notice: StayNotice) {
  const line = notice.places
    .map((p) => {
      const { heading, rooms, extras } = placeParts(p);
      return [heading, rooms.join("; "), ...extras].join(". ");
    })
    .join(" | ");
  return line.length > 900 ? `${line.slice(0, 897)}…` : line;
}

/** The whole message as a person would type it, for sending from a team member's own WhatsApp. */
export function stayNoticeMessage(registration: Registration, notice: StayNotice) {
  const name = registration.members[0]?.fullName ?? "";
  const blocks = notice.places.map((p) => {
    const { heading, rooms, extras } = placeParts(p);
    return [heading, ...rooms, ...extras].join("\n");
  });
  return [
    `Hello ${name}, your stay for ${EVENT_NAME} is arranged.`,
    ...blocks,
    "Please show this message at the guest house.",
  ].join("\n\n");
}

/**
 * Whether everyone in the registration who sleeps over has a room. Someone
 * leaving the day they arrive needs none.
 */
export function fullyAllotted(registration: Registration, allotments: RoomAllotment[]) {
  return registration.members
    .filter((m) => nightsOf(m).length > 0)
    .every((m) => allotments.some((a) => a.registrationId === registration.id && a.memberId === m.id));
}
