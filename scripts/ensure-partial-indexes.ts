/**
 * The indexes Prisma cannot express.
 *
 *   npx ts-node scripts/ensure-partial-indexes.ts
 *
 * RUN THIS AFTER EVERY `prisma db push`. Push reconciles indexes against
 * schema.prisma and drops any it does not recognise, so an index created here
 * does not survive one.
 *
 * `User.dodoCustomerId` has to be unique among users who HAVE one, and absent on
 * everyone else. A plain `@unique` cannot do that on MongoDB: a missing field
 * counts as a value, so the index permits exactly one user without a customer id
 * and refuses to build at all once a second user has never paid — which is what
 * `E11000 dup key: { dodoCustomerId: null }` on `prisma db push` is.
 *
 * A partial index solves it: unique over the documents where the field is a
 * string, and silent about the rest. It matters because the Dodo webhook finds
 * the user to credit by customer id, and two users sharing one would attach a
 * stranger's subscription to the wrong account.
 */
import { prisma } from "../src/utils/db";

const INDEX = "user_dodoCustomerId_partial_key";

/**
 * `createIndexes` and `dropIndexes` are idempotent enough to call blind, which
 * is what this does — `listIndexes` cannot be read back through Prisma's raw
 * command once a partial index exists ("Unknown tagged value": it cannot
 * deserialise the `$type` inside `partialFilterExpression`). Creating an index
 * that already exists with the same definition is a no-op; dropping one that is
 * not there is error 27, which is the expected case after the first run.
 */
const main = async () => {
  await prisma.$runCommandRaw({
    createIndexes: "user",
    indexes: [
      {
        key: { dodoCustomerId: 1 },
        name: INDEX,
        unique: true,
        // The whole point: documents without a customer id are not indexed, so
        // any number of them can coexist.
        partialFilterExpression: { dodoCustomerId: { $type: "string" } },
      },
    ],
  });
  console.log(`${INDEX} is in place.`);

  // One registration per contact number. Partial for the same reason as
  // above: only documents that have the field are indexed.
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

  // Left behind by the older schema that declared `@unique` outright. It is the
  // index that cannot build, so drop it if a push ever managed to create it.
  try {
    await prisma.$runCommandRaw({ dropIndexes: "user", index: "user_dodoCustomerId_key" });
    console.log("Dropped the old non-partial user_dodoCustomerId_key.");
  } catch (error) {
    const message = (error as Error)?.message ?? "";
    if (!/index not found|IndexNotFound|27/.test(message)) throw error;
  }

  await prisma.$disconnect();
};

main().catch(async (e) => {
  console.error(e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
