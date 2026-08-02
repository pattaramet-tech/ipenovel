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

  it("[safe empty source approved end-to-end] moves the Google identity, sets target.loginMethod='google', backfills target.email only because it was empty, marks the request approved, and writes an audit log - all against the real database", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);
    // createTestUser always assigns a fixture email - force target.email to
    // genuinely empty (NULL) so the "backfill only when currently empty"
    // rule (rule 11) has something real to prove.
    await getTestDb().update(users).set({ email: null }).where(eq(users.id, target.id));

    const identity = await linkTestGoogleIdentity(requester.id, "legacy-real@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: requester.id,
      targetUserId: target.id,
    });
    expect(assessment.canApprove).toBe(true);
    expect(assessment.isFullyAutomatable).toBe(true);

    const { request: approved } = await executeAccountRecovery({
      requestId: request.id,
      targetUserId: target.id,
      adminId: 1,
      reason: "integration test - verified via real db",
    });
    expect(approved.status).toBe("approved");
    expect(approved.sourceUserId).toBe(requester.id);
    expect(approved.targetUserId).toBe(target.id);

    const movedIdentity = await db.getAuthIdentityByUserAndProvider(target.id, "google");
    expect(movedIdentity).toBeDefined();
    expect(movedIdentity!.id).toBe(identity.id);
    expect(movedIdentity!.providerSubject).toBe(identity.providerSubject);

    const sourceStillLinked = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(sourceStillLinked).toBeUndefined();

    const targetUser = await db.getUserById(target.id);
    expect(targetUser!.loginMethod).toBe("google");
    expect(targetUser!.email).toBe("legacy-real@example.test");
    // users.id and users.openId are NEVER touched by recovery.
    expect(targetUser!.id).toBe(target.id);
    expect(targetUser!.openId).toBe(target.openId);

    const sourceUser = await db.getUserById(requester.id);
    expect(sourceUser!.id).toBe(requester.id);
    expect(sourceUser!.openId).toBe(requester.openId);

    const auditRows = await getTestDb()
      .select()
      .from(accountRecoveryAuditLogs)
      .where(eq(accountRecoveryAuditLogs.recoveryRequestId, request.id));
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe("approved");
    expect(JSON.stringify(auditRows[0].safeMetadata)).not.toMatch(new RegExp(identity.providerSubject));
  });

  it("[M1 regression: reject then resubmit] a source account's FIRST request being rejected must never permanently block a SECOND, later request from the same source - the second one still approves end-to-end", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);

    // Step 1: source user with a real Google identity and genuinely no
    // other data/entitlements (no order, no cart, nothing) - the same
    // "empty source account" precondition as the already-covered
    // [safe empty source approved end-to-end] test.
    const identity = await linkTestGoogleIdentity(requester.id, "legacy-resubmit@example.test");
    createdIdentityIds.push(identity.id);

    // Step 2: submit the FIRST recovery request.
    const firstRequest = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(firstRequest.id);

    // Step 3: admin rejects the first request (a real reason is required -
    // matches the reviewAccountRecoveryRequest/router contract).
    const rejected = await reviewAccountRecoveryRequest({
      requestId: firstRequest.id,
      action: "reject",
      actorAdminId: 1,
      reason: "insufficient evidence - please provide an order number",
    });
    expect(rejected.status).toBe("rejected");

    // Before the M1 fix, findAccountRecoveryUserOwnedData counted ANY
    // other accountRecoveryRequests row for this requester - including the
    // just-rejected one above - as "user-owned data left behind",
    // permanently blocking every future request from this same source.
    // getAuthIdentityByUserAndProvider still finds the source's real
    // Google identity here (rejecting a REQUEST never touches
    // authIdentities at all), so the requester genuinely can submit again.

    // Step 4: user submits a SECOND recovery request.
    const secondRequest = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(secondRequest.id);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    // Step 5: admin previews the second request - this is exactly where
    // the bug manifested: canApprove must be true (the rejected sibling
    // must not appear in userOwnedDataFindings at all).
    const assessment = await assessAccountRecoverySafety({
      requestId: secondRequest.id,
      sourceUserId: requester.id,
      targetUserId: target.id,
    });
    expect(assessment.userOwnedDataFindings).toEqual([]);
    expect(assessment.canApprove, `expected no block reasons, got: ${assessment.blockReasons.join("; ")}`).toBe(true);
    expect(assessment.isFullyAutomatable).toBe(true);

    // Step 6: approval must succeed - the full transactional flow, same
    // locking/re-verification as every other approval in this file, never
    // weakened for this scenario.
    const { request: approved } = await executeAccountRecovery({
      requestId: secondRequest.id,
      targetUserId: target.id,
      adminId: 2,
      reason: "resubmission verified - order number confirmed",
    });
    expect(approved.status).toBe("approved");
    expect(approved.sourceUserId).toBe(requester.id);
    expect(approved.targetUserId).toBe(target.id);

    // Step 7: the Google identity genuinely moved to the target, and no
    // longer belongs to the source.
    const movedIdentity = await db.getAuthIdentityByUserAndProvider(target.id, "google");
    expect(movedIdentity).toBeDefined();
    expect(movedIdentity!.id).toBe(identity.id);
    expect(movedIdentity!.providerSubject).toBe(identity.providerSubject);
    const sourceStillLinked = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(sourceStillLinked).toBeUndefined();

    // Step 8: the FIRST request's own row is untouched by the second
    // request's approval - still exactly "rejected".
    const firstRequestAfter = await db.getAccountRecoveryRequestById(firstRequest.id);
    expect(firstRequestAfter!.status).toBe("rejected");

    // Step 9: the SECOND request is the one that ended up approved.
    const secondRequestAfter = await db.getAccountRecoveryRequestById(secondRequest.id);
    expect(secondRequestAfter!.status).toBe("approved");
    expect(secondRequestAfter!.sourceUserId).toBe(requester.id);
    expect(secondRequestAfter!.targetUserId).toBe(target.id);

    // Step 10: audit logs exist per the existing contract - one "rejected"
    // entry for the first request, one "approved" entry for the second -
    // never merged, never missing, never duplicated.
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

  it("[target already has a Google identity] rejected, and the pre-existing target identity is left completely untouched", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);

    const sourceIdentity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    const targetIdentity = await linkTestGoogleIdentity(target.id, "target-own@example.test");
    createdIdentityIds.push(sourceIdentity.id, targetIdentity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    await expect(
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    const stillOnTarget = await db.getAuthIdentityByUserAndProvider(target.id, "google");
    expect(stillOnTarget!.id).toBe(targetIdentity.id);
    const stillOnSource = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(stillOnSource!.id).toBe(sourceIdentity.id);
  });

  it("[source with a real order] economic data blocks approval - never auto-moved", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);

    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);
    const order = await createTestOrder(requester.id);
    createdOrderIds.push(order.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: requester.id,
      targetUserId: target.id,
    });
    expect(assessment.canApprove).toBe(false);
    expect(assessment.economicDataFindings.some((f) => f.table === "orders")).toBe(true);

    await expect(
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    // Never moved - the source still owns its own identity.
    const stillOnSource = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(stillOnSource!.id).toBe(identity.id);
  });

  it("[concurrent approvals] exactly ONE of two simultaneous executeAccountRecovery calls for the SAME request succeeds - the other gets a safe, distinct failure, and the identity is moved exactly once", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);

    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const [resultA, resultB] = await Promise.allSettled([
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 1, reason: "admin A" }),
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 2, reason: "admin B" }),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedReason).toBeInstanceOf(AccountRecoveryError);
    expect(["ALREADY_PROCESSED", "CONFLICT", "UNSAFE"]).toContain(rejectedReason.code);

    const movedIdentity = await db.getAuthIdentityByUserAndProvider(target.id, "google");
    expect(movedIdentity).toBeDefined();
    expect(movedIdentity!.id).toBe(identity.id);

    const finalRequest = await db.getAccountRecoveryRequestById(request.id);
    expect(finalRequest!.status).toBe("approved");
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

  it("[source with real user-owned data] a real cart row on the source account blocks approval - never auto-moved, and the cart itself is left completely untouched", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id, target.id);

    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const cartResult: any = await getTestDb().insert(carts).values({ userId: requester.id });
    const cartId = cartResult?.[0]?.insertId ?? cartResult?.insertId;
    createdCartIds.push(cartId);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    const assessment = await assessAccountRecoverySafety({
      requestId: request.id,
      sourceUserId: requester.id,
      targetUserId: target.id,
    });
    expect(assessment.canApprove).toBe(false);
    expect(assessment.userOwnedDataFindings.some((f) => f.table === "carts")).toBe(true);

    await expect(
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    // Never moved - the source still owns its own identity - and the cart
    // itself was never touched (this tool never moves/merges/deletes
    // user-owned data or the source account).
    const stillOnSource = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(stillOnSource!.id).toBe(identity.id);
    const cartStillExists = await getTestDb().select().from(carts).where(eq(carts.id, cartId));
    expect(cartStillExists.length).toBe(1);
    expect(cartStillExists[0].userId).toBe(requester.id);
  });

  it("[transaction rollback] approving a request whose target became invalid (deleted) between preview and approval leaves ZERO partial writes - identity stays on source, request stays pending, no audit log is written", async () => {
    const requester = await createTestUser();
    const target = await createTestUser();
    createdUserIds.push(requester.id);

    const identity = await linkTestGoogleIdentity(requester.id, "legacy@example.test");
    createdIdentityIds.push(identity.id);

    const request = await submitAccountRecoveryRequest({ requesterUserId: requester.id });
    createdRequestIds.push(request.id);

    // Simulates a real "changed out from under the transaction" scenario:
    // the target account is gone by the time approval actually runs
    // (assessAccountRecoverySafety's targetExists check fails inside the
    // locked transaction) - never cleaned up via createdUserIds since it's
    // deleted here, deliberately, as part of the test itself.
    await deleteFixtures({ userIds: [target.id] });

    await expect(
      executeAccountRecovery({ requestId: request.id, targetUserId: target.id, adminId: 1, reason: "test" })
    ).rejects.toMatchObject({ code: "UNSAFE" });

    // Nothing partially happened - real ROLLBACK, not a partial commit.
    const stillOnSource = await db.getAuthIdentityByUserAndProvider(requester.id, "google");
    expect(stillOnSource!.id).toBe(identity.id);

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
