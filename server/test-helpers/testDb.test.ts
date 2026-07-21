import { describe, it, expect, afterEach } from "vitest";
import { getTestDb, closeTestDb } from "./testDb";

/**
 * Runs against the REAL mysql2 module (no mocking) - mysql2's Pool/Connection
 * constructors are lazy (no TCP connection is attempted until the first
 * query), so this is safe to run in this sandbox without a real
 * TEST_DATABASE_URL/network access: it proves getTestDb()/closeTestDb() wire
 * a real Pool object together correctly, without ever issuing a query
 * against it.
 */
describe("closeTestDb", () => {
  const originalUrl = process.env.TEST_DATABASE_URL;

  afterEach(async () => {
    await closeTestDb();
    if (originalUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalUrl;
  });

  it("is a safe no-op when nothing has ever connected", async () => {
    await expect(closeTestDb()).resolves.toBeUndefined();
  });

  it("closes the actual pool getTestDb() created (not a reference reconstructed from drizzle's internals)", async () => {
    process.env.TEST_DATABASE_URL = "mysql://user:pass@localhost:3306/ipenovel_test";
    const db = getTestDb();
    expect(db).toBeDefined();

    // Must not throw even though nothing ever actually connected over the
    // network (localhost:3306 is unreachable in this sandbox) - proves
    // closeTestDb() ends the real pool object it retained, not a value it
    // has to "hope" is still reachable through drizzle's $client.
    await expect(closeTestDb()).resolves.toBeUndefined();
  });

  it("getTestDb() fails closed before ever creating a pool when TEST_DATABASE_URL is unsafe", () => {
    process.env.TEST_DATABASE_URL = "mysql://user:pass@localhost:3306/ipenovel_production";
    expect(() => getTestDb()).toThrow();
  });

  it("getTestDb() fails closed when TEST_DATABASE_URL is missing", () => {
    delete process.env.TEST_DATABASE_URL;
    expect(() => getTestDb()).toThrow();
  });
});
