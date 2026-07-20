import { describe, it, expect } from "vitest";
import { assertLiveTestDatabaseName } from "./liveTestDatabaseCheck";

/**
 * Uses a fake db (a plain object with an `execute` method) rather than a
 * real connection - this test verifies the parsing/assertion logic itself,
 * which is exactly the part that must be correct regardless of whether a
 * live TEST_DATABASE_URL is available in this environment. The actual
 * live round-trip is exercised for real by scripts/migrate-test-db.ts and
 * vitest.integration.globalsetup.ts, which this repo's docs are explicit
 * cannot be verified without a real disposable TEST_DATABASE_URL.
 */
function fakeDb(returnedName: string | undefined) {
  return {
    execute: async () => [[{ name: returnedName }], []],
  };
}

describe("assertLiveTestDatabaseName", () => {
  it("resolves with the name when it is exactly 'ipenovel_test'", async () => {
    await expect(assertLiveTestDatabaseName(fakeDb("ipenovel_test"))).resolves.toBe("ipenovel_test");
  });

  it("throws when the live database name is anything else", async () => {
    await expect(assertLiveTestDatabaseName(fakeDb("ipenovel"))).rejects.toThrow(/ipenovel_test/);
    await expect(assertLiveTestDatabaseName(fakeDb("ipenovel_production"))).rejects.toThrow();
    await expect(assertLiveTestDatabaseName(fakeDb("IPENOVEL_TEST"))).rejects.toThrow();
  });

  it("throws when no database name is returned at all", async () => {
    await expect(assertLiveTestDatabaseName(fakeDb(undefined))).rejects.toThrow();
  });

  it("handles a db.execute result shaped as { rows: [...] } (not a [rows, fields] tuple)", async () => {
    const db = { execute: async () => ({ rows: [{ name: "ipenovel_test" }] }) };
    await expect(assertLiveTestDatabaseName(db)).resolves.toBe("ipenovel_test");
  });
});
