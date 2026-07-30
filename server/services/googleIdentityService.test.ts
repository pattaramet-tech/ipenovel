import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { resolveGoogleIdentity, resolveGoogleIdentityAttempt } from "./googleIdentityService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

/**
 * A fake drizzle db handle whose .transaction() creates a BRAND NEW,
 * distinguishable tx object EVERY time it is called - never reuses one
 * across calls - and records how many times it was called and which tx
 * object each call used. If the callback throws, the returned promise
 * rejects (mirroring drizzle's real behavior: it issues ROLLBACK, then
 * rejects), exactly what resolveGoogleIdentity's retry loop depends on to
 * decide whether to try again.
 *
 * This is what makes "retry uses a new transaction object" and "attempt
 * 1's transaction rejects/rolls back" directly assertable - a fake that
 * reused one tx object across "attempts" would not prove anything about
 * this fix, since the whole point of the fix is that a same-transaction
 * re-read is unsafe under REPEATABLE READ. No test in this file may claim
 * a same-fake-tx re-read is an adequate substitute for this.
 */
function fakeDbWithFreshTransactions() {
  const txObjects: any[] = [];
  const updateCallsByTx = new Map<any, Array<{ set: Record<string, unknown> }>>();

  function makeTx() {
    const marker = { __txMarker: txObjects.length + 1 };
    const updateCalls: Array<{ set: Record<string, unknown> }> = [];
    const tx = {
      ...marker,
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateCalls.push({ set: values });
          return { where: async () => undefined };
        },
      }),
    };
    updateCallsByTx.set(tx, updateCalls);
    return tx;
  }

  const fakeDb = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTx();
      txObjects.push(tx);
      // No try/catch here on purpose - a callback rejection must propagate
      // out of .transaction() as-is, exactly like a real rollback-then-reject.
      return await callback(tx);
    },
  };

  // callCount is deliberately NOT a destructured getter - `const { callCount }
  // = fakeDbWithFreshTransactions()` would evaluate it once at destructure
  // time (before any .transaction() calls happen) and freeze it at 0.
  // Read `txObjects.length` directly at assertion time instead - arrays
  // are references, so the SAME `txObjects` binding stays live across
  // every .transaction() call that follows.
  return {
    fakeDb,
    txObjects,
    updateCallsFor: (tx: unknown) => updateCallsByTx.get(tx) ?? [],
  };
}

function duplicateKeyError(): Error {
  return Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } });
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

  it("an authIdentities row already exists -> uses that user's id as-is, never creates or links again, exactly one transaction attempt", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);

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
    expect(txObjects.length).toBe(1);
  });

  it("authIdentities row references a userId that no longer exists -> throws rather than silently proceeding", async () => {
    const { fakeDb } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
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
    const { fakeDb, updateCallsFor, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);

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
      txObjects[0]
    );
    const setCalls = updateCallsFor(txObjects[0]).map((c) => c.set);
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
    const { fakeDb } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
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

  it("no identity, no matching user -> creates exactly one new user and one identity row, exactly one transaction attempt", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);

    const newUser = { id: 100, openId: "google:google-sub-123", name: "Somchai", email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValue(newUser);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result).toEqual({ outcome: "created", user: newUser });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerSubject: GOOGLE_INPUT.sub, email: "User@Example.com", name: "Somchai" }),
      txObjects[0]
    );
    expect(txObjects.length).toBe(1);
  });

  it("uses the REAL computeGoogleOpenId (not mocked) so createGoogleUserWithIdentity's caller-visible contract matches production - a 255-char sub still resolves to a <=64-char openId end to end", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);

    const longSub = "8".repeat(255);
    const expectedOpenId = db.computeGoogleOpenId(longSub);
    expect(expectedOpenId.length).toBeLessThanOrEqual(64);

    const createdUser = { id: 101, openId: expectedOpenId, name: null, email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValue(createdUser);

    const result = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub: longSub });

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ providerSubject: longSub }), txObjects[0]);
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
    const first = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(first.fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValueOnce([]);
    const createdUser = { id: 202, openId: expectedOpenId, name: "Somchai", email: "user@example.com", loginMethod: "google" } as any;
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValueOnce(createdUser);

    const firstResult = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub });
    expect(firstResult).toEqual({ outcome: "created", user: createdUser });
    expect(createSpy).toHaveBeenCalledTimes(1);

    // --- Second login, same sub, its own separate call to resolveGoogleIdentity
    // (a genuinely new, unrelated invocation - not a retry of the first) -
    // an authIdentities row now exists -> must reuse the SAME user/openId,
    // never create a second user.
    const second = fakeDbWithFreshTransactions();
    vi.spyOn(db, "getDb").mockResolvedValue(second.fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce({ id: 5, userId: 202, provider: "google", providerSubject: sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(createdUser);

    const secondResult = await resolveGoogleIdentity({ ...GOOGLE_INPUT, sub });

    expect(secondResult.outcome).toBe("linked_existing_identity");
    expect(secondResult.outcome === "linked_existing_identity" && secondResult.user.openId).toBe(expectedOpenId);
    expect(secondResult.outcome === "linked_existing_identity" && secondResult.user.id).toBe(202);
    // Still only ever called once, across both logins.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(second.txObjects.length).toBe(1);
  });
});

describe("resolveGoogleIdentityAttempt - single attempt never catches a duplicate key itself", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a duplicate-key error from linkGoogleIdentity propagates OUT of resolveGoogleIdentityAttempt (and therefore out of database.transaction) rather than being caught and re-read in the same transaction", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    const existingUser = { id: 55, email: "user@example.com" } as any;
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([existingUser]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(duplicateKeyError());
    const getUserByIdSpy = vi.spyOn(db, "getUserById");

    await expect(
      resolveGoogleIdentityAttempt(fakeDb, {
        sub: GOOGLE_INPUT.sub,
        email: GOOGLE_INPUT.email,
        normalizedEmail: GOOGLE_INPUT.email.toLowerCase(),
        name: GOOGLE_INPUT.name,
      })
    ).rejects.toThrow(/duplicate/i);

    // Never re-read getAuthIdentity/getUserById a second time inside this
    // single attempt to "recover" - that recovery is the OUTER retry
    // loop's job now, on a fresh transaction, not this function's.
    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(getUserByIdSpy).not.toHaveBeenCalled();
    expect(txObjects.length).toBe(1);
  });
});

describe("resolveGoogleIdentity - concurrent login retry (blocker fix: no same-transaction re-read under REPEATABLE READ)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[required test 1+2] a duplicate key on attempt 1 rejects attempt 1's transaction, and attempt 2 runs inside a DIFFERENT, brand-new transaction object", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);

    const existingUser = { id: 55, openId: "manus-openid-abc", email: "user@example.com" } as any;
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([existingUser]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity").mockRejectedValueOnce(duplicateKeyError());
    // Attempt 1: no identity yet. Attempt 2 (fresh snapshot): the identity
    // a concurrent winner committed is now visible.
    const getAuthIdentitySpy = vi
      .spyOn(db, "getAuthIdentity")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 9, userId: 55, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue(existingUser);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result.outcome).toBe("linked_existing_identity");
    expect(txObjects.length).toBe(2);
    expect(txObjects[0]).not.toBe(txObjects[1]);
    // getAuthIdentity's two calls used two DIFFERENT tx objects - proof
    // this is genuinely two separate transactions, not one tx read twice.
    expect(getAuthIdentitySpy.mock.calls[0][2]).toBe(txObjects[0]);
    expect(getAuthIdentitySpy.mock.calls[1][2]).toBe(txObjects[1]);
    expect(getAuthIdentitySpy.mock.calls[0][2]).not.toBe(getAuthIdentitySpy.mock.calls[1][2]);
    // linkGoogleIdentity was only ever attempted once (on tx1) - attempt 2
    // took the "identity already exists" branch instead, never retrying
    // the insert itself.
    expect(linkSpy).toHaveBeenCalledTimes(1);
  });

  it("[required test 3] retry succeeds because the new transaction's fresh read sees the identity the losing attempt's own re-read (on the stale snapshot) would have missed", async () => {
    const { fakeDb } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);
    vi.spyOn(db, "createGoogleUserWithIdentity").mockRejectedValueOnce(duplicateKeyError());
    const winner = { id: 300, openId: db.computeGoogleOpenId(GOOGLE_INPUT.sub) } as any;
    vi.spyOn(db, "getAuthIdentity")
      .mockResolvedValueOnce(undefined) // attempt 1: not there yet
      .mockResolvedValueOnce({ id: 4, userId: 300, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any); // attempt 2: fresh snapshot sees the winner
    vi.spyOn(db, "getUserById").mockResolvedValue(winner);

    const result = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(result).toEqual({ outcome: "linked_existing_identity", user: winner });
  });

  it("[required test 4] never retries more than once - a third attempt is never made even if a bug somehow caused two consecutive duplicate-key failures", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([]);
    vi.spyOn(db, "createGoogleUserWithIdentity").mockRejectedValue(duplicateKeyError());

    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/duplicate/i);
    expect(txObjects.length).toBe(2);
  });

  it("[required test 5] a duplicate key on attempt 2 as well -> fails closed: throws, never a successful outcome, never mints a session, never creates a duplicate row", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    const existingUser = { id: 55, email: "user@example.com" } as any;
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([existingUser]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(duplicateKeyError());

    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/duplicate/i);
    expect(txObjects.length).toBe(2);
    expect(linkSpy).toHaveBeenCalledTimes(2);
  });

  it("[required test 6] concurrent logins with the SAME sub both resolve to the same users.id (simulated as two independent resolveGoogleIdentity calls, the second racing into a duplicate the first already committed)", async () => {
    const winner = { id: 77, openId: db.computeGoogleOpenId(GOOGLE_INPUT.sub) } as any;

    // "First" request: succeeds outright, creates the user.
    const first = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(first.fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValueOnce(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValueOnce([]);
    vi.spyOn(db, "createGoogleUserWithIdentity").mockResolvedValueOnce(winner);
    const firstResult = await resolveGoogleIdentity(GOOGLE_INPUT);

    // "Second" (concurrent) request: its own create attempt loses the
    // race (duplicate key on the same computeGoogleOpenId-derived
    // openId), retries, and its retry's fresh read finds the first
    // request's now-committed identity.
    const second = fakeDbWithFreshTransactions();
    vi.spyOn(db, "getDb").mockResolvedValue(second.fakeDb as any);
    vi.spyOn(db, "getAuthIdentity")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 8, userId: 77, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValueOnce([]);
    vi.spyOn(db, "createGoogleUserWithIdentity").mockRejectedValueOnce(duplicateKeyError());
    vi.spyOn(db, "getUserById").mockResolvedValue(winner);
    const secondResult = await resolveGoogleIdentity(GOOGLE_INPUT);

    expect(firstResult.outcome === "created" && firstResult.user.id).toBe(77);
    expect(secondResult.outcome === "linked_existing_identity" && secondResult.user.id).toBe(77);
    // Both requests agree on exactly one users.id - never two different
    // ids for the same Google sub.
    expect(
      (firstResult.outcome === "created" && firstResult.user.id) ===
        (secondResult.outcome === "linked_existing_identity" && secondResult.user.id)
    ).toBe(true);
  });

  it("[required test 7] different subs racing to link the SAME existing user -> the loser fails closed, never logs in, never moves the identity, never picks the first row, never creates a new user to dodge the conflict", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);

    const sharedUser = { id: 900, email: "shared@example.com" } as any;
    // subB never has its own authIdentities row - it genuinely never gets
    // linked, on EITHER attempt, because the conflict (userX already has
    // A DIFFERENT google identity, subA) is real and persistent, not a
    // race that a fresh snapshot resolves.
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([sharedUser]);
    const linkSpy = vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(duplicateKeyError());
    const createSpy = vi.spyOn(db, "createGoogleUserWithIdentity");

    await expect(resolveGoogleIdentity({ ...GOOGLE_INPUT, sub: "sub-B-different-from-sub-A" })).rejects.toThrow(/duplicate/i);

    expect(txObjects.length).toBe(2);
    expect(linkSpy).toHaveBeenCalledTimes(2);
    // Every linkGoogleIdentity attempt targeted the SAME existing user and
    // the SAME (new) providerSubject - never silently switched to a
    // different user, never fell back to creating a fresh account instead.
    for (const call of linkSpy.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 900, providerSubject: "sub-B-different-from-sub-A" });
    }
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("a non-duplicate-key error is never retried - propagates immediately after exactly one attempt", async () => {
    const { fakeDb, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue(undefined);
    vi.spyOn(db, "findUsersByNormalizedEmail").mockResolvedValue([{ id: 1, email: "user@example.com" } as any]);
    vi.spyOn(db, "linkGoogleIdentity").mockRejectedValue(new Error("connection reset"));

    await expect(resolveGoogleIdentity(GOOGLE_INPUT)).rejects.toThrow(/connection reset/);
    expect(txObjects.length).toBe(1);
  });
});

describe("resolveGoogleIdentity - name preservation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("existing name is preserved when Google sends no usable name", async () => {
    const { fakeDb, updateCallsFor, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 7, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue({ id: 7, name: "Existing Name" } as any);

    await resolveGoogleIdentity({ ...GOOGLE_INPUT, name: null });

    expect(updateCallsFor(txObjects[0])[0].set).not.toHaveProperty("name");
  });

  it("a usable Google name overwrites the stored name", async () => {
    const { fakeDb, updateCallsFor, txObjects } = fakeDbWithFreshTransactions();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDb as any);
    vi.spyOn(db, "getAuthIdentity").mockResolvedValue({ id: 1, userId: 7, provider: "google", providerSubject: GOOGLE_INPUT.sub } as any);
    vi.spyOn(db, "getUserById").mockResolvedValue({ id: 7, name: "Old Name" } as any);

    await resolveGoogleIdentity({ ...GOOGLE_INPUT, name: "New Name From Google" });

    expect(updateCallsFor(txObjects[0])[0].set).toHaveProperty("name", "New Name From Google");
  });
});
