import type { Registration } from "@prisma/client";

import { buildStayNotice, sameNotice, type StayNotice } from "./accommodation";
import { prisma } from "../utils/db";

/**
 * Keeps room allotments in step with the registration they belong to, after
 * any change to it:
 *
 * - cancelled, or no longer asking for accommodation: every bed is freed;
 * - someone removed from the party: their bed is freed.
 *
 * Anything else that stops fitting — new dates that overfill a room, a
 * registration back to pending after a devotee's edit — keeps its rooms and
 * shows up under "Needs attention" on the Accommodation screen. Nobody is
 * moved without a team member deciding it.
 */
export async function releaseStaleAllotments(registration: Registration) {
  if (registration.status === "cancelled" || !registration.accommodationRequired) {
    await prisma.roomAllotment.deleteMany({ where: { registrationId: registration.id } });
    return;
  }
  await prisma.roomAllotment.deleteMany({
    where: { registrationId: registration.id, memberId: { notIn: registration.members.map((m) => m.id) } },
  });
}

/**
 * The room details to show a devotee on their own page: what they were sent,
 * and only while it is still right. Changed since, and the page says it is
 * being updated rather than showing a room they no longer have.
 */
export async function stayForDevotee(registrations: Registration[]) {
  const sent = registrations.filter((r) => r.stayNoticeSentAt);
  const result = new Map<string, { notice: StayNotice | null; upToDate: boolean }>();
  if (sent.length === 0) return result;

  const [allotments, places] = await Promise.all([
    prisma.roomAllotment.findMany({ where: { registrationId: { in: sent.map((r) => r.id) } } }),
    prisma.accommodationPlace.findMany(),
  ]);
  const placeMap = new Map(places.map((p) => [p.id, p]));
  for (const registration of sent) {
    const current = buildStayNotice(registration, allotments, placeMap);
    const upToDate = !!current && sameNotice(current, registration.stayNotice);
    result.set(registration.id, { notice: upToDate ? current : null, upToDate });
  }
  return result;
}
