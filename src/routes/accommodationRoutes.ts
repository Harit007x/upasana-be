import express from "express";

import { accommodationController } from "../controllers/accommodationController";
import { protect, requireAdmin, requireReviewer, requireStaff } from "../middlewares/authMiddleware";

export const accommodationRouter = express.Router();

const { overview, createPlace, updatePlace, deletePlace, allot, release, sendNotice, sendAllNotices } =
  accommodationController;

/**
 * @openapi
 * tags:
 *   name: Accommodation
 *   description: >
 *     Places and rooms, who sleeps where, and sending devotees their room
 *     details. Desk roles read; staff and admins allot; admins edit places.
 */

// Devotees' names and rooms: the desk only, and a sanchalak only for their mandal.
accommodationRouter.use(protect, requireStaff);

/**
 * @openapi
 * /accommodation:
 *   get:
 *     summary: Places, allotments and room-detail notices
 *     description: >
 *       Every place with its rooms, every allotment the viewer may see (one
 *       mandal's for a sanchalak), and for each registration with rooms when
 *       its details were sent and whether they are still right.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ places, allotments, notices, whatsApp }`"
 */
accommodationRouter.get("/", overview);

/**
 * @openapi
 * /accommodation/allotments:
 *   post:
 *     summary: Put people in a room
 *     description: >
 *       `{ registrationId, assignments: [{ memberId, placeId, roomId }] }` —
 *       a room per person, saved together or not at all — or the shorter
 *       `{ registrationId, memberIds, placeId, roomId }` for one room. Moves
 *       anyone who already had a room. The registration must be confirmed and
 *       have asked for accommodation; every room must fit its people on every
 *       night.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The registration's allotments
 *       409:
 *         description: NOT_CONFIRMED, NO_STAY_REQUESTED, NO_NIGHTS or ROOM_PROBLEM
 */
accommodationRouter.post("/allotments", requireReviewer, allot);

/**
 * @openapi
 * /accommodation/allotments/release:
 *   post:
 *     summary: Take people out of their rooms
 *     description: "`{ registrationId, memberIds }`"
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The registration's remaining allotments
 */
accommodationRouter.post("/allotments/release", requireReviewer, release);

/**
 * @openapi
 * /accommodation/registrations/{id}/notice:
 *   post:
 *     summary: Send a registration its room details on WhatsApp
 *     description: >
 *       Without WhatsApp on the server, answers `{ sent: false, message,
 *       whatsappUrl }` to send by hand; `{ manual: true }` then records it as sent.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ sent, channel }`, or the message to send by hand"
 *       409:
 *         description: NOT_CONFIRMED, NOTHING_ALLOTTED or NO_CONTACT
 *       502:
 *         description: SEND_FAILED
 */
accommodationRouter.post("/registrations/:id/notice", requireReviewer, sendNotice);

/**
 * @openapi
 * /accommodation/notices/send-all:
 *   post:
 *     summary: Send room details to everyone fully allotted and not yet told
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: "`{ sent, failed, incomplete }`"
 *       503:
 *         description: WHATSAPP_NOT_CONFIGURED
 */
accommodationRouter.post("/notices/send-all", requireReviewer, sendAllNotices);

/**
 * @openapi
 * /accommodation/places:
 *   post:
 *     summary: Add a place (admin)
 *     tags: [Accommodation]
 *     responses:
 *       201:
 *         description: The place
 *       409:
 *         description: NAME_TAKEN
 */
accommodationRouter.post("/places", requireAdmin, createPlace);

/**
 * @openapi
 * /accommodation/places/{id}:
 *   patch:
 *     summary: Change a place and its rooms (admin)
 *     description: Rooms with people in them cannot be removed or made too small for them.
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: The place
 *       409:
 *         description: ROOM_IN_USE or NAME_TAKEN
 *   delete:
 *     summary: Remove an empty place (admin)
 *     tags: [Accommodation]
 *     responses:
 *       200:
 *         description: Removed
 *       409:
 *         description: PLACE_IN_USE
 */
accommodationRouter.patch("/places/:id", requireAdmin, updatePlace);
accommodationRouter.delete("/places/:id", requireAdmin, deletePlace);
