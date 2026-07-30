import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { resolveGoogleIdentity } from "./googleIdentityService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

/** A fake `tx` whose `update(...).set(...).where(...)` chain resolves successfully and records what was written, without touching a real database. */
function fakeTx() {
  const updateCalls: Array<{ set: Record<string, unknown> }> = [];
  return {
    tx: {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateCalls.push({ set: values });
          return { where: async () => undefined };
        },
      }),
    },
    updateCalls,
  };
}

/** A fake drizzle db handle whose .transaction() just invokes the callback with a fake tx and returns its result - no real database, no real transaction. */
function fakeDbWithTransaction(tx: unknown) {
  return {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
  };
}

const GOOGLE_INPUT = {
  sub: "google-sub-123",
  email: "User@Example.com",
  emailVerified: true,
  name: "Somchai",
};

describe("resolveGoogleIdentity - input validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emailVerified=false -> throws, never touches the database at all", async () => {
    const assertSpy = vi.spyOn(db, "assertDatabaseAvailable");
    await expect(resolveGoogleIdentity({ ...GOOGLE_INPUT, emailVerified: false })).rejects.toThrow(/verif/i);
    expect(assertSpy).not.toHaveBeenCalled();
  });

  it("empty sub -> throws before touching the database", async () => {
    const assertSpy = vi.spyOn(db, "assertDatabaseAvailable");
    await expect(resolveGoogleIdentity({ ...GOOGLE_INPUT, sub: "" })).rejects.toThrow(/sub/i);
    expect(assertSpy).not.toHaveBeenCalled();
  });

  it("empty email -> throws before touching the database", async () => {
    const assertSpy = vi.spyOn(db, "assertDatabaseAvailable");
    await expect(resolveGoogleIdentity({ ...GOOGLE_INPUT, email: "   " })).rejects.toThrow(/email/i);
    expect(assertSpy).not.toHaveBeenCalled();
  });
});

describe("resolveGoogleIdentity - database unavailable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("database unavailable -> throws, never resolves to a logged-in outcome", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(new Error("[Database] Database connection is not available"));
    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/not available/i);
  });
});

describe("resolveGoogleIdentity - existing authIdentity (scenario 15/22: second login, no duplicate)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an authIdentities row already exists -> uses that user's id as-is, never creates or links again", async () => {
    const { tx, updateCalls } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);

    const existingUser = { id: 7, openId: "google:google-sub-123", name: "Somchai", email: "user@example.com" } as any;
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 7, provider: "google", providerSubject: "google-sub-123" } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(existingUser);
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity");
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity");
    const findByEmailSpy = vi.spyOn(db, "findUsersByNormalizedEmail");

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result.outcome).toBe("linked_existing_identity");
    expect(result.outcome === "linked_existing_identity" && result.user.id).toBe(7);
    expect(createSpy).not.toHaveBeenCalled();
    expect(linkSpy).not.toHaveBeenCalled();
    expect(findByEmailSpy).not.toHaveBeenCalled();
    // lastSignedIn is always touched.
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].set).toHaveProperty("lastSignedIn");
  });

  it("authIdentities row references a userId that no longer exists -> throws rather than silently proceeding", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 999, provider: "google", providerSubject: "google-sub-123" } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(undefined);

    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/no longer exists/i);
  });
});

describe.each([
  ["google", "google"],
  ["null", null],
  ["apple", "apple"],
  ["email", "email"],
])("resolveGoogleIdentity - link by email (scenarios 16-19: existing user loginMethod=%s)", (_label, loginMethod) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exactly one existing user shares the normalized email -> links, updates loginMethod to google, never creates a duplicate user", async () => {
    const { tx, updateCalls } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce(undefined).mockResolvedValue(undefined);

    const existingUser = { id: 55, openId: "manus-openid-abc", name: "Original Name", email: "user@example.com", loginMethod } as any;
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([existingUser]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity").mockResolvedValue(undefined);
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity");
    vi.spyOn(db, "getUserById").mockResolvedValue({ ...existingUser, loginMethod: "google" });

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result.outcome).toBe("linked_by_email");
    expect(result.outcome === "linked_by_email" && result.user.id).toBe(55);
    expect(createSpy).not.toHaveBeenCalled();
    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 55, providerSubject: GOOGLE_INPUT.sub }),
      tx
    );
    // users.id and openId are never part of any update - only lastSignedIn/name/loginMethod.
    const setCalls = updateCalls.map((c) => c.set);
    for (const set of setCalls) {
      expect(set).not.toHaveProperty("id");
      expect(set).not.toHaveProperty("openId");
    }
    expect(setCalls.some((s) => s.loginMethod === "google")).toBe(true);
  });
});

describe("resolveGoogleIdentity - fail closed on ambiguous email (scenario 20)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("more than one existing user shares the normalized email -> ambiguous_email, never auto-links, never picks the first row, never creates a new user", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);

    const userA = { id: 1, email: "user@example.com" } as any;
    const userB = { id: 2, email: "USER@EXAMPLE.COM" } as any;
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([userA, userB]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity");
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity");

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result).toEqual({ outcome: "ambiguous_email" });
    expect(linkSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("resolveGoogleIdentity - new user (scenario 21)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no identity, no matching user -> creates exactly one new user and one identity row", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);

    const newUser = { id: 100, openId: "google:google-sub-123", name: "Somchai", email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValue(newUser);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result).toEqual({ outcome: "created", user: newUser });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubject: GOOGLE_INPUT.sub, email: "User@Example.com", name: "Somchai" }),
      tx
    );
  });

  it("uses the REAL computeGoogleOpenId (not mocked) so createGoogleUserWithIdentity's caller-visible contract matches production - a 255-char sub still resolves to a <=64-char openId end to end", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);

    const longSub = "8".repeat(255);
    const expectedOpenId = db.computeGoogleOpenId(longSub);
    expect(expectedOpenId.length).toBeLessThanOrEqual(64);

    // createGoogleUserWithIdentity itself is still mocked here (no real DB
    // insert), but it's asserted to have been called with the exact
    // providerSubject - the openId computation this test cares about
    // happens for real, unmocked, inside computeGoogleOpenId above.
    const createdUser = { id: 101, openId: expectedOpenId, name: null, email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValue(createdUser);

    const result = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub: longSub });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ providerSubject: longSub }), tx);
    expect(result.outcome === "created" && result.user.openId).toBe(expectedOpenId);
    expect((result.outcome === "created" && result.user.openId.length) || 0).toBeLessThanOrEqual(64);
  });
});

describe("resolveGoogleIdentity - repeat login with the same sub (scenario 22: same openId, no duplicate user)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first login creates a user with a computeGoogleOpenId-derived openId; a second login with the SAME sub finds the existing identity and returns the SAME openId, never calling createGoogleUserWithIdentity again", async () => {
    const sub = "repeat-login-sub-123";
    const expectedOpenId = db.computeGoogleOpenId(sub);

    // --- First login: no identity, no matching user -> creates one.
    const { tx: tx1 } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx1) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValueOnce([]);
    const createdUser = { id: 202, openId: expectedOpenId, name: "Somchai", email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValueOnce(createdUser);

    const firstResult = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub });
    expect(firstResult).toEqual({ outcome: "created", user: createdUser });
    expect(createSpy).toHaveBeenCalledTimes(1);

    // --- Second login, same sub: an authIdentities row now exists -> must
    // reuse the SAME user/openId, never create a second user.
    const { tx: tx2 } = fakeTx();
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx2) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce({ id: 5, userId: 202, provider: "google", providerSubject: sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(createdUser);

    const secondResult = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub });

    expect(secondResult.outcome).toBe("linked_existing_identity");
    expect(secondResult.outcome === "linked_existing_identity" && secondResult.user.openId).toBe(expectedOpenId);
    expect(secondResult.outcome === "linked_existing_identity" && secondResult.user.id).toBe(202);
    // Still only ever called once, across both logins.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveGoogleIdentity - concurrent insert race (scenario 23)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("linkGoogleIdentity hits a duplicate-key race -> re-reads the identity instead of erroring or creating a duplicate", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);

    const existingUser = { id: 55, openId: "manus-openid-abc", email: "user@example.com" } as any;
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([existingUser]);

    const duplicateKeyError = Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } });
    vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(duplicateKeyError);

    // First getAuthIdentity call (step 1) finds nothing; the race-recovery
    // re-read (after the duplicate-key catch) finds the identity a
    // concurrent request just won.
    vi.spyOn(db, "getAuthIdentity")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 9, userId: 55, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(existingUser);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result.outcome).toBe("linked_by_email");
    expect(result.outcome === "linked_by_email" && result.user.id).toBe(55);
  });

  it("createGoogleUserWithIdentity hits a duplicate-key race (same sub, two concurrent new-user attempts) -> re-reads instead of creating a second user", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);

    const duplicateKeyError = Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } });
    vi.spyOn(db, "createGoogleUserWithIdentity").mockRejectedValue(duplicateKeyError);

    const winnerUser = { id: 200, openId: "google:google-sub-123" } as any;
    vi.spyOn(db, "getAuthIdentity")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 3, userId: 200, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(winnerUser);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result).toEqual({ outcome: "linked_existing_identity", user: winnerUser });
  });

  it("a non-duplicate-key error during linking is rethrown, never swallowed", async () => {
    const { tx } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([{ id: 1, email: "user@example.com" } as any]);
    vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(new Error("connection reset"));

    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/connection reset/);
  });
});

describe("resolveGoogleIdentity - name preservation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("existing name is preserved when Google sends no usable name", async () => {
    const { tx, updateCalls } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 7, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue({ id: 7, name: "Existing Name" } as any);

    await resolveGoogleIdentity({ ...GOOGLE_INPUT, name: null });

    expect(updateCalls[0].set).not.toHaveProperty("name");
  });

  it("a usable Google name overwrites the stored name", async () => {
    const { tx, updateCalls } = fakeTx();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDbWithTransaction(tx) as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 7, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue({ id: 7, name: "Old Name" } as any);

    await resolveGoogleIdentity({ ...GOOGLE_INPUT, name: "New Name From Google" });

    expect(updateCalls[0].set).toHaveProperty("name", "New Name From Google");
  });
});
