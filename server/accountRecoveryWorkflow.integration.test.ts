import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestOrder, uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";
import { authIdentities, accountRecoveryRequests, accountRecoveryAuditLogs, users } from "../drizzle/schema";
import * as db from "./db";
import {
  AccountRecoveryError,
  assessAccountRecoverySafety,
  executeAccountRecovery,
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

describe.skipIf(!process.env.TEST_DATABASE_URL)("Admin Account Recovery - real database", () => {
  const createdRequestIds: number[] = [];
  const createdIdentityIds: number[] = [];
  const createdUserIds: number[] = [];
  const createdOrderIds: number[] = [];

  afterEach(async () => {
    await cleanupRecoveryRequests(createdRequestIds.splice(0));
    await cleanupAuthIdentities(createdIdentityIds.splice(0));
    await deleteFixtures({ orderIds: createdOrderIds.splice(0), userIds: createdUserIds.splice(0) });
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
    await expect(db.createAccountRecoveryRequest({ requesterUserId: requester.id })).rejects.toMatchObject({
      code: "ER_DUP_ENTRY",
    });
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
});
