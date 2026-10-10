import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Registration } from "@prisma/client";

import {
  GENDERS,
  MANDALS,
  MOBILE_E164,
  MAX_VEHICLES,
  MIN_FAMILY_CONTACT_AGE,
  NO_MANDAL,
  RELATION_GENDER,
  REGISTRATION_STATUSES,
  REGISTRATION_TYPES,
  STAY_DATES,
  TIME_SLOTS,
  TRAVEL_MODES,
  compareStay,
  isVehiclePlate,
  maxVehiclesFor,
  normalizePlate,
} from "./event";

/**
 * What `POST /registrations` accepts, and how a stored registration is sent
 * back.
 *
 * The body is the frontend's `NewRegistration` (the form's output after
 * `toNewRegistration`), so the rules here repeat the form's own. They are not
 * optional extras: the registration endpoint is public, and anything the form
 * would refuse has to be refused here too.
 */

const stayPoint = z.object({
  date: z.enum(STAY_DATES, { error: "Pick a day between 29 January and 2 February" }),
  slot: z.enum(TIME_SLOTS, { error: "Pick a time of day" }),
});

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const member = z.object({
  /** The person's id from an earlier save, when editing; empty for someone new. */
  id: z.string().max(40).optional(),
  fullName: text(120).min(2, "Enter the full name"),
  gender: z.enum(GENDERS, { error: "Select a gender" }),
  age: z.number({ error: "Enter the age" }).int().min(1, "Age must be 1 to 100").max(100, "Age must be 1 to 100"),
  mobile: z
    .string()
    .regex(MOBILE_E164, "Enter a valid mobile number with country code")
    .optional()
    .nullable()
    .transform((v) => v ?? null),
  relation: optionalText(40),
  isPrimary: z.boolean(),
  needsAssistance: z.boolean(),
  assistanceNote: optionalText(300),
  arrival: stayPoint,
  departure: stayPoint,
});

export const newRegistrationSchema = z
  .object({
    type: z.enum(REGISTRATION_TYPES, { error: "Choose individual or family" }),
    groupName: optionalText(120),
    mandal: z.enum([...MANDALS, NO_MANDAL], { error: "Select a mandal from the list" }),
    city: text(80).min(2, "Enter the city"),
    // A cap well above any real party, so one request cannot store megabytes.
    members: z.array(member).min(1).max(100),
    arrival: stayPoint,
    departure: stayPoint,
    travel: z.object({
      mode: z.enum(TRAVEL_MODES, { error: "Select how you are travelling" }),
      vehicleCount: z.number().int().min(1).max(MAX_VEHICLES.family).optional().nullable().transform((v) => v ?? null),
      // Optional, one per vehicle. Blank entries are dropped in toCreateData.
      vehicleNumbers: z.array(text(20)).max(MAX_VEHICLES.family).optional().transform((v) => v ?? []),
      reference: optionalText(80),
      needsPickup: z.boolean(),
      needsDrop: z.boolean().optional().transform((v) => v ?? false),
    }),
    accommodationRequired: z.boolean(),
    notes: optionalText(1000),
    /**
     * From POST /otp/verify: proof the primary contact's number was verified.
     * Checked and spent in registrationController, not stored. Optional here
     * because a sanchalak or admin may vouch in person instead
     * (`verifiedInPerson`), and an edit that keeps the number needs neither —
     * the controller decides which applies.
     */
    mobileVerificationToken: z.string().optional(),
    verifiedInPerson: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if (value.type === "individual" && value.members.length !== 1) {
      issue(["members"], "An individual registration has exactly one person");
    }
    if (value.type !== "individual" && value.members.length < 2) {
      issue(["members"], "A family registration needs at least two people");
    }
    if (value.type !== "individual" && !value.groupName) {
      issue(["groupName"], "Enter the family name");
    }
    if (!value.members[0]?.mobile) {
      issue(["members", 0, "mobile"], "The primary contact needs a mobile number");
    }
    if (compareStay(value.departure, value.arrival) <= 0) {
      issue(["departure"], "Departure has to be after arrival");
    }
    // A "Son" entered as female: one of the two fields is wrong.
    if (value.type === "family") {
      value.members.forEach((m, index) => {
        const expected = m.relation ? RELATION_GENDER[m.relation] : undefined;
        if (index > 0 && expected && m.gender !== expected) {
          issue(["members", index, "relation"], `${m.relation} has to be ${expected}`);
        }
      });
    }
    // The same person added twice — see the form's own rule. Ignoring case
    // and extra spaces.
    const seen = new Set<string>();
    value.members.forEach((m, index) => {
      const key = m.fullName.trim().replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) issue(["members", index, "fullName"], "The same person is listed twice");
      seen.add(key);
    });
    value.members.forEach((m, index) => {
      if (compareStay(m.departure, m.arrival) <= 0) {
        issue(["members", index, "departure"], "Departure has to be after arrival");
      }
    });
    // A family is looked after by an adult; someone registering alone may be younger.
    if (value.type === "family" && (value.members[0]?.age ?? 0) < MIN_FAMILY_CONTACT_AGE) {
      issue(["members", 0, "age"], `A family's primary contact has to be ${MIN_FAMILY_CONTACT_AGE} or older`);
    }
    if (value.travel.mode === "personal_vehicle") {
      const max = maxVehiclesFor(value.type, value.members.length);
      if ((value.travel.vehicleCount ?? 1) > max) {
        issue(
          ["travel", "vehicleCount"],
          value.type === "individual"
            ? "An individual registration has one vehicle"
            : `At most ${max} vehicles for ${value.members.length} people (and never more than ${MAX_VEHICLES.family})`
        );
      }
      const seenPlates = new Set<string>();
      value.travel.vehicleNumbers.forEach((plate, index) => {
        if (!plate) return;
        if (!isVehiclePlate(plate)) issue(["travel", "vehicleNumbers", index], "Not a valid vehicle number");
        if (seenPlates.has(normalizePlate(plate))) issue(["travel", "vehicleNumbers", index], "The same vehicle is listed twice");
        seenPlates.add(normalizePlate(plate));
      });
    }
    if (value.travel.vehicleNumbers.length > (value.travel.vehicleCount ?? 1)) {
      issue(["travel", "vehicleNumbers"], "More vehicle numbers than vehicles");
    }
  });

export type NewRegistrationInput = z.infer<typeof newRegistrationSchema>;

export const statusSchema = z.object({
  status: z.enum(REGISTRATION_STATUSES, { error: "Unknown status" }),
});

/**
 * Member ids for a save. An id the registration already had is kept — room
 * allotments point at it, so removing person 2 must not hand their bed to
 * person 3. Anything else (someone new, or an id the client made up or sent
 * twice) gets a fresh one.
 */
function memberIds(input: NewRegistrationInput, existingIds: readonly string[]) {
  const known = new Set(existingIds);
  const used = new Set<string>();
  return input.members.map((m) => {
    if (m.id && known.has(m.id) && !used.has(m.id)) {
      used.add(m.id);
      return m.id;
    }
    let id: string;
    do id = `m${randomBytes(4).toString("hex")}`;
    while (known.has(id) || used.has(id));
    used.add(id);
    return id;
  });
}

/**
 * The stored values, normalised before they are written. Primary flags are
 * not trusted: the first member is the primary contact, by the form's
 * definition. `existingIds` are the members' ids before an edit.
 */
export function toCreateData(input: NewRegistrationInput, existingIds: readonly string[] = []) {
  const ids = memberIds(input, existingIds);
  return {
    // One registration per contact number; the unique index is on this.
    contactMobile: input.members[0]?.mobile ?? null,
    type: input.type,
    groupName: input.type === "individual" ? null : input.groupName,
    mandal: input.mandal,
    city: input.city,
    members: input.members.map((m, index) => ({
      ...m,
      id: ids[index],
      isPrimary: index === 0,
      relation: input.type === "family" && index > 0 ? m.relation : null,
      assistanceNote: m.needsAssistance ? m.assistanceNote : null,
    })),
    arrival: input.arrival,
    departure: input.departure,
    travel: {
      ...input.travel,
      vehicleCount: input.travel.mode === "personal_vehicle" ? input.travel.vehicleCount ?? 1 : null,
      vehicleNumbers:
        input.travel.mode === "personal_vehicle"
          ? input.travel.vehicleNumbers.filter(Boolean).map((n) => n.toUpperCase())
          : [],
      needsPickup:
        (input.travel.mode === "train" || input.travel.mode === "flight") && input.travel.needsPickup,
      needsDrop:
        (input.travel.mode === "train" || input.travel.mode === "flight") && input.travel.needsDrop,
    },
    // A same-day visit has no night to stay, so no bed.
    accommodationRequired:
      input.accommodationRequired && input.members.some((m) => m.departure.date > m.arrival.date),
    notes: input.notes,
  };
}

/** Drops nulls, so optional fields arrive absent as the frontend's types expect. */
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | undefined;
  };
}

/** A stored registration in the shape the frontend reads. Internal fields stay behind. */
export function toRegistrationDto(r: Registration) {
  return compact({
    id: r.id,
    code: r.code,
    type: r.type,
    groupName: r.groupName,
    mandal: r.mandal,
    city: r.city,
    members: r.members.map((m) => compact({ ...m })),
    arrival: r.arrival,
    departure: r.departure,
    travel: compact({ ...r.travel }),
    accommodationRequired: r.accommodationRequired,
    notes: r.notes,
    status: r.status,
    source: r.source,
    isSample: r.isSample,
    createdAt: r.createdAt.toISOString(),
    mobileVerification: r.mobileVerification,
    verifiedByName: r.verifiedByName,
    editedAt: r.editedAt?.toISOString() ?? null,
    editedByName: r.editedByName,
  });
}

/**
 * Just enough to recognise a registration — for "this number already has a
 * registration" warnings. `id` only when the viewer may open it.
 */
export function toRegistrationSummary(r: Registration, canOpen: boolean) {
  return {
    id: canOpen ? r.id : undefined,
    code: r.code,
    name: r.groupName ?? r.members[0]?.fullName ?? "",
    people: r.members.length,
    status: r.status,
    mandal: r.mandal,
  };
}
