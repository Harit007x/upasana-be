/**
 * Adds the four confirmed guest houses from the accommodation sheet
 * ("Accommodation_Upasanadham Dashabdi Mahotsav 2027.xlsx").
 *
 *   pnpm seed:accommodation    adds any of the four not already there, by name
 *
 * The sheet gives each place's number of rooms and the most people it takes,
 * not the rooms themselves. So the rooms here are made up to match those
 * totals — numbered 1 to N, beds spread as evenly as they go, about 40% family
 * rooms and the rest split between gents and ladies, none marked ground floor.
 * Admins correct them from the place's Edit screen once the guest houses send
 * their real room lists.
 */
import "../src/env";

import { withRoomIds } from "../src/lib/accommodation";
import { prisma } from "../src/utils/db";

type Seed = { name: string; address: string; area: string; rooms: number; beds: number };

const PLACES: Seed[] = [
  { name: "Guj University Guest House", address: "University Campus, Navrangpura", area: "Navrangpura", rooms: 20, beds: 50 },
  { name: "BAOU Guest House", address: "Nirma University, SG Highway", area: "SG Highway", rooms: 20, beds: 50 },
  { name: "Sahkar Bhavan", address: "Ankur Char Rasta, Naranpura", area: "Naranpura", rooms: 12, beds: 60 },
  { name: "Gurukul – Memnagar", address: "Memnagar", area: "Memnagar", rooms: 30, beds: 70 },
];

/** `count` rooms holding `beds` between them, the bigger rooms first. */
function rooms(count: number, beds: number) {
  const base = Math.floor(beds / count);
  const bigger = beds % count;
  const family = Math.round(count * 0.4);
  const gents = Math.round((count - family) / 2);
  const kind = (index: number) => (index < family ? "family" : index < family + gents ? "gents" : "ladies") as const;
  return Array.from({ length: count }, (_, index) => ({
    label: String(index + 1),
    beds: base + (index < bigger ? 1 : 0),
    kind: kind(index),
    groundFloor: false,
  }));
}

async function main() {
  const last = await prisma.accommodationPlace.findFirst({ orderBy: { sortOrder: "desc" } });
  let order = last?.sortOrder ?? 0;

  for (const seed of PLACES) {
    const existing = await prisma.accommodationPlace.findUnique({ where: { name: seed.name } });
    if (existing) {
      console.log(`${seed.name}: already there, left as it is.`);
      continue;
    }
    await prisma.accommodationPlace.create({
      data: {
        name: seed.name,
        kind: "guest_house",
        address: seed.address,
        area: seed.area,
        mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${seed.name}, ${seed.address}, Ahmedabad`)}`,
        notes: `Rooms are placeholders made from the sheet's totals (${seed.rooms} rooms, ${seed.beds} people). Replace them with the real room list.`,
        sortOrder: ++order,
        rooms: withRoomIds(rooms(seed.rooms, seed.beds)),
      },
    });
    console.log(`${seed.name}: added, ${seed.rooms} rooms, ${seed.beds} beds.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
