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
  OVERSEAS_MANDALS,
  RELATION_GENDER,
  REGISTRATION_STATUSES,
  REGISTRATION_TYPES,
  STAY_DATES,
  TIME_SLOTS,
  TRAIN_STATIONS,
  TRAVEL_MODES,
  JOURNEY_MODES,
  YOUTH_MAX_AGE,
  isJourneyMode,
  compareStay,
  isLocalMandal,
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
  date: z.enum(STAY_DATES, { error: "Pick a day between 28 January and 1 February" }),
  slot: z.enum(TIME_SLOTS, { error: "Pick a time of day" }),
  // Whether they take the meal served then: breakfast, lunch or dinner.
  meal: z.boolean({ error: "Say whether you will take the meal" }),
});

const text = (max: number) => z.string().trim().max(max);

/**
 * Whether the text has letters from a script other than English's: a name
 * typed in Gujarati or Hindi. Names are kept in English letters only, so lists,
 * search, sorting and the printed reports read the same however the form was
 * filled in. Mirrors hasNonLatinLetters in the form (upasana-fe schema.ts).
 */
export const hasNonLatinLetters = (value: string) => /(?!\p{Script=Latin})\p{L}/u.test(value);
const ENGLISH_LETTERS = "Write the name in English letters";
const optionalText = (max: number) =>
  text(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

/** A flight into or out of Ahmedabad airport: the day, and the time and number if known. */
const indiaFlight = z
  .object({
    date: z.iso.date({ error: "Enter a valid date" }),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 06:30")
      .optional(),
    flight: text(20).optional(),
  })
  .optional();

/**
 * A pickup from Ahmedabad airport and the flight out, for devotees from
 * abroad. Both optional; a pickup needs its flight. No drop is arranged any
 * more, so `needsDrop` is stored false and the flight out is for the record.
 */
const indiaTravel = z
  .object({
    needsPickup: z.boolean(),
    arrival: indiaFlight,
    needsDrop: z.boolean(),
    departure: indiaFlight,
  })
  .refine(t => !t.needsPickup || t.arrival, {
    message: "Pick the day you land",
    path: ["arrival", "date"],
  })
  .optional();

const member = z.object({
  /** The person's id from an earlier save, when editing; empty for someone new. */
  id: z.string().max(40).optional(),
  fullName: text(120)
    .min(2, "Enter the full name")
    .refine(v => !hasNonLatinLetters(v), ENGLISH_LETTERS),
  gender: z.enum(GENDERS, { error: "Select a gender" }),
  age: z
    .number({ error: "Enter the age" })
    .int()
    .min(1, "Age must be 1 to 100")
    .max(100, "Age must be 1 to 100"),
  mobile: z
    .string()
    .regex(MOBILE_E164, "Enter a valid mobile number with country code")
    .optional()
    .nullable()
    .transform(v => v ?? null),
  relation: optionalText(40),
  isPrimary: z.boolean(),
  needsAssistance: z.boolean(),
  assistanceNote: optionalText(300),
  arrival: stayPoint,
  departure: stayPoint,
  /** Asks for a bed for this person. Absent: as `accommodationRequired` says for everyone. */
  needsAccommodation: z.boolean().optional(),
  /** Aged YOUTH_MAX_AGE or under: whether they will attend the Youth Convention. Optional. */
  attendsYouthConvention: z.boolean().optional(),
});

export const newRegistrationSchema = z
  .object({
    type: z.enum(REGISTRATION_TYPES, { error: "Choose individual or family" }),
    groupName: optionalText(120),
    mandal: z.enum([...MANDALS, NO_MANDAL], { error: "Select a mandal from the list" }),
    // A cap well above any real party, so one request cannot store megabytes.
    members: z.array(member).min(1).max(100),
    arrival: stayPoint,
    departure: stayPoint,
    travel: z.object({
      mode: z.enum(TRAVEL_MODES, { error: "Select how you are travelling" }),
      vehicleCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_VEHICLES.family)
        .optional()
        .nullable()
        .transform(v => v ?? null),
      // Optional, one per vehicle. Blank entries are dropped in toCreateData.
      vehicleNumbers: z
        .array(text(20))
        .max(MAX_VEHICLES.family)
        .optional()
        .transform(v => v ?? []),
      reference: optionalText(80),
      // Train only: when it reaches Ahmedabad, and at which station.
      arrivalTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 06:30")
        .optional(),
      station: z.enum(TRAIN_STATIONS, { error: "Pick a station from the list" }).optional(),
      needsPickup: z.boolean(),
      needsDrop: z
        .boolean()
        .optional()
        .transform(v => v ?? false),
      // With a drop: how they leave (not always how they came), the train or
      // bus home, its station (train only), and when it leaves.
      departureMode: z.enum(JOURNEY_MODES).optional(),
      departureReference: optionalText(80),
      departureStation: z
        .enum(TRAIN_STATIONS, { error: "Pick a station from the list" })
        .optional(),
      departureTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 06:30")
        .optional(),
    }),
    indiaTravel,
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
    } else if (value.groupName && hasNonLatinLetters(value.groupName)) {
      issue(["groupName"], ENGLISH_LETTERS);
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
      issue(
        ["members", 0, "age"],
        `A family's primary contact has to be ${MIN_FAMILY_CONTACT_AGE} or older`
      );
    }
    // "local" is set for nearby mandals, not chosen by anyone else.
    if (value.travel.mode === "local" && !isLocalMandal(value.mandal)) {
      issue(["travel", "mode"], "Select how you are travelling");
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
        if (!isVehiclePlate(plate))
          issue(["travel", "vehicleNumbers", index], "Not a valid vehicle number");
        if (seenPlates.has(normalizePlate(plate)))
          issue(["travel", "vehicleNumbers", index], "The same vehicle is listed twice");
        seenPlates.add(normalizePlate(plate));
      });
    }
    // A pickup or drop by train or bus needs its journey: the train's number,
    // station and time, or the bus's details and time.
    const t = value.travel;
    if (!isLocalMandal(value.mandal) && isJourneyMode(t.mode)) {
      if (t.needsPickup && t.needsDrop && !t.departureMode) {
        issue(["travel", "departureMode"], "Select how you are leaving");
      }
      const legs = [
        {
          wanted: t.needsPickup,
          mode: t.mode,
          reference: "reference",
          station: "station",
          time: "arrivalTime",
        },
        {
          wanted: t.needsPickup && t.needsDrop && !!t.departureMode,
          mode: t.departureMode,
          reference: "departureReference",
          station: "departureStation",
          time: "departureTime",
        },
      ] as const;
      for (const leg of legs) {
        if (!leg.wanted) continue;
        const train = leg.mode === "train";
        if (!t[leg.reference]?.trim()) {
          issue(
            ["travel", leg.reference],
            train
              ? "Enter the train number and name"
              : leg.mode === "flight"
                ? "Enter the flight number"
                : "Enter the bus details"
          );
        }
        if (train && !t[leg.station]) issue(["travel", leg.station], "Pick the station");
        if (!t[leg.time]) issue(["travel", leg.time], "Pick the time");
      }
    }
    // Landing in India before reaching the event, leaving after it ends.
    const landing = value.indiaTravel?.arrival?.date;
    const leaving = value.indiaTravel?.departure?.date;
    if (landing && landing > value.arrival.date) {
      issue(["indiaTravel", "arrival", "date"], "Has to be on or before you reach the event");
    }
    if (leaving && leaving < value.departure.date) {
      issue(["indiaTravel", "departure", "date"], "Has to be on or after you leave the event");
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
  return input.members.map(m => {
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
  // A nearby mandal travels from home and sleeps there: no travel, no beds.
  const local = isLocalMandal(input.mandal);
  const members = input.members.map((m, index) => ({
    ...m,
    id: ids[index],
    isPrimary: index === 0,
    relation: input.type === "family" && index > 0 ? m.relation : null,
    assistanceNote: m.needsAssistance ? m.assistanceNote : null,
    attendsYouthConvention: m.age <= YOUTH_MAX_AGE ? (m.attendsYouthConvention ?? null) : null,
    // Someone who leaves the day they arrive has no night here, so no bed.
    needsAccommodation:
      !local &&
      (m.needsAccommodation ?? input.accommodationRequired) &&
      m.departure.date > m.arrival.date,
  }));

  return {
    // One registration per contact number; the unique index is on this.
    contactMobile: input.members[0]?.mobile ?? null,
    type: input.type,
    groupName: input.type === "individual" ? null : input.groupName,
    mandal: input.mandal,
    members,
    arrival: input.arrival,
    departure: input.departure,
    travel: local
      ? {
          mode: "local",
          vehicleCount: null,
          vehicleNumbers: [],
          reference: null,
          arrivalTime: null,
          station: null,
          needsPickup: false,
          needsDrop: false,
          departureMode: null,
          departureReference: null,
          departureStation: null,
          departureTime: null,
        }
      : {
          ...input.travel,
          vehicleCount:
            input.travel.mode === "personal_vehicle" ? (input.travel.vehicleCount ?? 1) : null,
          vehicleNumbers:
            input.travel.mode === "personal_vehicle"
              ? input.travel.vehicleNumbers.filter(Boolean).map(n => n.toUpperCase())
              : [],
          arrivalTime: (isJourneyMode(input.travel.mode) && input.travel.arrivalTime) || null,
          station: (input.travel.mode === "train" && input.travel.station) || null,
          // A pickup in Ahmedabad: by train or public bus (or flight, which is
          // no longer offered but still accepted).
          needsPickup:
            (input.travel.mode === "train" ||
              input.travel.mode === "public_bus" ||
              input.travel.mode === "flight") &&
            input.travel.needsPickup,
          // A drop is offered only with a pickup.
          needsDrop:
            (input.travel.mode === "train" ||
              input.travel.mode === "public_bus" ||
              input.travel.mode === "flight") &&
            input.travel.needsPickup &&
            input.travel.needsDrop,
          ...journeyHome(input.travel),
        },
    // True when anyone in the party has a bed coming; each person's own
    // answer is on them.
    accommodationRequired: members.some(m => m.needsAccommodation),
    indiaTravel: indiaTravelRecord(input),
    notes: input.notes,
  };
}

/**
 * How they leave and the train or bus home, kept only with a drop; a station
 * only when leaving by train.
 */
function journeyHome(travel: NewRegistrationInput["travel"]) {
  const kept =
    isJourneyMode(travel.mode) && travel.needsPickup && travel.needsDrop && !!travel.departureMode;
  return {
    departureMode: (kept && travel.departureMode) || null,
    departureReference: (kept && travel.departureReference) || null,
    departureStation: (kept && travel.departureMode === "train" && travel.departureStation) || null,
    departureTime: (kept && travel.departureTime) || null,
  };
}

/**
 * The Ahmedabad airport pickup and flight out as stored: only for an overseas
 * mandal that asked for a pickup or gave its flight out.
 */
function indiaTravelRecord(input: NewRegistrationInput) {
  const india = input.indiaTravel;
  if (!india || !OVERSEAS_MANDALS.includes(input.mandal)) return null;
  if (!india.needsPickup && !india.departure) return null;
  type Leg = NonNullable<typeof india.arrival>;
  const leg = (f?: Leg) =>
    f
      ? { date: f.date, time: f.time || null, flight: f.flight ? f.flight.toUpperCase() : null }
      : null;
  return {
    needsPickup: india.needsPickup,
    arrival: india.needsPickup ? leg(india.arrival) : null,
    needsDrop: false,
    departure: leg(india.departure),
  };
}

/** Drops nulls, so optional fields arrive absent as the frontend's types expect. */
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | undefined;
  };
}

/**
 * Whether this person asked for a bed. Registrations from before the
 * per-person answer existed only have the registration's, which then covered
 * everyone.
 */
export function wantsBed(
  registration: Pick<Registration, "accommodationRequired">,
  member: { needsAccommodation?: boolean | null }
) {
  return registration.accommodationRequired && (member.needsAccommodation ?? true);
}

/** A stored registration in the shape the frontend reads. Internal fields stay behind. */
export function toRegistrationDto(r: Registration) {
  return compact({
    id: r.id,
    code: r.code,
    type: r.type,
    groupName: r.groupName,
    mandal: r.mandal,
    members: r.members.map(m =>
      compact({
        ...m,
        arrival: compact({ ...m.arrival }),
        departure: compact({ ...m.departure }),
        needsAccommodation: wantsBed(r, m),
      })
    ),
    arrival: compact({ ...r.arrival }),
    departure: compact({ ...r.departure }),
    travel: compact({ ...r.travel }),
    indiaTravel: r.indiaTravel && {
      ...r.indiaTravel,
      arrival: r.indiaTravel.arrival ? compact({ ...r.indiaTravel.arrival }) : undefined,
      departure: r.indiaTravel.departure ? compact({ ...r.indiaTravel.departure }) : undefined,
    },
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
