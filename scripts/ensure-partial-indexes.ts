/**
 * The indexes Prisma cannot express.
 *
 *   npx ts-node scripts/ensure-partial-indexes.ts
 *
 * RUN THIS AFTER EVERY `prisma db push`. Push reconciles indexes against
 * schema.prisma and drops any it does not recognise, so an index created here
 * does not survive one.
 *
 * One registration per contact number: `Registration.contactMobile` has to be
 * unique among registrations that HAVE one, and absent on everyone else. A
 * plain `@unique` cannot do that on MongoDB: a missing field counts as a value,
 * so the index permits exactly one registration without a number and refuses
 * to build at all once there is a second.
 *
 * A partial index solves it: unique over the documents where the field is a
 * string, and silent about the rest.
 *
 * `createIndexes` is idempotent: creating an index that already exists with the
 * same definition is a no-op, so this is safe to run blind.
 */
import { prisma } from "../src/utils/db";

const main = async () => {
  await prisma.$runCommandRaw({
    createIndexes: "registration",
    indexes: [
      {
        key: { contactMobile: 1 },
        name: "registration_contactMobile_partial_key",
        unique: true,
        partialFilterExpression: { contactMobile: { $type: "string" } },
      },
    ],
  });
  console.log("registration_contactMobile_partial_key is in place.");

  await prisma.$disconnect();
};

main().catch(async (e) => {
  console.error(e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
