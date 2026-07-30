import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { authIdentities, users } from "../drizzle/schema";
import { resolveGoogleIdentity } from "./services/googleIdentityService";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";

// Real-database counterpart to server/services/googleIdentityService.test.ts's
// mocked concurrent-login tests - only runs against a genuine MariaDB/MySQL/
// TiDB connection (never Production/Staging - see
// vitest.integration.globalsetup.ts, which already refuses to proceed unless
// TEST_DATABASE_URL's database name is exactly "ipenovel_test", live-verified
// with a real SELECT DATABASE() before any test file runs). This file adds
// its own belt-and-suspenders check of the same fact for defense in depth -
// never a reimplementation, delegates to the same
// server/test-helpers/testDatabaseGuard.ts helper globalSetup uses.
//
// What the mocked unit tests cannot prove: whether the fix (retrying on a
// brand-new transaction/snapshot instead of re-reading inside the failed
// one) actually behaves correctly under REPEATABLE READ against a real
// database, where snapshot semantics are enforced by the server, not by a
// fake object. This file exercises exactly that.

describe.sequential("resolveGoogleIdentity - concurrent same-sub resolution (real database)", () => {
  it("two concurrent resolveGoogleIdentity calls for the SAME sub/email both fulfill, resolve to the same users.id, and create exactly one users row and one authIdentities row", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const tag = uniqueTestTag("gid");
    const sub = `concurrent-sub-${tag}`;
    const email = `concurrent-${tag}@example.test`;

    const input = { sub, email, emailVerified: true, name: "Concurrent Test User" };

    const results = await Promise.all([resolveGoogleIdentity(input), resolveGoogleIdentity(input)]);

    // Both requests succeeded - neither errored, neither returned
    // ambiguous_email or any other non-login outcome.
    for (const result of results) {
      expect(["created", "linked_existing_identity", "linked_by_email"]).toContain(result.outcome);
    }

    const userIds = results.map((r) => (r as { user: { id: number } }).user.id);
    expect(userIds[0]).toBe(userIds[1]);
    const userId = userIds[0];

    const testDb = getTestDb();

    const userRows = await testDb.select().from(users).where(eq(users.id, userId));
    expect(userRows).toHaveLength(1);

    // Exactly one users row was created FOR THIS SUB - not two, regardless
    // of which of the two concurrent calls "won".
    const usersWithThisOpenId = await testDb
      .select()
      .from(users)
      .where(eq(users.openId, userRows[0].openId));
    expect(usersWithThisOpenId).toHaveLength(1);

    const identityRows = await testDb
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, sub));
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0].userId).toBe(userId);
    expect(identityRows[0].provider).toBe("google");
    expect(identityRows[0].providerSubject).toBe(sub);

    await deleteFixtures({ userIds: [userId] });
    // authIdentities_userId_users_id_fk is ON DELETE CASCADE (see
    // drizzle/schema.ts) - deleting the user is sufficient; confirm that
    // cascade actually happened rather than assuming it.
    const identityRowsAfterCleanup = await testDb
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerSubject, sub));
    expect(identityRowsAfterCleanup).toHaveLength(0);
  }, 30000);

  it("three concurrent calls for the same sub still converge on exactly one user (not just two)", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const tag = uniqueTestTag("gid3");
    const sub = `concurrent3-sub-${tag}`;
    const email = `concurrent3-${tag}@example.test`;
    const input = { sub, email, emailVerified: true, name: "Concurrent Three-Way" };

    const results = await Promise.all([resolveGoogleIdentity(input), resolveGoogleIdentity(input), resolveGoogleIdentity(input)]);

    const userIds = new Set(results.map((r) => (r as { user: { id: number } }).user.id));
    expect(userIds.size).toBe(1);
    const userId = [...userIds][0];

    const testDb = getTestDb();
    const identityRows = await testDb.select().from(authIdentities).where(eq(authIdentities.providerSubject, sub));
    expect(identityRows).toHaveLength(1);

    await deleteFixtures({ userIds: [userId] });
  }, 30000);
});
