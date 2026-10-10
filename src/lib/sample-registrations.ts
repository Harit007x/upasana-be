/**
 * The 64 made-up registrations used for demos, and adding or removing them.
 *
 * Generated from a fixed seed: the same bookings every time. None of these
 * people are real; the names are common Gujarati names picked at random.
 * They take sequences 1–64 (YC-0101 to YC-0164) and are flagged `isSample`,
 * so removing them can never touch a real registration.
 *
 * Used by the admin toggle (adminSampleDataController) and by
 * `pnpm seed:registrations`.
 */
import { EVENT_DAYS, MANDALS, STAY_DATES, formatRegistrationCode, type StayPoint } from "./event";
import { prisma } from "../utils/db";

type Gender = "male" | "female";
type Member = {
  id: string;
  fullName: string;
  gender: Gender;
  age: number;
  mobile?: string;
  relation?: string;
  isPrimary: boolean;
  needsAssistance: boolean;
  assistanceNote?: string;
  arrival: StayPoint;
  departure: StayPoint;
};
type SeedRegistration = {
  sequence: number;
  code: string;
  type: string;
  groupName?: string;
  mandal: string;
  city: string;
  members: Member[];
  arrival: StayPoint;
  departure: StayPoint;
  travel: {
    mode: string;
    vehicleCount?: number;
    vehicleNumbers: string[];
    reference?: string;
    needsPickup: boolean;
  };
  accommodationRequired: boolean;
  notes?: string;
  status: string;
  source: string;
  createdAt: string;
};
type RegistrationType = string;
type RegistrationStatus = string;
type TravelMode = string;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MALE_NAMES = [
  "Hitesh",
  "Jignesh",
  "Bhavesh",
  "Nilesh",
  "Ketan",
  "Paresh",
  "Mahesh",
  "Rakesh",
  "Dhruv",
  "Harsh",
  "Parth",
  "Yash",
  "Krunal",
  "Chirag",
  "Vipul",
  "Hardik",
  "Darshan",
  "Nirav",
  "Tirth",
  "Meet",
  "Jay",
  "Smit",
  "Kishan",
  "Ramesh",
  "Dilip",
  "Pravin",
  "Haresh",
  "Anil",
];
const FEMALE_NAMES = [
  "Bhavna",
  "Hetal",
  "Komal",
  "Nirali",
  "Priya",
  "Riddhi",
  "Jinal",
  "Kinjal",
  "Dhara",
  "Falguni",
  "Pooja",
  "Mansi",
  "Krupa",
  "Urvashi",
  "Khushi",
  "Shreya",
  "Disha",
  "Vidhi",
  "Hiral",
  "Ila",
  "Sarla",
  "Manjula",
  "Jaya",
  "Kokila",
];
const SURNAMES = [
  "Patel",
  "Shah",
  "Mehta",
  "Desai",
  "Joshi",
  "Trivedi",
  "Bhatt",
  "Panchal",
  "Parmar",
  "Chauhan",
  "Thakkar",
  "Modi",
  "Vyas",
  "Pandya",
  "Soni",
  "Gajjar",
  "Raval",
  "Dave",
  "Prajapati",
  "Solanki",
];

const PLATE_PREFIX: Record<string, string> = {
  "Ahmedabad – Maninagar": "GJ-01",
  "Ahmedabad – Naranpura": "GJ-01",
  Gandhinagar: "GJ-18",
  Surat: "GJ-05",
  Vadodara: "GJ-06",
  Rajkot: "GJ-03",
  Bhavnagar: "GJ-04",
  Anand: "GJ-23",
  Jamnagar: "GJ-10",
  Mumbai: "MH-02",
  Pune: "MH-12",
  Delhi: "DL-3C",
};

const TRAINS = [
  "12009 Shatabdi Exp",
  "12901 Gujarat Mail",
  "19015 Saurashtra Exp",
  "12957 Rajdhani Exp",
  "22953 Gujarat Exp",
  "12933 Karnavati Exp",
];

const ABROAD = new Set(["London (UK)", "New Jersey (USA)"]);

/** "Ahmedabad – Maninagar" → "Ahmedabad", "London (UK)" → "London". */
function cityOfMandal(mandal: string) {
  return mandal.split(" – ")[0].replace(/ \(.*\)$/, "");
}

export function buildSampleRegistrations(): SeedRegistration[] {
  const rand = mulberry32(20261225);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const chance = (p: number) => rand() < p;
  const mobile = (mandal: string) =>
    mandal === "London (UK)"
      ? `+447${between(100000000, 999999999)}`
      : mandal === "New Jersey (USA)"
        ? `+1${between(201, 989)}${between(1000000, 9999999)}`
        : `+919${between(100000000, 999999999)}`;

  // One registration per contact number, so no two samples share one.
  const usedContacts = new Set<string>();
  const contactMobile = (mandal: string) => {
    let number = mobile(mandal);
    while (usedContacts.has(number)) number = mobile(mandal);
    usedContacts.add(number);
    return number;
  };

  const stay = (date: string, slot: string): StayPoint => ({ date, slot });

  /** Most people come for the whole event; some come late or leave early. */
  const pickSchedule = (abroad: boolean): [StayPoint, StayPoint] => {
    const roll = rand();
    if (abroad || roll < 0.35) {
      return [
        stay(STAY_DATES[0], pick(["evening", "night"] as const)),
        stay(STAY_DATES[STAY_DATES.length - 1], pick(["morning", "afternoon"] as const)),
      ];
    }
    if (roll < 0.7) {
      return [
        stay(EVENT_DAYS[0], pick(["morning", "afternoon"] as const)),
        stay(EVENT_DAYS[EVENT_DAYS.length - 1], pick(["evening", "night"] as const)),
      ];
    }
    // Event days only: comes late, leaves early, or both.
    const startIndex = between(1, EVENT_DAYS.length - 1);
    const endIndex = between(startIndex + 1, EVENT_DAYS.length);
    return [stay(STAY_DATES[startIndex], "morning"), stay(STAY_DATES[endIndex], "evening")];
  };

  // The mandal of the registration being built, for the mobile's country code.
  let currentMandal = "";

  const makeMember = (
    index: number,
    fields: Pick<Member, "fullName" | "gender" | "age"> &
      Partial<Pick<Member, "relation" | "isPrimary">>,
    schedule: [StayPoint, StayPoint]
  ): Member => {
    const senior = fields.age >= 68;
    const needsAssistance = senior ? chance(0.6) : chance(0.03);
    return {
      id: `m${index}`,
      isPrimary: false,
      ...fields,
      mobile: fields.isPrimary
        ? contactMobile(currentMandal)
        : chance(0.4)
          ? mobile(currentMandal)
          : undefined,
      needsAssistance,
      assistanceNote: needsAssistance
        ? senior
          ? pick([
              "Ground-floor room please",
              "Walks with a stick",
              "Diabetic, needs sugar-free meals",
            ])
          : pick(["Wheelchair user", "Asthma, carries inhaler"])
        : undefined,
      arrival: schedule[0],
      departure: schedule[1],
    };
  };

  const registrations: SeedRegistration[] = [];

  for (let i = 0; i < 64; i++) {
    const typeRoll = rand();
    const type: RegistrationType = typeRoll < 0.45 ? "individual" : "family";
    // Overseas mandals send a handful of people, not a fifth of the event.
    const mandal = chance(0.06) ? pick([...ABROAD]) : pick(MANDALS.filter(m => !ABROAD.has(m)));
    currentMandal = mandal;
    const city = cityOfMandal(mandal);
    const abroad = ABROAD.has(mandal);
    const local = mandal.startsWith("Ahmedabad") || mandal === "Gandhinagar";
    const schedule = pickSchedule(abroad);
    const surname = pick(SURNAMES);

    const members: Member[] = [];
    let groupName: string | undefined;

    if (type === "individual") {
      const gender: Gender = chance(0.55) ? "male" : "female";
      members.push(
        makeMember(
          0,
          {
            fullName: `${pick(gender === "male" ? MALE_NAMES : FEMALE_NAMES)} ${surname}`,
            gender,
            age: between(17, 45),
            isPrimary: true,
          },
          schedule
        )
      );
    } else {
      groupName = `${surname} family`;
      const headAge = between(38, 62);
      members.push(
        makeMember(
          0,
          {
            fullName: `${pick(MALE_NAMES)} ${surname}`,
            gender: "male",
            age: headAge,
            isPrimary: true,
          },
          schedule
        ),
        makeMember(
          1,
          {
            fullName: `${pick(FEMALE_NAMES)} ${surname}`,
            gender: "female",
            age: headAge - between(1, 5),
            relation: "Spouse",
          },
          schedule
        )
      );
      const children = between(0, 3);
      for (let c = 0; c < children; c++) {
        const gender: Gender = chance(0.5) ? "male" : "female";
        members.push(
          makeMember(
            members.length,
            {
              fullName: `${pick(gender === "male" ? MALE_NAMES : FEMALE_NAMES)} ${surname}`,
              gender,
              age: between(6, Math.max(8, headAge - 22)),
              relation: gender === "male" ? "Son" : "Daughter",
            },
            schedule
          )
        );
      }
      if (chance(0.3)) {
        const gender: Gender = chance(0.5) ? "male" : "female";
        // A grandparent often heads home a day early; it is what makes the
        // per-member dates worth having.
        const leavesEarly = chance(0.5);
        members.push(
          makeMember(
            members.length,
            {
              fullName: `${pick(gender === "male" ? MALE_NAMES : FEMALE_NAMES)} ${surname}`,
              gender,
              age: between(66, 82),
              relation: gender === "male" ? "Father" : "Mother",
            },
            leavesEarly && schedule[0].date < EVENT_DAYS[1]
              ? [schedule[0], stay(EVENT_DAYS[1], "evening")]
              : schedule
          )
        );
      }
    }

    let travelMode: TravelMode;
    if (abroad) travelMode = "flight";
    else if (local) travelMode = chance(0.8) ? "personal_vehicle" : "public_bus";
    else
      travelMode = pick([
        "personal_vehicle",
        "personal_vehicle",
        "train",
        "train",
        "flight",
        "public_bus",
        "mandal_bus",
      ] as const);

    const status: RegistrationStatus = i < 4 ? "cancelled" : chance(0.3) ? "pending" : "confirmed";

    const createdDay = between(1, 39);
    const createdAt = new Date(
      Date.UTC(2026, 8, createdDay, between(3, 16), between(0, 59))
    ).toISOString();

    const vehicleCount = members.length > 5 ? 2 : 1;

    registrations.push({
      sequence: 0,
      code: "",
      type,
      groupName,
      mandal,
      city,
      members,
      arrival: schedule[0],
      departure: schedule[1],
      travel: {
        mode: travelMode,
        vehicleCount: travelMode === "personal_vehicle" ? vehicleCount : undefined,
        // Numbers are optional, so some samples leave them out.
        vehicleNumbers:
          travelMode === "personal_vehicle" && chance(0.85)
            ? Array.from(
                { length: vehicleCount },
                () =>
                  `${PLATE_PREFIX[mandal] ?? "GJ-01"}-${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}-${between(1000, 9999)}`
              )
            : [],
        reference:
          travelMode === "train"
            ? pick(TRAINS)
            : travelMode === "flight"
              ? `${pick(["6E", "AI", "QP", "SG", "UK"])} ${between(200, 2999)}`
              : undefined,
        needsPickup: (travelMode === "train" || travelMode === "flight") && chance(0.7),
      },
      accommodationRequired: local ? chance(0.15) : true,
      notes: chance(0.15)
        ? pick([
            "Will help with seva in the kitchen if needed.",
            "Arriving together on the Vadodara mandal bus.",
            "Please keep the family in one room if possible.",
            "Requesting jain food for all members.",
          ])
        : undefined,
      status,
      source: chance(0.8) ? "self" : "staff",
      createdAt,
    });
  }

  // Codes go out in the order people registered, as they would on the server.
  registrations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  registrations.forEach((registration, index) => {
    registration.sequence = index + 1;
    registration.code = formatRegistrationCode(index + 1);
  });

  // Newest first, the way the list shows them.
  return registrations.reverse();
}

export const SAMPLE_COUNT = 64;

export const countSampleRegistrations = () =>
  prisma.registration.count({ where: { isSample: true } });

/**
 * Adds every sample registration that is not already there. Refuses (returns
 * `{ clash }`) if a real registration holds one of the sample codes — only
 * possible on a database that took real registrations before any samples.
 */
export async function insertSampleRegistrations() {
  const samples = buildSampleRegistrations();
  const taken = await prisma.registration.findMany({
    where: { sequence: { in: samples.map(s => s.sequence) } },
    select: { sequence: true, code: true, isSample: true },
  });
  const clash = taken.find(t => !t.isSample);
  if (clash) return { added: 0, clash: clash.code };

  const present = new Set(taken.map(t => t.sequence));
  let added = 0;
  // One by one rather than createMany, which skips @updatedAt and would leave
  // every sample without one.
  for (const sample of samples) {
    if (present.has(sample.sequence)) continue;
    await prisma.registration.create({
      data: {
        ...sample,
        isSample: true,
        groupName: sample.groupName ?? null,
        notes: sample.notes ?? null,
        contactMobile: sample.members[0]?.mobile ?? null,
        createdAt: new Date(sample.createdAt),
        members: sample.members.map(m => ({
          ...m,
          mobile: m.mobile ?? null,
          relation: m.relation ?? null,
          assistanceNote: m.assistanceNote ?? null,
        })),
        travel: {
          mode: sample.travel.mode,
          vehicleCount: sample.travel.vehicleCount ?? null,
          vehicleNumbers: sample.travel.vehicleNumbers,
          reference: sample.travel.reference ?? null,
          needsPickup: sample.travel.needsPickup,
        },
      },
    });
    added++;
  }

  // Real registrations number on from after the samples. `$max` never moves
  // the counter back, so codes already handed out are never reused.
  await prisma.$runCommandRaw({
    update: "counter",
    updates: [{ q: { _id: "registration" }, u: { $max: { value: SAMPLE_COUNT } }, upsert: true }],
  });

  return { added, clash: null };
}

/** Deletes every sample registration, and nothing else — along with any rooms they were given. */
export async function removeSampleRegistrations() {
  const samples = await prisma.registration.findMany({ where: { isSample: true }, select: { id: true } });
  await prisma.roomAllotment.deleteMany({ where: { registrationId: { in: samples.map((s) => s.id) } } });
  const { count } = await prisma.registration.deleteMany({ where: { isSample: true } });
  return count;
}
