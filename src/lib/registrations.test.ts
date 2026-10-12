/**
 * Names are kept in English letters, whatever language the form was shown in
 * (the public pages offer Gujarati), so the team's search, sorting and printed
 * reports work on every registration. The form says so first; these pin the
 * server's own check, which also covers the desk and any other client.
 */
import { describe, expect, it } from "vitest";

import { MOBILE_E164 } from "./event";
import {
  hasNonLatinLetters,
  newRegistrationSchema,
  splitFullName,
  toCreateData,
} from "./registrations";

const stay = { date: "2027-01-29", slot: "morning", meal: true };
const leave = { date: "2027-01-30", slot: "evening", meal: true };
/** "Ramesh Patel" as the form sends it, with a middle name when the name has none. */
const person = (name: string, extra: object = {}) => ({
  ...splitFullName(name),
  ...(name.trim().split(/\s+/).length < 3 ? { middleName: "Kantilal" } : {}),
  gender: "male",
  age: 40,
  isPrimary: false,
  needsAssistance: false,
  arrival: stay,
  departure: leave,
  ...extra,
});
const registration = (overrides: object = {}) => ({
  type: "individual",
  mandal: "Surat",
  members: [person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" })],
  arrival: stay,
  departure: leave,
  travel: { mode: "train", needsPickup: false },
  accommodationRequired: false,
  source: "self",
  ...overrides,
});
const messagesAt = (input: object, path: string) => {
  const result = newRegistrationSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.filter(i => i.path.join(".") === path).map(i => i.message);
};

describe("hasNonLatinLetters", () => {
  it.each(["Ramesh Patel", "José D'Souza", "R. K. Shah-Mehta", ""])("accepts %j", name => {
    expect(hasNonLatinLetters(name)).toBe(false);
  });
  it.each(["રમેશ પટેલ", "Ramesh પટેલ", "रमेश"])("rejects %j", name => {
    expect(hasNonLatinLetters(name)).toBe(true);
  });
});

describe("names on a registration", () => {
  it("accepts a name in English letters", () => {
    expect(newRegistrationSchema.safeParse(registration()).success).toBe(true);
  });

  it("refuses a person's name in Gujarati", () => {
    const input = registration({
      members: [person("રમેશ પટેલ", { isPrimary: true, mobile: "+919876543210" })],
    });
    expect(messagesAt(input, "members.0.firstName")).toContain("Write the name in English letters");
    expect(messagesAt(input, "members.0.surname")).toContain("Write the name in English letters");
  });

  it("asks for the first, middle and surname", () => {
    const contact = { isPrimary: true, mobile: "+919876543210" };
    const noSurname = registration({ members: [person("Ramesh", contact)] });
    expect(messagesAt(noSurname, "members.0.surname")).toEqual(["Enter the surname"]);
    const noFirst = registration({
      members: [{ ...person("Ramesh Patel", contact), firstName: " " }],
    });
    expect(messagesAt(noFirst, "members.0.firstName")).toEqual(["Enter the first name"]);
    for (const middleName of [" ", null, undefined]) {
      const noMiddle = registration({
        members: [{ ...person("Ramesh Patel", contact), middleName }],
      });
      expect(messagesAt(noMiddle, "members.0.middleName")).toEqual(["Enter the middle name"]);
    }
    expect(newRegistrationSchema.safeParse(registration()).success).toBe(true);
  });

  it("saves the parts joined as the full name", () => {
    const input = newRegistrationSchema.parse(
      registration({
        members: [
          person("Ramesh  Kantilal   Patel ", { isPrimary: true, mobile: "+919876543210" }),
        ],
      })
    );
    const [saved] = toCreateData(input).members;
    expect(saved).toMatchObject({
      firstName: "Ramesh",
      middleName: "Kantilal",
      surname: "Patel",
      fullName: "Ramesh Kantilal Patel",
    });
  });

  it("still takes one full name from a form opened before the change", () => {
    const legacy = {
      fullName: "Ramesh Kantilal Patel",
      gender: "male",
      age: 40,
      isPrimary: true,
      mobile: "+919876543210",
      needsAssistance: false,
      arrival: stay,
      departure: leave,
    };
    const input = newRegistrationSchema.parse(registration({ members: [legacy] }));
    expect(toCreateData(input).members[0]).toMatchObject({
      firstName: "Ramesh",
      middleName: "Kantilal",
      surname: "Patel",
      fullName: "Ramesh Kantilal Patel",
    });
  });

  it("flags the same person listed twice on the first name", () => {
    const input = registration({
      type: "family",
      groupName: "Patel family",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" }),
        person("ramesh  patel", { relation: "Brother" }),
      ],
    });
    expect(messagesAt(input, "members.1.firstName")).toEqual(["The same person is listed twice"]);
  });

  it("refuses a family name in Gujarati", () => {
    const input = registration({
      type: "family",
      groupName: "પટેલ પરિવાર",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" }),
        person("Sita Patel", { gender: "female" }),
      ],
    });
    expect(messagesAt(input, "groupName")).toEqual(["Write the name in English letters"]);
  });
});

describe("mobile numbers by country", () => {
  it.each([
    "+919876543210",
    "+12015550123",
    "+447700900123",
    "+61412345678",
    "+6421123456",
    "+64211234567",
    "+642112345678",
    "+971501234567",
  ])("accepts %s", mobile => expect(MOBILE_E164.test(mobile)).toBe(true));
  it.each([
    "+915876543210", // India: starts 6–9
    "+61312345678", // Australia: mobiles start with 4
    "+6491123456", // New Zealand: mobiles start with 2
    "+971412345678", // UAE: mobiles start with 5
    "+9715012345", // UAE: too short
  ])("refuses %s", mobile => expect(MOBILE_E164.test(mobile)).toBe(false));
});
