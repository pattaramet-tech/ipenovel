import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import {
  AccountRecoveryError,
  assessAccountRecoverySafety,
  executeAccountRecovery,
  reviewAccountRecoveryRequest,
  submitAccountRecoveryRequest,
} from "./accountRecoveryService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

function fakeUser(overrides: Partial<{ id: number; role: "user" | "admin"; email: string | null; openId: string }> = {}) {
  return {
    id: 1,
    openId: "user-1",
    name: "Somchai",
    email: "user@example.com",
    loginMethod: "manus",
    role: "user" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
}

function fakeGoogleIdentity(overrides: Partial<{ id: number; userId: number; providerSubject: string; emailAtLink: string }> = {}) {
  return {
    id: 900,
    userId: 1,
    provider: "google",
    providerSubject: "google-sub-abc",
    emailAtLink: "legacy@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("submitAccountRecoveryRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requester has no real Google identity -> throws NOT_GOOGLE_LINKED, never checks pending or creates a row", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const pendingSpy = vi.spyOn(db, "getPendingAccountRecoveryRequestForUser");
    const createSpy = vi.spyOn(db, "createAccountRecoveryRequest");

    await expect(submitAccountRecoveryRequest({ requesterUserId: 1 })).rejects.toMatchObject({
      code: "NOT_GOOGLE_LINKED",
    });
    expect(pendingSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("requester already has a pending request -> throws ALREADY_PENDING, never creates a second row", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);
    vi.spyOn(db, "getPendingAccountRecoveryRequestForUser").mockResolvedValue({ id: 5 } as any);
    const createSpy = vi.spyOn(db, "createAccountRecoveryRequest");

    await expect(submitAccountRecoveryRequest({ requesterUserId: 1 })).rejects.toMatchObject({
      code: "ALREADY_PENDING",
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("happy path -> creates the request with the requester's own id, never a claimed/typed id", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);
    vi.spyOn(db, "getPendingAccountRecoveryRequestForUser").mockResolvedValue(undefined);
    const createSpy = vi.spyOn(db, "createAccountRecoveryRequest").mockResolvedValue({ id: 10 } as any);

    const result = await submitAccountRecoveryRequest({
      requesterUserId: 1,
      claimedLegacyEmail: "old@example.com",
    });

    expect(result).toEqual({ id: 10 });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: 1, claimedLegacyEmail: "old@example.com" })
    );
  });

  it("a duplicate-key error from the DB-level unique-pending backstop is mapped to the same safe ALREADY_PENDING outcome (concurrent double-submit)", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);
    vi.spyOn(db, "getPendingAccountRecoveryRequestForUser").mockResolvedValue(undefined);
    vi.spyOn(db, "createAccountRecoveryRequest").mockRejectedValue(
      Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 })
    );

    await expect(submitAccountRecoveryRequest({ requesterUserId: 1 })).rejects.toMatchObject({
      code: "ALREADY_PENDING",
    });
  });
});

describe("assessAccountRecoverySafety", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockCleanScenario(overrides: {
    source?: any;
    target?: any;
    sourceIdentity?: any;
    targetIdentity?: any;
    economicFindings?: any[];
    userOwnedFindings?: any[];
  } = {}) {
    const source = "source" in overrides ? overrides.source : fakeUser({ id: 1, role: "user" });
    const target = "target" in overrides ? overrides.target : fakeUser({ id: 2, role: "user" });
    vi.spyOn(db, "getUserById").mockImplementation(async (id: number) => {
      if (id === 1) return source;
      if (id === 2) return target;
      return undefined;
    });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockImplementation(async (userId: number, provider: string) => {
      if (userId === 1) return "sourceIdentity" in overrides ? overrides.sourceIdentity : fakeGoogleIdentity({ userId: 1 });
      if (userId === 2) return "targetIdentity" in overrides ? overrides.targetIdentity : undefined;
      return undefined;
    });
    vi.spyOn(db, "findAccountRecoveryEconomicData").mockResolvedValue(overrides.economicFindings ?? []);
    vi.spyOn(db, "findAccountRecoveryUserOwnedData").mockResolvedValue(overrides.userOwnedFindings ?? []);
  }

  it("[safe empty source] source exists, owns a real Google identity, target exists with no Google identity, no economic/user-owned data -> canApprove true, isFullyAutomatable true", async () => {
    mockCleanScenario();
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(true);
    expect(result.isFullyAutomatable).toBe(true);
    expect(result.blockReasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("source account no longer exists -> blocked", async () => {
    mockCleanScenario({ source: undefined });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.sourceExists).toBe(false);
    expect(result.blockReasons.join(" ")).toMatch(/source account no longer exists/i);
  });

  it("target account no longer exists -> blocked", async () => {
    mockCleanScenario({ target: undefined });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.targetExists).toBe(false);
  });

  it("[source == target] rejected", async () => {
    const same = fakeUser({ id: 1, role: "user" });
    mockCleanScenario({ source: same, target: same });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 1 });
    expect(result.canApprove).toBe(false);
    expect(result.blockReasons.join(" ")).toMatch(/same account/i);
  });

  it("[admin as source] rejected", async () => {
    mockCleanScenario({ source: fakeUser({ id: 1, role: "admin" }) });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.sourceIsAdmin).toBe(true);
  });

  it("[admin as target] rejected", async () => {
    mockCleanScenario({ target: fakeUser({ id: 2, role: "admin" }) });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.targetIsAdmin).toBe(true);
  });

  it("[source identity missing] source has no real Google identity row -> rejected, never trusts a claim as evidence", async () => {
    mockCleanScenario({ sourceIdentity: undefined });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.sourceGoogleIdentity).toBeNull();
  });

  it("[target already has Google identity] rejected", async () => {
    mockCleanScenario({ targetIdentity: fakeGoogleIdentity({ userId: 2, id: 901 }) });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.targetHasGoogleIdentity).toBe(true);
  });

  it("[source with purchase] economic data present -> hard blocked, never just a warning", async () => {
    mockCleanScenario({ economicFindings: [{ table: "purchases", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.blockReasons.join(" ")).toMatch(/economic\/entitlement data/i);
  });

  it("[source with wallet balance/points] economic data present -> blocked", async () => {
    mockCleanScenario({ economicFindings: [{ table: "walletAccounts", count: 1 }, { table: "pointsTransactions", count: 3 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("[source with order/payment] economic data present -> blocked", async () => {
    mockCleanScenario({ economicFindings: [{ table: "orders", count: 2 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  // ---- Empty-source-account invariant: user-owned data is now an
  // unconditional block, exactly like economic data - "Automated Recovery
  // ต้องอนุมัติได้เฉพาะ Source Account ที่ว่างจริงเท่านั้น". Every one of
  // these used to be warnings-only/still-approvable before this fix.

  it("[source with cart] user-owned data present -> hard blocked, never just a warning", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "carts", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.isFullyAutomatable).toBe(false);
    expect(result.blockReasons.join(" ")).toMatch(/user-owned data/i);
  });

  it("[source with wishlist/library] user-owned data present -> hard blocked", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "wishlists", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("[source with reading progress] user-owned data present -> hard blocked", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "readingProgress", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("[source with a check-in] user-owned data present -> hard blocked", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "dailyCheckins", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("[source with an unrelated other user-owned table finding] still hard blocked - the gate is 'any finding at all', not a table allowlist", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "someFutureUserOwnedTable", count: 5 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("warnings are still populated for admin-UI detail display, but never as the sole gate - canApprove is authoritative and false whenever warnings are non-empty for a data-finding reason", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "carts", count: 1 }] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.canApprove).toBe(false);
  });

  it("[admin cannot override] executeAccountRecovery has no override parameter at all - a non-empty source is UNSAFE inside the transaction regardless of what the admin submits", async () => {
    mockCleanScenario({ userOwnedFindings: [{ table: "carts", count: 1 }] });
    // executeAccountRecovery's params type is { requestId, targetUserId,
    // adminId, reason } - there is no `force`/`override`/`skipSafetyCheck`
    // field an admin could set even if they wanted to; this is enforced by
    // TypeScript at the call site and, at runtime, by
    // assessAccountRecoverySafety being re-run unconditionally inside the
    // transaction (see the executeAccountRecovery describe block below for
    // the full transactional proof).
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
  });

  it("[only a genuinely empty source can be approved] zero economic AND zero user-owned findings -> canApprove true, isFullyAutomatable true", async () => {
    mockCleanScenario({ economicFindings: [], userOwnedFindings: [] });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(true);
    expect(result.isFullyAutomatable).toBe(true);
  });

  it("[not empty in either category] a source with BOTH an economic finding AND a user-owned finding -> still just one blocked outcome, both reasons reported", async () => {
    mockCleanScenario({
      economicFindings: [{ table: "orders", count: 1 }],
      userOwnedFindings: [{ table: "carts", count: 1 }],
    });
    const result = await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(result.canApprove).toBe(false);
    expect(result.blockReasons.length).toBeGreaterThanOrEqual(2);
    expect(result.blockReasons.some((r) => /economic/i.test(r))).toBe(true);
    expect(result.blockReasons.some((r) => /user-owned/i.test(r))).toBe(true);
  });

  it("never reads the recovery request's own claimed fields (email/openId/legacyUserId) as evidence - only real DB rows via getUserById/getAuthIdentityByUserAndProvider", async () => {
    mockCleanScenario();
    const requestLookupSpy = vi.spyOn(db, "getAccountRecoveryRequestById");
    await assessAccountRecoverySafety({ requestId: 1, sourceUserId: 1, targetUserId: 2 });
    expect(requestLookupSpy).not.toHaveBeenCalled();
  });
});

describe("reviewAccountRecoveryRequest (reject/block/cancel)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("empty reason -> throws FORBIDDEN, never touches the database", async () => {
    const dbSpy = vi.spyOn(db, "getDb");
    await expect(
      reviewAccountRecoveryRequest({ requestId: 1, action: "reject", actorAdminId: 9, reason: "  " })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("request already processed (conditional UPDATE affected 0 rows) -> ALREADY_PROCESSED, never writes an audit log", async () => {
    const fakeTx = {};
    vi.spyOn(db, "getDb").mockResolvedValue({ transaction: async (cb: any) => cb(fakeTx) } as any);
    vi.spyOn(db, "transitionAccountRecoveryRequestStatus").mockResolvedValue(false);
    const auditSpy = vi.spyOn(db, "insertAccountRecoveryAuditLog").mockResolvedValue(undefined as any);

    await expect(
      reviewAccountRecoveryRequest({ requestId: 1, action: "block", actorAdminId: 9, reason: "policy" })
    ).rejects.toMatchObject({ code: "ALREADY_PROCESSED" });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("happy path (reject) -> writes an audit log with action='rejected' and returns the updated request", async () => {
    const fakeTx = {};
    vi.spyOn(db, "getDb").mockResolvedValue({ transaction: async (cb: any) => cb(fakeTx) } as any);
    vi.spyOn(db, "transitionAccountRecoveryRequestStatus").mockResolvedValue(true);
    const auditSpy = vi.spyOn(db, "insertAccountRecoveryAuditLog").mockResolvedValue(undefined as any);
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({ id: 1, status: "rejected" } as any);

    const result = await reviewAccountRecoveryRequest({
      requestId: 1,
      action: "reject",
      actorAdminId: 9,
      reason: "not enough evidence",
    });

    expect(result).toEqual({ id: 1, status: "rejected" });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryRequestId: 1, actorAdminId: 9, action: "rejected" }),
      fakeTx
    );
  });
});

describe("executeAccountRecovery", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Fakes the FOR-UPDATE locking reads (request/user/identity) by call
   *  order - see this function's docstring for why call order (not SQL
   *  parsing) is sufficient here: every db.* read that actually informs a
   *  decision is separately mocked via vi.spyOn below, this fake only
   *  needs to hand back plausible raw rows for the 3 raw tx.execute calls
   *  executeAccountRecovery itself issues. */
  function fakeDatabase(params: { requestRow: any; identityRow: any | null; userLockCount?: number }) {
    let callCount = 0;
    const userLockCount = params.userLockCount ?? 2;
    const tx = {
      execute: async (_query: any) => {
        callCount++;
        if (callCount === 1) return [[params.requestRow]];
        if (callCount <= 1 + userLockCount) return [[]];
        return [params.identityRow ? [params.identityRow] : []];
      },
    };
    return { transaction: async (cb: (tx: any) => Promise<any>) => cb(tx), __tx: tx };
  }

  function mockSafeAssessment(overrides: { identity?: any } = {}) {
    const identity = overrides.identity !== undefined ? overrides.identity : fakeGoogleIdentity({ userId: 1, id: 900 });
    vi.spyOn(db, "getUserById").mockImplementation(async (id: number) => (id === 1 ? fakeUser({ id: 1 }) : fakeUser({ id: 2 })));
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockImplementation(async (userId: number) =>
      userId === 1 ? identity : undefined
    );
    vi.spyOn(db, "findAccountRecoveryEconomicData").mockResolvedValue([]);
    vi.spyOn(db, "findAccountRecoveryUserOwnedData").mockResolvedValue([]);
    return identity;
  }

  it("reason required -> throws FORBIDDEN before ever touching the database", async () => {
    const dbSpy = vi.spyOn(db, "getDb");
    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("request not found -> NOT_FOUND", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase({ requestRow: undefined, identityRow: null }) as any);

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("[duplicate approval] request status is already 'approved' by the time it's locked -> ALREADY_PROCESSED, never moves anything", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "approved", requesterUserId: 1 }, identityRow: null }) as any
    );
    const moveSpy = vi.spyOn(db, "moveAuthIdentityOwner");

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "ALREADY_PROCESSED" });
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it("[source with purchase] unsafe assessment (economic data found) -> UNSAFE, never moves the identity, never finalizes the target", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment();
    vi.spyOn(db, "findAccountRecoveryEconomicData").mockResolvedValue([{ table: "purchases", count: 1 }]);
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    const moveSpy = vi.spyOn(db, "moveAuthIdentityOwner");
    const finalizeSpy = vi.spyOn(db, "finalizeAccountRecoveryTargetUser");

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "UNSAFE" });
    expect(moveSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it("[empty-source-account invariant, re-checked inside the transaction] source has user-owned data (cart) -> UNSAFE, never moves the identity, never finalizes the target, and no reason/force parameter exists to override it", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment();
    vi.spyOn(db, "findAccountRecoveryUserOwnedData").mockResolvedValue([{ table: "carts", count: 1 }]);
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    const moveSpy = vi.spyOn(db, "moveAuthIdentityOwner");
    const finalizeSpy = vi.spyOn(db, "finalizeAccountRecoveryTargetUser");
    const transitionSpy = vi.spyOn(db, "transitionAccountRecoveryRequestStatus");

    await expect(
      // Note: no override/force field exists on this input type at all -
      // TypeScript itself would reject one; this call uses every field the
      // API actually accepts.
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "admin insists it's fine" })
    ).rejects.toMatchObject({ code: "UNSAFE" });
    expect(moveSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("[source identity belongs to another user / changed mid-flight] the locked identity row disagrees with the assessment's own read -> UNSAFE, never moves anything", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    // Assessment sees identity id 900, but the locked raw read returns a
    // DIFFERENT row (id 999) - simulates the identity having changed
    // between the assessment's read and the lock (or a bug trying to move
    // the wrong row) - must fail closed either way.
    mockSafeAssessment({ identity: fakeGoogleIdentity({ userId: 1, id: 900 }) });
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({
        requestRow: { id: 1, status: "pending", requesterUserId: 1 },
        identityRow: fakeGoogleIdentity({ userId: 1, id: 999 }),
      }) as any
    );
    const moveSpy = vi.spyOn(db, "moveAuthIdentityOwner");

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "UNSAFE" });
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it("moveAuthIdentityOwner loses the race (returns false) -> CONFLICT, never finalizes the target or marks approved", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment();
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    vi.spyOn(db, "moveAuthIdentityOwner").mockResolvedValue(false);
    const finalizeSpy = vi.spyOn(db, "finalizeAccountRecoveryTargetUser");
    const transitionSpy = vi.spyOn(db, "transitionAccountRecoveryRequestStatus");

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("[concurrent approvals] the final conditional status transition loses the race (returns false) -> ALREADY_PROCESSED, even though the identity move itself already happened in THIS attempt", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment();
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    vi.spyOn(db, "moveAuthIdentityOwner").mockResolvedValue(true);
    vi.spyOn(db, "finalizeAccountRecoveryTargetUser").mockResolvedValue(undefined as any);
    vi.spyOn(db, "transitionAccountRecoveryRequestStatus").mockResolvedValue(false);
    const auditSpy = vi.spyOn(db, "insertAccountRecoveryAuditLog");

    await expect(
      executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })
    ).rejects.toMatchObject({ code: "ALREADY_PROCESSED" });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("[rollback on injected failure] insertAccountRecoveryAuditLog throws -> the whole call rejects, and the function never reaches its final read (proves nothing after the failure point ran)", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment();
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    vi.spyOn(db, "moveAuthIdentityOwner").mockResolvedValue(true);
    vi.spyOn(db, "finalizeAccountRecoveryTargetUser").mockResolvedValue(undefined as any);
    vi.spyOn(db, "transitionAccountRecoveryRequestStatus").mockResolvedValue(true);
    vi.spyOn(db, "insertAccountRecoveryAuditLog").mockRejectedValue(new Error("injected failure"));
    const finalReadSpy = vi.spyOn(db, "getAccountRecoveryRequestById");

    await expect(executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "ok" })).rejects.toThrow(
      "injected failure"
    );
    expect(finalReadSpy).not.toHaveBeenCalled();
  });

  it("[happy path] moves the identity exactly once, finalizes the target without touching id/openId, marks approved, and writes an audit log that never contains the Google sub", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const identity = mockSafeAssessment({ identity: fakeGoogleIdentity({ userId: 1, id: 900, providerSubject: "super-secret-google-sub" }) });
    vi.spyOn(db, "getDb").mockResolvedValue(
      fakeDatabase({ requestRow: { id: 1, status: "pending", requesterUserId: 1 }, identityRow: identity }) as any
    );
    const moveSpy = vi.spyOn(db, "moveAuthIdentityOwner").mockResolvedValue(true);
    const finalizeSpy = vi.spyOn(db, "finalizeAccountRecoveryTargetUser").mockResolvedValue(undefined as any);
    const transitionSpy = vi.spyOn(db, "transitionAccountRecoveryRequestStatus").mockResolvedValue(true);
    const auditSpy = vi.spyOn(db, "insertAccountRecoveryAuditLog").mockResolvedValue(undefined as any);
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({ id: 1, status: "approved" } as any);

    const result = await executeAccountRecovery({ requestId: 1, targetUserId: 2, adminId: 9, reason: "verified via order #123" });

    expect(result.request).toEqual({ id: 1, status: "approved" });
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ authIdentityId: 900, expectedCurrentUserId: 1, targetUserId: 2 }),
      expect.anything()
    );
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: 2 }),
      expect.anything()
    );
    // finalizeAccountRecoveryTargetUser is never even PASSED a users.id or
    // openId override field - the only fields it accepts are targetUserId
    // and fallbackEmail (see accountRecoveryService.ts/db.ts), which is
    // what structurally guarantees id/openId are preserved.
    const finalizeArgs = finalizeSpy.mock.calls[0][0];
    expect(Object.keys(finalizeArgs).sort()).toEqual(["fallbackEmail", "targetUserId"]);

    expect(transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, toStatus: "approved", sourceUserId: 1, targetUserId: 2 }),
      expect.anything()
    );

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const auditArgs = auditSpy.mock.calls[0][0];
    expect(auditArgs.action).toBe("approved");
    expect(auditArgs.authIdentityId).toBe(900);
    expect(JSON.stringify(auditArgs.safeMetadata)).not.toMatch(/super-secret-google-sub/);
  });
});
