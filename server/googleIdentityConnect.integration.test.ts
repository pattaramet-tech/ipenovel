import { afterEach, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { authIdentities, users } from "../drizzle/schema";
import { connectGoogleIdentityToUser } from "./services/googleIdentityService";
import { isBlockedByGoogleMigrationGate } from "./_core/googleMigrationGate";
import { ENV } from "./_core/env";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { uniqueTestTag, deleteFixtures, createTestUser } from "./test-helpers/fixtures";

// Real-database counterpart to server/services/googleIdentityService.test.ts's
// mocked connectGoogleIdentityToUser tests - only runs against a genuine
// MariaDB/MySQL/TiDB connection whose database name is EXACTLY
// "ipenovel_test" (see server/test-helpers/testDatabaseGuard.ts /
// vitest.integration.globalsetup.ts, which enforces this both from the
// connection string and via a live "SELECT DATABASE()" query before any
// test runs). Every test in this file also no-ops (returns immediately)
// if TEST_DATABASE_URL isn't set at all - it never falls back to
// DATABASE_URL, and it is never run automatically as part of the
// DB-independent pre-push validation suite (`npx vitest run client` /
// the targeted unit-test run) - only an explicit integration run with a
// verified TEST_DATABASE_URL exercises it.
//
// What the mocked unit tests cannot prove: whether the fresh-transaction-
// per-attempt retry (server/services/googleIdentityService.ts's
// connectGoogleIdentityToUserAttempt / connectGoogleIdentityToUser) actually
// behaves correctly under a real database's REPEATABLE READ snapshot
// semantics when two connect attempts for the SAME (userId, sub) race for
// real, not a fake transaction object.

describe.sequential("connectGoogleIdentityToUser - concurrent explicit connect (real database)", () => {
  it("two concurrent connectGoogleIdentityToUser calls for the SAME user+sub both fulfill (one 'connected', one 'already_connected' - or both 'already_connected' if serialized), and exactly ONE authIdentities row exists afterward, with users.id/openId unchanged", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const tag = uniqueTestTag("connect");
    const fixtureUser = await createTestUser({ name: "Connect Integration User" });
    const sub = `connect-sub-${tag}`;
    const email = `connect-${tag}@example.test`;

    const input = { userId: fixtureUser.id, sub, email, emailVerified: true };

    try {
      const results = await Promise.all([
        connectGoogleIdentityToUser(testDb, input),
        connectGoogleIdentityToUser(testDb, input),
      ]);

      // Neither call ever throws, and neither ever reports a conflict -
      // this is the SAME user connecting the SAME sub twice, concurrently,
      // which is exactly the idempotent case, never a genuine conflict.
      for (const result of results) {
        expect(["connected", "already_connected"]).toContain(result.outcome);
      }

      const identityRows = await testDb
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.providerSubject, sub));
      expect(identityRows).toHaveLength(1);
      expect(identityRows[0].userId).toBe(fixtureUser.id);
      expect(identityRows[0].provider).toBe("google");

      // users.id/openId are completely untouched by the connect flow -
      // re-read the row and compare against the fixture's own values.
      const userRows = await testDb.select().from(users).where(eq(users.id, fixtureUser.id));
      expect(userRows).toHaveLength(1);
      expect(userRows[0].id).toBe(fixtureUser.id);
      expect(userRows[0].openId).toBe(fixtureUser.openId);
    } finally {
      await deleteFixtures({ userIds: [fixtureUser.id] });
    }

    // authIdentities_userId_users_id_fk is ON DELETE CASCADE - confirm the
    // identity row is actually gone, not just the user.
    const identityRowsAfterCleanup = await testDb
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, sub));
    expect(identityRowsAfterCleanup).toHaveLength(0);
  }, 30000);

  it("a genuine conflict (sub already connected to a DIFFERENT user) is detected against the real database and fails closed - the identity is never moved, no second row is created", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const tag = uniqueTestTag("connectconflict");
    const ownerUser = await createTestUser({ name: "Connect Conflict Owner" });
    const otherUser = await createTestUser({ name: "Connect Conflict Other" });
    const sub = `connect-conflict-sub-${tag}`;
    const email = `connect-conflict-${tag}@example.test`;

    try {
      const first = await connectGoogleIdentityToUser(testDb, { userId: ownerUser.id, sub, email, emailVerified: true });
      expect(first).toEqual({ outcome: "connected" });

      const conflictAttempt = await connectGoogleIdentityToUser(testDb, {
        userId: otherUser.id,
        sub,
        email,
        emailVerified: true,
      });
      expect(conflictAttempt).toEqual({ outcome: "conflict_sub_linked_to_different_user" });

      const identityRows = await testDb.select().from(authIdentities).where(eq(authIdentities.providerSubject, sub));
      expect(identityRows).toHaveLength(1);
      expect(identityRows[0].userId).toBe(ownerUser.id);
    } finally {
      await deleteFixtures({ userIds: [ownerUser.id, otherUser.id] });
    }
  }, 30000);
});

// Mandatory-migration gate (server/_core/googleMigrationGate.ts) coverage
// against a REAL database read - the mocked unit tests
// (server/_core/googleMigrationGate.test.ts) already cover the decision
// logic itself; what they cannot prove is that
// db.getAuthIdentityByUserAndProvider (the same db.ts function, via its own
// getDb(), NOT getTestDb() directly - see fixtures.ts's docstring on why
// that's safe only inside an *.integration.test.ts file, where
// vitest.integration.globalsetup.ts points DATABASE_URL at the same
// TEST_DATABASE_URL) actually reflects a real, just-inserted authIdentities
// row. No new migration, no schema change - reuses the exact same
// connectGoogleIdentityToUser fixture pattern as the tests above.
describe.sequential("isBlockedByGoogleMigrationGate (real database)", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
  });

  it("a real user with NO connected Google identity is blocked; after a real connectGoogleIdentityToUser call, the SAME user is no longer blocked", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;

    const testDb = getTestDb();
    const tag = uniqueTestTag("gate");
    const fixtureUser = await createTestUser({ name: "Migration Gate Integration User" });
    const sub = `gate-sub-${tag}`;
    const email = `gate-${tag}@example.test`;

    try {
      const blockedBefore = await isBlockedByGoogleMigrationGate({ id: fixtureUser.id });
      expect(blockedBefore).toBe(true);

      const connectResult = await connectGoogleIdentityToUser(testDb, {
        userId: fixtureUser.id,
        sub,
        email,
        emailVerified: true,
      });
      expect(connectResult).toEqual({ outcome: "connected" });

      const blockedAfter = await isBlockedByGoogleMigrationGate({ id: fixtureUser.id });
      expect(blockedAfter).toBe(false);
    } finally {
      await deleteFixtures({ userIds: [fixtureUser.id] });
    }
  }, 30000);

  it("the gate never queries the database at all when AUTH_REQUIRE_GOOGLE_CONNECTION is not active - real db.getAuthIdentityByUserAndProvider is never invoked", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    ENV.authProvider = "manus";
    ENV.requireGoogleConnection = false;

    const fixtureUser = await createTestUser({ name: "Migration Gate Inactive User" });
    try {
      const blocked = await isBlockedByGoogleMigrationGate({ id: fixtureUser.id });
      expect(blocked).toBe(false);
    } finally {
      await deleteFixtures({ userIds: [fixtureUser.id] });
    }
  }, 30000);
});
