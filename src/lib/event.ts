/**
 * The event's fixed facts, as the API enforces them.
 *
 * A copy of upasana-fe/src/config/event.ts and the enum maps in
 * upasana-fe/src/features/registrations/types.ts. The frontend uses its copy to
 * draw the form; this one is what a registration is checked against, so a
 * request that skips the form still cannot store a date outside the event or a
 * mandal that does not exist. Change both together.
 */

/** Team roles an admin can invite. */
export const INVITE_ROLES = ["admin", "sanchalak"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** "an admin", "Mandal sanchalak for Surat" — for invite messages. */
export function roleDescription(role: string, mandal?: string | null) {
  return role === "sanchalak" ? `Mandal sanchalak for ${mandal ?? "your mandal"}` : "an admin";
}

/** Shown in WhatsApp messages. Matches `EVENT.name` on the frontend. */
export const EVENT_NAME = "Youth Convention 2026";

/** The event days, 28 Jan – 1 Feb 2027. Calendar days at the venue, no time zone. */
export const EVENT_DAYS = [
  "2027-01-28",
  "2027-01-29",
  "2027-01-30",
  "2027-01-31",
  "2027-02-01",
] as const;

/** Days a guest may arrive or leave: the event days only. */
export const STAY_DATES = EVENT_DAYS;

/**
 * Nights someone can need a bed: every stay date but the last, since nobody
 * sleeps over after leaving. A night is named by its evening's date.
 */
export const NIGHTS = STAY_DATES.slice(0, -1);

/** "30 Jan" — for messages. */
export function formatDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

export const TIME_SLOTS = ["morning", "afternoon", "evening"] as const;

/** Mandals outside India. Mirrors OVERSEAS_MANDALS on the frontend. */
export const OVERSEAS_MANDALS: readonly string[] = ["London (UK)", "New Jersey (USA)"];

export const MANDALS = [
  "Ahmedabad",
  "Dahegam",
  "Naroda",
  "Gandhinagar",
  "Surat",
  "Vadodara",
  "Rajkot",
  "Bhavnagar",
  "Anand",
  "Jamnagar",
  "Mumbai",
  "Pune",
  "Delhi",
  "London (UK)",
  "New Jersey (USA)",
] as const;

export const NO_MANDAL = "Not in a mandal";

/**
 * Mandals near enough to come and go from home: Ahmedabad, and
 * these. Not asked about travel or a bed; stored as travel "local", no beds.
 * Mirrors isLocalMandal in upasana-fe/src/config/event.ts.
 */
const LOCAL_MANDALS: readonly string[] = ["Dahegam", "Naroda", "Gandhinagar", "Vadodara", "Rajkot"];
export const isLocalMandal = (mandal: string) =>
  mandal.startsWith("Ahmedabad") || LOCAL_MANDALS.includes(mandal);

export const REGISTRATION_TYPES = ["individual", "family"] as const;
export const GENDERS = ["male", "female"] as const;

/** The most vehicles a registration can bring. Mirrors MAX_VEHICLES in the frontend's form schema. */
export const MAX_VEHICLES = { individual: 1, family: 4 } as const;

/** No more vehicles than people: one for an individual, up to four for a family. */
export function maxVehiclesFor(type: (typeof REGISTRATION_TYPES)[number], people: number) {
  return Math.max(1, Math.min(MAX_VEHICLES[type], people));
}

/** "gj 05-ab 1234" → "GJ05AB1234": how two plates are compared. */
export const normalizePlate = (plate: string) => plate.toUpperCase().replace(/[\s.-]/g, "");

/**
 * An Indian number plate, after `normalizePlate`: state, district, up to three
 * series letters, four digits (GJ05AB1234), or a Bharat series plate
 * (22BH1234AB). Mirrors isVehiclePlate in the frontend's form schema.
 */
export const isVehiclePlate = (plate: string) =>
  /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(normalizePlate(plate)) ||
  /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(normalizePlate(plate));

/** A family's primary contact has to be an adult. (Someone registering alone may be younger.) */
export const MIN_FAMILY_CONTACT_AGE = 18;

/** Relations that fix the person's gender. Mirrors RELATION_GENDER in the frontend's types.ts. */
export const RELATION_GENDER: Record<string, (typeof GENDERS)[number]> = {
  Son: "male",
  Father: "male",
  Brother: "male",
  Grandfather: "male",
  Daughter: "female",
  Mother: "female",
  Sister: "female",
  Grandmother: "female",
};
export const TRAVEL_MODES = [
  "personal_vehicle",
  "mandal_bus",
  "train",
  "flight",
  "public_bus",
  "other",
  // Set for local mandals, never picked.
  "local",
] as const;
export const REGISTRATION_STATUSES = ["pending", "confirmed", "checked_in", "cancelled"] as const;

/**
 * Mobile numbers the form accepts, as E.164. Mirrors upasana-fe/src/lib/phone.ts:
 * India must start 6–9; every listed country has exactly ten national digits.
 */
export const MOBILE_E164 = /^(\+91[6-9]\d{9}|\+1\d{10}|\+44\d{10})$/;

export type StayPoint = { date: string; slot: string; meal?: boolean | null };

/** Negative when `a` comes first. ISO dates compare correctly as strings. */
export function compareStay(a: StayPoint, b: StayPoint) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return TIME_SLOTS.indexOf(a.slot as never) - TIME_SLOTS.indexOf(b.slot as never);
}

/** "YC-0101" for the first registration. */
export function formatRegistrationCode(sequence: number) {
  return `YC-${(100 + sequence).toString().padStart(4, "0")}`;
}
