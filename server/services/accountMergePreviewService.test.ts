import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import {
  buildAccountMergePreview,
  validateAccountMergeTarget,
} from "./accountMergePreviewService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

function fakeUser(overrides: Partial<{ id: number; role: "user" | "admin" }> = {}) {
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

function fakeGoogleIdentity(overrides: Partial<{ userId: number }> = {}) {
  return {
    id: 900,
    userId: overrides.userId ?? 1,
    provider: "google",
    providerSubject: "google-sub-abc",
    emailAtLink: "legacy@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const SOURCE_ID = 10;
const TARGET_ID = 20;

/** Mocks a fully-valid pairing: distinct, both non-admin, source has a
 *  Google identity, target has none. Individual tests override one field
 *  to exercise a specific blocker. */
function mockValidPairing() {
  vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) => {
    if (userId === SOURCE_ID) return fakeUser({ id: SOURCE_ID, role: "user" }) as any;
    if (userId === TARGET_ID) return fakeUser({ id: TARGET_ID, role: "user" }) as any;
    return undefined;
  });
  vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockImplementation(async (userId: number) => {
    if (userId === SOURCE_ID) return fakeGoogleIdentity({ userId: SOURCE_ID }) as any;
    return undefined;
  });
}

describe("validateAccountMergeTarget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("B. a fully valid pairing has zero blockers and isValid=true", async () => {
    mockValidPairing();
    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.blockers).toEqual([]);
    expect(result.isValid).toBe(true);
    expect(result.distinctAccounts).toBe(true);
  });

  it("B. source and target are the SAME account -> blocked, distinctAccounts=false", async () => {
    vi.spyOn(db, "getUserById").mockResolvedValue(fakeUser({ id: SOURCE_ID }) as any);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);

    const result = await validateAccountMergeTarget(SOURCE_ID, SOURCE_ID);
    expect(result.distinctAccounts).toBe(false);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Source and target are the same account");
  });

  it("B. source does not exist -> blocked, never crashes on a missing row", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) =>
      userId === TARGET_ID ? (fakeUser({ id: TARGET_ID }) as any) : undefined
    );
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.sourceExists).toBe(false);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Source account no longer exists");
  });

  it("B. target does not exist -> blocked", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? (fakeUser({ id: SOURCE_ID }) as any) : undefined
    );
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.targetExists).toBe(false);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Target account no longer exists");
  });

  it("B. source is an admin -> blocked, never a merge source", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) => {
      if (userId === SOURCE_ID) return fakeUser({ id: SOURCE_ID, role: "admin" }) as any;
      if (userId === TARGET_ID) return fakeUser({ id: TARGET_ID, role: "user" }) as any;
      return undefined;
    });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.sourceIsAdmin).toBe(true);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Source account is an admin account - never a merge source");
  });

  it("B. target is an admin -> blocked, never a merge target", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) => {
      if (userId === SOURCE_ID) return fakeUser({ id: SOURCE_ID, role: "user" }) as any;
      if (userId === TARGET_ID) return fakeUser({ id: TARGET_ID, role: "admin" }) as any;
      return undefined;
    });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.targetIsAdmin).toBe(true);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Target account is an admin account - never a merge target");
  });

  it("B. source has NO Google identity -> blocked, cannot verify ownership", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? (fakeUser({ id: SOURCE_ID }) as any) : (fakeUser({ id: TARGET_ID }) as any)
    );
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.sourceHasGoogleIdentity).toBe(false);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Source account has no linked Google identity - cannot verify ownership");
  });

  it("B. target ALREADY has a Google identity -> blocked", async () => {
    vi.spyOn(db, "getUserById").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? (fakeUser({ id: SOURCE_ID }) as any) : (fakeUser({ id: TARGET_ID }) as any)
    );
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? (fakeGoogleIdentity({ userId: SOURCE_ID }) as any) : (fakeGoogleIdentity({ userId: TARGET_ID }) as any)
    );

    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result.targetHasGoogleIdentity).toBe(true);
    expect(result.isValid).toBe(false);
    expect(result.blockers).toContain("Target account already has a linked Google identity");
  });

  it("B. NEVER exposes the raw Google identity (providerSubject/emailAtLink) - booleans only", async () => {
    mockValidPairing();
    const result = await validateAccountMergeTarget(SOURCE_ID, TARGET_ID);
    expect(result).not.toHaveProperty("sourceGoogleIdentity");
    expect(JSON.stringify(result)).not.toContain("google-sub-abc");
    expect(JSON.stringify(result)).not.toContain("legacy@example.com");
  });
});

describe("buildAccountMergePreview - A) source is always server-derived", () => {
  afterEach(() => vi.restoreAllMocks());

  it("A. sourceUserId passed in is used verbatim for every downstream lookup - proving the CALLER (the router) is what pins it to requesterUserId, never this function accepting a substitute", async () => {
    mockValidPairing();
    const inventorySpy = vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(0);

    const preview = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });

    expect(preview.sourceUserId).toBe(SOURCE_ID);
    expect(inventorySpy).toHaveBeenCalledWith(SOURCE_ID, TARGET_ID);
  });
});

describe("buildAccountMergePreview - C) zero mutation, invalid pairing stops before any inventory/projection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("C. an invalid pairing (same account) never calls the inventory/projection/claims functions at all", async () => {
    vi.spyOn(db, "getUserById").mockResolvedValue(fakeUser({ id: SOURCE_ID }) as any);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(fakeGoogleIdentity() as any);
    const inventorySpy = vi.spyOn(db, "findAccountMergeTableInventory");
    const walletSpy = vi.spyOn(db, "getAccountMergeWalletBalance");
    const pointsSpy = vi.spyOn(db, "getAccountMergePointsBalance");
    const claimsSpy = vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount");

    const preview = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: SOURCE_ID });

    expect(preview.isPreviewValid).toBe(false);
    expect(preview.tableFindings).toEqual([]);
    expect(preview.walletProjection).toEqual({ sourceBalance: "0.00", targetBalance: "0.00", projectedMergedBalance: "0.00" });
    expect(preview.pointsProjection).toEqual({ sourceBalance: "0.00", targetBalance: "0.00", projectedMergedBalance: "0.00" });
    expect(preview.paymentSlipClaims.sourceCount).toBe(0);
    expect(preview.hardBlockers).toEqual(preview.targetValidation.blockers);
    expect(inventorySpy).not.toHaveBeenCalled();
    expect(walletSpy).not.toHaveBeenCalled();
    expect(pointsSpy).not.toHaveBeenCalled();
    expect(claimsSpy).not.toHaveBeenCalled();
  });

  it("C. every db function this service can reach is read-only - insert/update/delete/transaction are never called for a valid preview", async () => {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([
      { table: "orders", category: "economic", sourceCount: 2, targetCount: 0, conflictCount: 0 },
    ]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("100.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("5.00");
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(2);

    // Every mutation-shaped export in db.ts, spied so a call would be
    // recorded - none should ever fire from a preview.
    const mutationSpies = [
      vi.spyOn(db, "createAccountRecoveryRequest"),
      vi.spyOn(db, "transitionAccountRecoveryRequestStatus"),
      vi.spyOn(db, "insertAccountRecoveryAuditLog"),
      vi.spyOn(db, "moveAuthIdentityOwner"),
      vi.spyOn(db, "finalizeAccountRecoveryTargetUser"),
    ];

    await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });

    for (const spy of mutationSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("C. calling the preview twice in a row returns byte-identical results (safe to call repeatedly)", async () => {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([
      { table: "wishlists", category: "user_owned", sourceCount: 3, targetCount: 1, conflictCount: 1 },
    ]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("10.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(1);

    const first = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });
    const second = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });
    expect(second).toEqual(first);
  });
});

describe("buildAccountMergePreview - E) exact wallet/points projections, data only", () => {
  afterEach(() => vi.restoreAllMocks());

  it("E. sums source + target balances exactly via moneyAdd, never floating-point drift", async () => {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? "123.45" : "0.10"
    );
    vi.spyOn(db, "getAccountMergePointsBalance").mockImplementation(async (userId: number) =>
      userId === SOURCE_ID ? "10.00" : "5.50"
    );
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(0);

    const preview = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });

    expect(preview.walletProjection).toEqual({
      sourceBalance: "123.45",
      targetBalance: "0.10",
      projectedMergedBalance: "123.55",
    });
    expect(preview.pointsProjection).toEqual({
      sourceBalance: "10.00",
      targetBalance: "5.50",
      projectedMergedBalance: "15.50",
    });
  });

  it("E. zero balances on both sides project to an exact 0.00, never null/undefined/NaN", async () => {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(0);

    const preview = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });
    expect(preview.walletProjection.projectedMergedBalance).toBe("0.00");
    expect(preview.pointsProjection.projectedMergedBalance).toBe("0.00");
  });
});

describe("buildAccountMergePreview - D) table findings: projected action, conflicts, hard blockers", () => {
  afterEach(() => vi.restoreAllMocks());

  async function previewWith(findings: db.AccountMergeTableInventoryFinding[]) {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue(findings);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(0);
    return buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });
  }

  it("D. zero source rows -> no_action, no warning", async () => {
    const preview = await previewWith([
      { table: "carts", category: "user_owned", sourceCount: 0, targetCount: 0, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("no_action");
    expect(preview.tableFindings[0].warnings).toEqual([]);
    expect(preview.hardBlockers).toEqual([]);
  });

  it("D. plain ledger table (orders) with source rows, no conflict possible -> transfer_only", async () => {
    const preview = await previewWith([
      { table: "orders", category: "economic", sourceCount: 5, targetCount: 3, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("transfer_only");
    expect(preview.tableFindings[0].warnings).toEqual([]);
  });

  it("D. singleton table (walletAccounts) with ONLY source having a row -> transfer_only, not consolidate", async () => {
    const preview = await previewWith([
      { table: "walletAccounts", category: "economic", sourceCount: 1, targetCount: 0, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("transfer_only");
  });

  it("D. singleton table (walletAccounts) with BOTH sides having a row (conflictCount=1) -> consolidate_singleton + hard blocker", async () => {
    const preview = await previewWith([
      { table: "walletAccounts", category: "economic", sourceCount: 1, targetCount: 1, conflictCount: 1 },
    ]);
    const finding = preview.tableFindings[0];
    expect(finding.projectedAction).toBe("consolidate_singleton");
    expect(finding.warnings).toEqual([
      "walletAccounts: both accounts already have their own row - requires explicit consolidation, not a plain transfer",
    ]);
    expect(preview.hardBlockers).toEqual(finding.warnings);
  });

  it("D. carts (also singleton) behaves identically to walletAccounts when both sides collide", async () => {
    const preview = await previewWith([
      { table: "carts", category: "user_owned", sourceCount: 1, targetCount: 1, conflictCount: 1 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("consolidate_singleton");
  });

  it("D. dedupe-keyed table (wishlists) with a nonzero conflictCount -> transfer_with_dedupe + hard blocker naming the count", async () => {
    const preview = await previewWith([
      { table: "wishlists", category: "user_owned", sourceCount: 10, targetCount: 4, conflictCount: 3 },
    ]);
    const finding = preview.tableFindings[0];
    expect(finding.projectedAction).toBe("transfer_with_dedupe");
    expect(finding.warnings).toEqual([
      "wishlists: 3 row(s) collide with data the target already owns and cannot be transferred as-is",
    ]);
  });

  it("D. dedupe-keyed table with conflictCount=0 -> transfer_only even though the table CAN have conflicts in general", async () => {
    const preview = await previewWith([
      { table: "purchases", category: "economic", sourceCount: 7, targetCount: 2, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("transfer_only");
    expect(preview.tableFindings[0].warnings).toEqual([]);
  });

  it("D. every tableFindings row is echoed EXACTLY (sourceCount/targetCount/conflictCount/category) from what db.ts returned", async () => {
    const preview = await previewWith([
      { table: "pointsTransactions", category: "economic", sourceCount: 42, targetCount: 7, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0]).toMatchObject({
      table: "pointsTransactions",
      category: "economic",
      sourceCount: 42,
      targetCount: 7,
      conflictCount: 0,
    });
  });

  it("D. hardBlockers aggregates warnings across MULTIPLE conflicting tables, not just the first", async () => {
    const preview = await previewWith([
      { table: "walletAccounts", category: "economic", sourceCount: 1, targetCount: 1, conflictCount: 1 },
      { table: "wishlists", category: "user_owned", sourceCount: 5, targetCount: 2, conflictCount: 2 },
      { table: "orders", category: "economic", sourceCount: 3, targetCount: 0, conflictCount: 0 },
    ]);
    expect(preview.hardBlockers).toHaveLength(2);
    expect(preview.hardBlockers.some((w) => w.startsWith("walletAccounts:"))).toBe(true);
    expect(preview.hardBlockers.some((w) => w.startsWith("wishlists:"))).toBe(true);
  });

  it("D/isPreviewValid: a valid pairing with hard blockers is STILL isPreviewValid=true - conflicts are informational content, not an error", async () => {
    const preview = await previewWith([
      { table: "walletAccounts", category: "economic", sourceCount: 1, targetCount: 1, conflictCount: 1 },
    ]);
    expect(preview.isPreviewValid).toBe(true);
    expect(preview.hardBlockers.length).toBeGreaterThan(0);
  });

  // ---- Indirect (no-direct-userId-column) action semantics - P2-2 ----
  // A later phase can never re-parent these tables by userId (there is no
  // such column), so labelling them "transfer_only" (which specifically
  // means a direct userId re-parent) is dishonest. They must project
  // "preserve_via_parent" instead.

  it("D. indirect_economic table (orderItems) with source rows -> preserve_via_parent, NOT transfer_only, no warning", async () => {
    const preview = await previewWith([
      { table: "orderItems", category: "indirect_economic", sourceCount: 12, targetCount: 4, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("preserve_via_parent");
    expect(preview.tableFindings[0].warnings).toEqual([]);
    expect(preview.hardBlockers).toEqual([]);
  });

  it("D. indirect_economic table (orderHistory) - the P2-2 gap table - projects preserve_via_parent", async () => {
    const preview = await previewWith([
      { table: "orderHistory", category: "indirect_economic", sourceCount: 30, targetCount: 9, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("preserve_via_parent");
  });

  it("D. indirect_user_owned table (cartItems) with source rows -> preserve_via_parent", async () => {
    const preview = await previewWith([
      { table: "cartItems", category: "indirect_user_owned", sourceCount: 3, targetCount: 1, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("preserve_via_parent");
  });

  it("D. an indirect table with zero source rows still projects no_action (nothing to preserve)", async () => {
    const preview = await previewWith([
      { table: "orderHistory", category: "indirect_economic", sourceCount: 0, targetCount: 5, conflictCount: 0 },
    ]);
    expect(preview.tableFindings[0].projectedAction).toBe("no_action");
  });

  it("D. an indirect table is NEVER labelled a direct transfer/dedupe/consolidate action, even if a conflictCount somehow arrived", async () => {
    // conflictCount is always 0 for indirect tables in practice (db.ts never
    // computes one) - this asserts the derivation itself never downgrades an
    // indirect row into a direct-re-parent action regardless.
    const preview = await previewWith([
      { table: "payments", category: "indirect_economic", sourceCount: 8, targetCount: 8, conflictCount: 2 },
    ]);
    const action = preview.tableFindings[0].projectedAction;
    expect(action).toBe("preserve_via_parent");
    expect(["transfer_only", "transfer_with_dedupe", "consolidate_singleton"]).not.toContain(action);
  });

  it("D. NEGATIVE/REVERT PROOF: a DIRECT table (orders) with the SAME counts as the indirect case still projects transfer_only - the discriminator is the category, not the numbers", async () => {
    const indirect = await previewWith([
      { table: "orderItems", category: "indirect_economic", sourceCount: 12, targetCount: 4, conflictCount: 0 },
    ]);
    const direct = await previewWith([
      { table: "orders", category: "economic", sourceCount: 12, targetCount: 4, conflictCount: 0 },
    ]);
    expect(indirect.tableFindings[0].projectedAction).toBe("preserve_via_parent");
    expect(direct.tableFindings[0].projectedAction).toBe("transfer_only");
    // Same raw counts, different honest action - proves the category flips it.
    expect(indirect.tableFindings[0].projectedAction).not.toBe(direct.tableFindings[0].projectedAction);
  });

  it("D. a mixed inventory: direct rows keep their direct actions, indirect rows all read preserve_via_parent", async () => {
    const preview = await previewWith([
      { table: "orders", category: "economic", sourceCount: 5, targetCount: 0, conflictCount: 0 },
      { table: "walletAccounts", category: "economic", sourceCount: 1, targetCount: 1, conflictCount: 1 },
      { table: "wishlists", category: "user_owned", sourceCount: 6, targetCount: 3, conflictCount: 2 },
      { table: "orderItems", category: "indirect_economic", sourceCount: 9, targetCount: 0, conflictCount: 0 },
      { table: "payments", category: "indirect_economic", sourceCount: 4, targetCount: 0, conflictCount: 0 },
      { table: "orderHistory", category: "indirect_economic", sourceCount: 11, targetCount: 0, conflictCount: 0 },
      { table: "cartItems", category: "indirect_user_owned", sourceCount: 2, targetCount: 0, conflictCount: 0 },
    ]);
    const byTable = Object.fromEntries(preview.tableFindings.map((f) => [f.table, f.projectedAction]));
    expect(byTable.orders).toBe("transfer_only");
    expect(byTable.walletAccounts).toBe("consolidate_singleton");
    expect(byTable.wishlists).toBe("transfer_with_dedupe");
    expect(byTable.orderItems).toBe("preserve_via_parent");
    expect(byTable.payments).toBe("preserve_via_parent");
    expect(byTable.orderHistory).toBe("preserve_via_parent");
    expect(byTable.cartItems).toBe("preserve_via_parent");
    // Indirect rows contribute nothing to hardBlockers.
    expect(preview.hardBlockers.every((w) => w.startsWith("walletAccounts:") || w.startsWith("wishlists:"))).toBe(true);
  });
});

describe("buildAccountMergePreview - G) paymentSlipClaims/OCR anti-replay evidence is read-only", () => {
  afterEach(() => vi.restoreAllMocks());

  it("G. returns the exact source count from db.ts's read-only claims query and an explanatory note - never a write call", async () => {
    mockValidPairing();
    vi.spyOn(db, "findAccountMergeTableInventory").mockResolvedValue([]);
    vi.spyOn(db, "getAccountMergeWalletBalance").mockResolvedValue("0.00");
    vi.spyOn(db, "getAccountMergePointsBalance").mockResolvedValue("0.00");
    const claimsSpy = vi.spyOn(db, "getAccountMergePaymentSlipClaimsCount").mockResolvedValue(4);

    const preview = await buildAccountMergePreview({ requestId: 1, sourceUserId: SOURCE_ID, targetUserId: TARGET_ID });

    expect(claimsSpy).toHaveBeenCalledWith(SOURCE_ID);
    expect(preview.paymentSlipClaims.sourceCount).toBe(4);
    expect(preview.paymentSlipClaims.note.length).toBeGreaterThan(10);
  });
});
