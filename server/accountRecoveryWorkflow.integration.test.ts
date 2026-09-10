import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestUser, createTestOrder, uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";
import { authIdentities, accountRecoveryRequests, accountRecoveryAuditLogs, users, carts } from "../drizzle/schema";
import * as db from "./db";
import { isDuplicateKeyError } from "./helpers/databaseErrorClassifier";
import {
  AccountRecoveryError,
  assessAccountRecoverySafety,
  executeAccountRecovery,
  reviewAccountRecoveryRequest,
  submitAccountRecoveryRequest,
} from "./services/accountRecoveryService";

/**
 * Real-database coverage for the Admin Account Recovery workflow (Part B) -
 * exercises the actual MySQL/MariaDB unique constraints
 * (authIdentities_userId_provider_unique,
 * accountRecoveryRequests_one_pending_per_requester_unique) and the real
 * transactional approve flow (server/services/accountRecoveryService.ts's
 * executeAccountRecovery) against TEST_DATABASE_URL, never DATABASE_URL -
 * see docs/TEST_INFRASTRUCTURE.md. Safe to mix db.ts's functions with
 * getTestDb()/fixtures.ts in this file specifically because this is a
 * *.integration.test.ts file (vitest.integration.globalsetup.ts /
 * vitest.integration.setupfile.ts point both at the same TEST_DATABASE_URL
 * connection for the duration of this project's run).
 *
 * This file deliberately does NOT use `describe.skipIf(!process.env.
 * TEST_DATABASE_URL)` - that pattern makes every test in the file report
 * as SKIPPED (not failed) when misconfigured, which reads as "nothing to
 * see here" instead of "this suite could not run". The beforeAll guard
 * below re-validates TEST_DATABASE_URL itself, independently of
 * vitest.integration.globalsetup.ts, and THROWS (never skips) on every
 * unsafe case: missing entirely, unparseable, a database name that isn't
 * exactly "ipenovel_test", or a name that merely LOOKS test-like but is
 * actually production-shaped - and separately re-runs the live "SELECT
 * DATABASE()" check (never trusts the URL string alone). This is
 * deliberate defense-in-depth, not a substitute for the project-level
 * guards - even if this file is ever collected by a differently-configured
 * vitest invocation that bypasses globalSetup entirely, it still fails
 * loudly on its own rather than silently skipping or, worse, silently
 * running against whatever `getDb()` happens to resolve to.
 */

/** No fixtures.ts factory exists for authIdentities - a small local raw
 *  insert, matching the established local-helper pattern from
 *  couponOwnership.integration.test.ts's createSportsRewardCoupon. */
async function linkTestGoogleIdentity(userId: number, emailAtLink: string) {
  const testDb = getTestDb();
  const providerSubject = `google-sub-${uniqueTestTag()}`;
  const result: any = await testDb.insert(authIdentities).values({
    userId,
    provider: "google",
    providerSubject,
    emailAtLink,
  });
  const id = result?.[0]?.insertId ?? result?.insertId;
  return { id, providerSubject };
}

async function cleanupRecoveryRequests(requestIds: number[]) {
  if (requestIds.length === 0) return;
  const testDb = getTestDb();
  // accountRecoveryAuditLogs cascades via FK ON DELETE CASCADE - deleting
  // the request is sufficient to also remove its audit trail.
  await Promise.all(requestIds.map((id) => testDb.delete(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, id))));
}

async function cleanupAuthIdentities(identityIds: number[]) {
  if (identityIds.length === 0) return;
  const testDb = getTestDb();
  await Promise.all(identityIds.map((id) => testDb.delete(authIdentities).where(eq(authIdentities.id, id))));
}

async function cleanupCarts(cartIds: number[]) {
  if (cartIds.length === 0) return;
  const testDb = getTestDb();
  await Promise.all(cartIds.map((id) => testDb.delete(carts).where(eq(carts.id, id))));
}

describe("Admin Account Recovery - real database", () => {
  // Fails loudly - never skips - the moment this describe block runs, well
  // before any fixture/test body executes. See this file's top-of-file
  // docstring for why this exists in addition to (not instead of)
  // vitest.integration.globalsetup.ts's own, earlier-running guard.
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(getTestDb());
  });

  const createdRequestIds: number[] = [];
  const createdIdentityIds: number[] = [];
  const createdUserIds: number[] = [];
  const createdOrderIds: number[] = [];
  const createdCartIds: number[] = [];

  afterEach(async () => {
    await cleanupRecoveryRequests(createdRequestIds.splice(0));
    await cleanupAuthIdentities(createdIdentityIds.splice(0));
    await cleanupCarts(createdCartIds.splice(0));
    await deleteFixtures({ orderIds: createdOrderIds.splice(0), userIds: createdUserIds.splice(0) });
  });

  it("[migration 0034 applied] accountRecoveryRequests/accountRecoveryAuditLogs exist and are queryable, and the generated column (pendingRequesterMarker) actually computes a real value - proves the migration ran on this real MariaDB/MySQL instance, not just that the app code compiles", async () => {
    const requester = await createTestUser();
    createdUserIds.push(requester.id);
    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const request = await db.createAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const rawRows: any = await getTestDb()
      .select()
      .from(accountRecoveryRequests)
      .where(eq(accountRecoveryRequests.id, request.id));
    const row = rawRows[0];
    expect(row.status).toBe("pending");
    // The generated column is computed server-side by MySQL/MariaDB itself
    // (case-when-status-is-pending expression) - if migration 0034 hadn't
    // actually applied, this column wouldn't exist at all and the SELECT
    // itself would already have failed above.
    expect((row as any).pendingRequesterMarker).toBe(requester.id);
  });

  it("[create request] requires a REAL authIdentities row - never accepted from a manually-typed claim", async () => {
    const requester = await createTestUser();
    createdUserIds.push(requester.id);

    await expect(submitAccountRecoveryRequest({ requesterUserId: requester.id })).rejects.toMatchObject({
      code: "NOT_GOOGLE_LINKED",
    });
  });

  it("[one pending request per user] real DB-level unique constraint (generated column) rejects a second pending row even bypassing the application-level check", async () => {
    const requester = await createTestUser();
    createdUserIds.push(requester.id);
    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const first = await db.createAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(first.id);

    // Bypasses submitAccountRecoveryRequest's own application-level
    // pending-check on purpose, to prove the DATABASE itself (not just the
    // app) enforces "at most one pending request per requester" - the
    // accountRecoveryRequests_one_pending_per_requester_unique generated-
    // column index from drizzle/schema.ts.
    //
    // drizzle-orm wraps the real mysql2/MariaDB driver error rather than
    // exposing errno/code on the top-level thrown Error - see
    // server/helpers/databaseErrorClassifier.ts's own docstring for the
    // exact observed shape (top-level errno/code are undefined; the real
    // 1062/ER_DUP_ENTRY is one or more `cause` links down). Asserting
    // `.rejects.toMatchObject({ code: "ER_DUP_ENTRY" })` against the
    // WRAPPING error therefore always fails even when the constraint
    // correctly rejected the insert - against a real MariaDB instance this
    // was observed to reject the insert exactly as designed while the
    // assertion itself failed. This walks the real cause chain instead, via
    // the SAME shared, cycle-safe, depth-capped, message-blind helper
    // production code already relies on for the identical reason (see
    // server/db.ts's concurrent-write recovery branches) - never a second,
    // parallel implementation of "is this a duplicate key error" that could
    // drift from the real one.
    let caughtError: unknown;
    try {
      await db.createAccountRecoveryRequest({ requesterUserId: requester.id });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError, "expected the second insert to throw - the unique constraint did not reject it").toBeDefined();
    expect(
      isDuplicateKeyError(caughtError),
      "expected the thrown error's cause chain to contain a real ER_DUP_ENTRY/1062 duplicate-key error - " +
        "isDuplicateKeyError is cycle-safe and depth-capped, so this also fails closed (false) on a cyclic or " +
        "unexpectedly deep cause chain rather than hanging or false-accepting one"
    ).toBe(true);

    // Proves both rejection AND preserved state - not just "an error was
    // thrown for some reason": exactly the original pending request must
    // still be the only pending row for this requester, never a second
    // partial row left behind by the rejected insert.
    const pendingRows = await getTestDb()
      .select()
      .from(accountRecoveryRequests)
      .where(
        and(eq(accountRecoveryRequests.requesterUserId, requester.id), eq(accountRecoveryRequests.status, "pending"))
      );
    expect(pendingRows.length).toBe(1);
    expect(pendingRows[0].id).toBe(first.id);
  });

  it("[safe empty Donor approved end-to-end] keeps the requester's Google identity on Survivor, records Donor->Survivor provenance, and writes an audit log against the real database", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current-survivor@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: donor.id,
      targetUserId: requester.id,
    });
    expect(assessment.canApprove).toBe(true);
    expect(assessment.isFullyAutomatable).toBe(true);
    expect(assessment.sourceGoogleIdentity).toBeNull();
    expect(assessment.targetGoogleIdentity?.id).toBe(identity.id);

    const { request: approved } = await executeAccountRecovery({
      requestId: request.id,
      donorAccountId: donor.id,
      survivorAccountId: requester.id,
      adminId: 1,
      reason: "integration test - verified Donor to requester Survivor",
    });
    expect(approved.status).toBe("approved");
    expect(approved.sourceUserId).toBe(donor.id);
    expect(approved.targetUserId).toBe(requester.id);

    const survivorIdentity = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(survivorIdentity).toBeDefined();
    expect(survivorIdentity!.id).toBe(identity.id);
    expect(survivorIdentity!.providerSubject).toBe(identity.providerSubject);
    expect(await db.getAuthIdentityByUserAndProvider(donor.id, "google")).toBeUndefined();

    const auditRows = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, request.id));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe("approved");
    expect(auditRows[0].sourceUserId).toBe(donor.id);
    expect(auditRows[0].targetUserId).toBe(requester.id);
    const safeMetadata =
      typeof auditRows[0].safeMetadata === "string"
        ? JSON.parse(auditRows[0].safeMetadata)
        : auditRows[0].safeMetadata;
    expect(safeMetadata).toMatchObject({
      identityMoved: false,
      identityPreservedOnSurvivor: true,
      donorAccountId: donor.id,
      survivorAccountId: requester.id,
    });
    expect(JSON.stringify(safeMetadata)).not.toMatch(new RegExp(identity.providerSubject));
  });

  it("[M1 regression: reject then resubmit] a requester's first rejected request never blocks a later Donor->same-Survivor recovery", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current-resubmit@example.test");
    createdIdentityIds.push(identity.id);

    const firstRequest = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(firstRequest.id);
    const rejected = await reviewAccountRecoveryRequest({
      requestId: firstRequest.id,
      action: "reject",
      actorAdminId: 1,
      reason: "insufficient evidence - please provide an order number",
    });
    expect(rejected.status).toBe("rejected");

    const secondRequest = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(secondRequest.id);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: secondRequest.id,
      sourceUserId: donor.id,
      targetUserId: requester.id,
    });
    expect(assessment.userOwnedDataFindings).toEqual([]);
    expect(assessment.canApprove, `expected no block reasons, got: ${assessment.blockReasons.join("; ")}`).toBe(true);
    expect(assessment.isFullyAutomatable).toBe(true);

    const { request: approved } = await executeAccountRecovery({
      requestId: secondRequest.id,
      donorAccountId: donor.id,
      survivorAccountId: requester.id,
      adminId: 2,
      reason: "resubmission verified - legacy Donor confirmed",
    });
    expect(approved.status).toBe("approved");
    expect(approved.sourceUserId).toBe(donor.id);
    expect(approved.targetUserId).toBe(requester.id);

    const survivorIdentity = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(survivorIdentity?.id).toBe(identity.id);
    expect(await db.getAuthIdentityByUserAndProvider(donor.id, "google")).toBeUndefined();

    const firstRequestAfter = await db.getAccountRecoveryRequestById(firstRequest.id);
    expect(firstRequestAfter!.status).toBe("rejected");
    const secondRequestAfter = await db.getAccountRecoveryRequestById(secondRequest.id);
    expect(secondRequestAfter!.status).toBe("approved");
    expect(secondRequestAfter!.sourceUserId).toBe(donor.id);
    expect(secondRequestAfter!.targetUserId).toBe(requester.id);

    const firstAuditRows = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, firstRequest.id));
    expect(firstAuditRows.length).toBe(1);
    expect(firstAuditRows[0].action).toBe("rejected");

    const secondAuditRows = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, secondRequest.id));
    expect(secondAuditRows.length).toBe(1);
    expect(secondAuditRows[0].action).toBe("approved");
    expect(secondAuditRows[0].authIdentityId).toBe(identity.id);
    expect(JSON.stringify(secondAuditRows[0].safeMetadata)).not.toMatch(new RegExp(identity.providerSubject));
  });

  it("[Donor already has a Google identity] rejected as ambiguous, and both pre-existing identities are untouched", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const survivorIdentity = await linkTestGoogleIdentity(requester.id, "current@example.test");
    const donorIdentity = await linkTestGoogleIdentity(donor.id, "donor-own@example.test");
    createdIdentityIds.push(survivorIdentity.id, donorIdentity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    await expect(
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    expect((await db.getAuthIdentityByUserAndProvider(requester.id, "google"))!.id).toBe(survivorIdentity.id);
    expect((await db.getAuthIdentityByUserAndProvider(donor.id, "google"))!.id).toBe(donorIdentity.id);
  });

  it("[Donor with a real order] economic data blocks Simple Recovery and requester Google identity stays on Survivor", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current@example.test");
    createdIdentityIds.push(identity.id);
    const order = await createTestOrder(donor.id);
    createdOrderIds.push(order.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: donor.id,
      targetUserId: requester.id,
    });
    expect(assessment.canApprove).toBe(false);
    expect(assessment.economicDataFindings.some((f) => f.table === "orders")).toBe(true);

    await expect(
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    expect((await db.getAuthIdentityByUserAndProvider(requester.id, "google"))!.id).toBe(identity.id);
    expect(await db.getAuthIdentityByUserAndProvider(donor.id, "google")).toBeUndefined();
  });

  it("[concurrent approvals] exactly ONE simultaneous Donor->Survivor approval succeeds and the requester identity remains owned by Survivor", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const [resultA, resultB] = await Promise.allSettled([
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 1, reason: "admin A" }),
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 2, reason: "admin B" }),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(AccountRecoveryError);
    expect(["ALREADY_PROCESSED", "CONFLICT", "UNSAFE"]).toContain(rejectedReason.code);

    const survivorIdentity = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(survivorIdentity?.id).toBe(identity.id);
    expect(await db.getAuthIdentityByUserAndProvider(donor.id, "google")).toBeUndefined();

    const finalRequest = await db.getAccountRecoveryRequestById(request.id);
    expect(finalRequest!.status).toBe("approved");
    expect(finalRequest!.sourceUserId).toBe(donor.id);
    expect(finalRequest!.targetUserId).toBe(requester.id);
  });

  it("[foreign key / cascade] deleting an accountRecoveryRequests row cascades to its accountRecoveryAuditLogs rows via the real FK - not just application-level cleanup logic", async () => {
    const requester = await createTestUser();
    createdUserIds.push(requester.id);
    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const request = await db.createAccountRecoveryRequest({ requesterUserId: requester.id });
    // Intentionally NOT pushed to createdRequestIds - this test deletes it
    // itself, to prove the FK cascade rather than relying on afterEach.

    await db.insertAccountRecoveryAuditLog({
      recoveryRequestId: request.id,
      action: "created",
      safeMetadata: { note: "fk cascade test" },
    });

    const beforeDelete = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, request.id));
    expect(beforeDelete.length).toBe(1);

    // Delete the PARENT row directly - never touches accountRecoveryAuditLogs.
    await getTestDb().delete(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, request.id));

    const afterDelete = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, request.id));
    expect(afterDelete.length).toBe(0);
  });

  it("[Donor with real user-owned data] a real cart row on Donor blocks Simple Recovery and remains untouched", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id, donor.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current@example.test");
    createdIdentityIds.push(identity.id);

    const cartResult: any = await getTestDb().insert(carts).values({ userId: donor.id });
    const cartId = cartResult?.[0]?.insertId ?? cartResult?.insertId;
    createdCartIds.push(cartId);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: donor.id,
      targetUserId: requester.id,
    });
    expect(assessment.canApprove).toBe(false);
    expect(assessment.userOwnedDataFindings.some((f) => f.table === "carts")).toBe(true);

    await expect(
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    expect((await db.getAuthIdentityByUserAndProvider(requester.id, "google"))!.id).toBe(identity.id);
    const cartStillExists = await getTestDb().select().from(carts).where(eq(carts.id, cartId));
    expect(cartStillExists.length).toBe(1);
    expect(cartStillExists[0].userId).toBe(donor.id);
  });

  it("[transaction rollback] deleting the selected Donor between preview and approval leaves zero partial writes while requester Survivor identity stays intact", async () => {
    const requester = await createTestUser();
    const donor = await createTestUser();
    createdUserIds.push(requester.id);

    const identity = await linkTestGoogleIdentity(requester.id, "current@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    await deleteFixtures({ userIds: [donor.id] });

    await expect(
      executeAccountRecovery({ requestId: request.id, donorAccountId: donor.id, survivorAccountId: requester.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    const stillOnSurvivor = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(stillOnSurvivor!.id).toBe(identity.id);

    const requestAfter = await db.getAccountRecoveryRequestById(request.id);
    expect(requestAfter!.status).toBe("pending");
    expect(requestAfter!.reviewedAt).toBeNull();

    const auditRows = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, request.id));
    expect(auditRows.length).toBe(0);
  });
});
