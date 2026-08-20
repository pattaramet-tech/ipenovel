import { describe, it, expect } from "vitest";
import { authIdentities } from "../drizzle/schema";
import { getAdminUsersList } from "./db";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, deleteFixtures, uniqueTestTag } from "./test-helpers/fixtures";

// Real-database counterpart to server/adminUsersGoogleConnected.test.ts's
// connection-free SQL-shape assertion - only runs against a genuine
// MariaDB/MySQL/TiDB test database (TEST_DATABASE_URL, never DATABASE_URL/
// Production - see vitest.integration.globalsetup.ts, and
// vitest.integration.setupfile.ts, which wires server/db.ts's getDb() to
// the verified test connection for every test file in this project).
//
// PR #45 review finding: admin.users.list's "Google connection" filter/
// column previously checked ONLY "does this user have ANY authIdentities
// row", with no provider filter - so a user linked to some OTHER provider
// (not Google) would have incorrectly shown as Google-connected. The fix
// (buildAdminUsersGoogleConnectedExistsCondition in server/db.ts) adds
// `AND provider = 'google'`. This file proves that against real rows in a
// real database - the static SQL-shape test can prove the query TEXT
// changed, but not that MariaDB actually evaluates it as intended.
describe.sequential("getAdminUsersList - googleConnected / googleConnection filter (real database)", () => {
  it("a user with a real 'google' authIdentities row -> googleConnected true, and is included by googleConnection: 'connected'", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const user = await createTestUser();
    await testDb.insert(authIdentities).values({
      userId: user.id,
      provider: "google",
      providerSubject: `sub-${uniqueTestTag("google")}`,
      emailAtLink: `${uniqueTestTag("google")}@example.test`,
    });

    try {
      const result = await getAdminUsersList({ page: 1, pageSize: 100, search: String(user.id) });
      const row = result.users.find((u) => u.id === user.id);
      expect(row?.googleConnected).toBe(true);

      const connectedResult = await getAdminUsersList({
        page: 1,
        pageSize: 100,
        search: String(user.id),
        googleConnection: "connected",
      });
      expect(connectedResult.users.some((u) => u.id === user.id)).toBe(true);
      expect(connectedResult.total).toBeGreaterThanOrEqual(1);

      const notConnectedResult = await getAdminUsersList({
        page: 1,
        pageSize: 100,
        search: String(user.id),
        googleConnection: "not_connected",
      });
      expect(notConnectedResult.users.some((u) => u.id === user.id)).toBe(false);
    } finally {
      await deleteFixtures({ userIds: [user.id] });
    }
  }, 30000);

  it("a user with ONLY a non-google authIdentities row -> googleConnected false, and is included by googleConnection: 'not_connected', never 'connected' (the exact bug this fix closes)", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const user = await createTestUser();
    await testDb.insert(authIdentities).values({
      userId: user.id,
      provider: "some_other_provider",
      providerSubject: `sub-${uniqueTestTag("other")}`,
      emailAtLink: `${uniqueTestTag("other")}@example.test`,
    });

    try {
      const result = await getAdminUsersList({ page: 1, pageSize: 100, search: String(user.id) });
      const row = result.users.find((u) => u.id === user.id);
      expect(row?.googleConnected).toBe(false);

      const connectedResult = await getAdminUsersList({
        page: 1,
        pageSize: 100,
        search: String(user.id),
        googleConnection: "connected",
      });
      expect(connectedResult.users.some((u) => u.id === user.id)).toBe(false);

      const notConnectedResult = await getAdminUsersList({
        page: 1,
        pageSize: 100,
        search: String(user.id),
        googleConnection: "not_connected",
      });
      expect(notConnectedResult.users.some((u) => u.id === user.id)).toBe(true);
    } finally {
      await deleteFixtures({ userIds: [user.id] });
    }
  }, 30000);

  it("a user with BOTH a google and a non-google authIdentities row -> googleConnected true (EXISTS matches on the google row alone), and no duplicate row in the list (proves the EXISTS-not-JOIN design)", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const testDb = getTestDb();
    const user = await createTestUser();
    const tag = uniqueTestTag("both");
    await testDb.insert(authIdentities).values([
      { userId: user.id, provider: "google", providerSubject: `sub-google-${tag}`, emailAtLink: `google-${tag}@example.test` },
      { userId: user.id, provider: "some_other_provider", providerSubject: `sub-other-${tag}`, emailAtLink: `other-${tag}@example.test` },
    ]);

    try {
      const result = await getAdminUsersList({ page: 1, pageSize: 100, search: String(user.id) });
      const matches = result.users.filter((u) => u.id === user.id);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.googleConnected).toBe(true);
    } finally {
      await deleteFixtures({ userIds: [user.id] });
    }
  }, 30000);

  it("a user with NO authIdentities row at all -> googleConnected false", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const user = await createTestUser();
    try {
      const result = await getAdminUsersList({ page: 1, pageSize: 100, search: String(user.id) });
      const row = result.users.find((u) => u.id === user.id);
      expect(row?.googleConnected).toBe(false);
    } finally {
      await deleteFixtures({ userIds: [user.id] });
    }
  }, 30000);
});
