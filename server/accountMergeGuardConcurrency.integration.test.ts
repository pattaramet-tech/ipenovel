import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountRecoveryRequests,
  authIdentities,
  pointsTransactions,
} from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestUser, deleteFixtures, uniqueTestTag } from "./test-helpers/fixtures";
import { reviewAccountRecoveryRequest } from "./services/accountRecoveryService";
import {
  __setAccountMergeLifecycleFaultForTests,
  completeAccountMergeGuard,
  prepareAccountMergeGuard,
  startAccountMergeGuard,
} from "./services/accountMergeGuardService";

/**
 * Real-database IPE-005 concurrency coverage. The integration project refuses
 * to run unless TEST_DATABASE_URL resolves to the disposable `ipenovel_test`
 * database, so these tests exercise real row locks/unique constraints without
 * any production action.
 */

type MergeFixture = {
  sourceId: number;
  targetId: number;
  requestId: number;
  identityId: number;
};

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("IPE-005 integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

async function linkGoogleIdentity(userId: number): Promise<number> {
  const t = requireTestDb();
  const result: any = await t.insert(authIdentities).values({
    userId,
    provider: "google",
    providerSubject: `ipe005-google-${uniqueTestTag()}`,
    emailAtLink: `ipe005-${uniqueTestTag()}@example.test`,
  });
  return Number(result?.[0]?.insertId ?? result?.insertId);
}

async function createBlockedMergePair(): Promise<MergeFixture> {
  const source = await createTestUser();
  const target = await createTestUser();
  const identityId = await linkGoogleIdentity(source.id);
  const request = await db.createAccountRecoveryRequest({ requesterUserId: source.id });
  await reviewAccountRecoveryRequest({
    requestId: request.id,
    action: "block",
    actorAdminId: 1,
    reason: "IPE-005 test requires advanced merge",
  });
  return { sourceId: source.id, targetId: target.id, requestId: request.id, identityId };
}

const fixtures: MergeFixture[] = [];

async function cleanupFixture(f: MergeFixture): Promise<void> {
  const t = requireTestDb();
  const cases = await t.select({ id: accountMergeCases.id }).from(accountMergeCases).where(eq(accountMergeCases.sourceUserId, f.sourceId));
  for (const row of cases) {
    await t.delete(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.mergeCaseId, row.id));
  }
  await t.delete(accountMergeCases).where(eq(accountMergeCases.sourceUserId, f.sourceId));
  await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, f.sourceId));
  await t.delete(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, f.requestId));
  await t.delete(authIdentities).where(eq(authIdentities.id, f.identityId));
  await deleteFixtures({ userIds: [f.sourceId, f.targetId] });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.sequential("IPE-005 Account Merge guard concurrency - real database", () => {
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(getTestDb());
  });

  afterEach(async () => {
    __setAccountMergeLifecycleFaultForTests(null);
    while (fixtures.length > 0) {
      await cleanupFixture(fixtures.pop()!);
    }
  });

  it("migration 0041 computes guardedSourceMarker and permits only cancelled history to release the Source", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);

    const prepared = await prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 });
    const raw = (await requireTestDb().select().from(accountMergeCases).where(eq(accountMergeCases.id, prepared.id)))[0];
    expect(raw.status).toBe("pending");
    expect(raw.guardedSourceMarker).toBe(f.sourceId);

    await db.getDb().then(async (database) => {
      if (!database) throw new Error("Database unavailable");
      await expect(
        database.insert(accountMergeCases).values({
          // Deliberately omit the origin request so this assertion exercises
          // the durable one-guarded-case-per-Source index, not the separate
          // unique originAccountRecoveryRequestId constraint.
          originAccountRecoveryRequestId: null,
          sourceUserId: f.sourceId,
          targetUserId: f.targetId,
          status: "pending",
          createdByAdminId: 2,
        })
      ).rejects.toThrow();
    });
  }, 30000);

  it("two concurrent admin prepare retries converge to ONE durable case and ONE prepare audit", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);

    const [a, b] = await Promise.all([
      prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 11 }),
      prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 22 }),
    ]);

    expect(a.id).toBe(b.id);
    const cases = await requireTestDb().select().from(accountMergeCases).where(eq(accountMergeCases.sourceUserId, f.sourceId));
    expect(cases).toHaveLength(1);
    const audits = await requireTestDb()
      .select()
      .from(accountMergeAuditLogs)
      .where(and(eq(accountMergeAuditLogs.mergeCaseId, a.id), eq(accountMergeAuditLogs.action, "guard_prepared")));
    expect(audits).toHaveLength(1);
  }, 30000);

  it("two concurrent start retries are idempotent: both observe in_progress but only one transition audit is appended", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const prepared = await prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 });

    const [a, b] = await Promise.all([
      startAccountMergeGuard(prepared.id, 11),
      startAccountMergeGuard(prepared.id, 22),
    ]);
    expect(a.status).toBe("in_progress");
    expect(b.status).toBe("in_progress");

    const audits = await requireTestDb()
      .select()
      .from(accountMergeAuditLogs)
      .where(and(eq(accountMergeAuditLogs.mergeCaseId, prepared.id), eq(accountMergeAuditLogs.action, "guard_started")));
    expect(audits).toHaveLength(1);
  }, 30000);

  it("a classified customer mutation that wins the Source lock commits BEFORE prepare; prepare waits and then activates the guard", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const database = await db.getDb();
    if (!database) throw new Error("Database unavailable");

    const mutationHasLock = deferred();
    const releaseMutation = deferred();

    const mutation = database.transaction(async (tx: any) => {
      await db.recordPointsTransaction(
        {
          userId: f.sourceId,
          type: "earn",
          amount: "1.00",
          balanceAfter: "1.00",
          referenceType: "ipe005_before_guard",
          referenceId: 1,
          note: "race winner before guard activation",
        },
        tx
      );
      mutationHasLock.resolve();
      await releaseMutation.promise;
    });

    await mutationHasLock.promise;
    let prepareSettled = false;
    const prepare = prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 })
      .then((value) => {
        prepareSettled = true;
        return value;
      });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(prepareSettled).toBe(false);

    releaseMutation.resolve();
    await mutation;
    const prepared = await prepare;
    expect(prepared.status).toBe("pending");

    const ledger = await requireTestDb()
      .select()
      .from(pointsTransactions)
      .where(and(eq(pointsTransactions.userId, f.sourceId), eq(pointsTransactions.referenceType, "ipe005_before_guard")));
    expect(ledger).toHaveLength(1);
  }, 30000);

  it("two ordinary classified mutations for one user share the merge barrier instead of blocking each other", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const database = await db.getDb();
    if (!database) throw new Error("Database unavailable");

    const firstHasGuard = deferred();
    const secondHasGuard = deferred();
    const releaseBoth = deferred();

    const first = database.transaction(async (tx: any) => {
      await db.assertAccountMergeClassifiedMutationAllowed(f.sourceId, tx);
      firstHasGuard.resolve();
      await releaseBoth.promise;
    });

    await firstHasGuard.promise;
    const second = database.transaction(async (tx: any) => {
      await db.assertAccountMergeClassifiedMutationAllowed(f.sourceId, tx);
      secondHasGuard.resolve();
      await releaseBoth.promise;
    });

    let sharedConcurrently = false;
    let prepareSettled = false;
    let prepare: ReturnType<typeof prepareAccountMergeGuard> | undefined;
    try {
      sharedConcurrently = await Promise.race([
        secondHasGuard.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (sharedConcurrently) {
        prepare = prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 })
          .then((value) => {
            prepareSettled = true;
            return value;
          });
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    } finally {
      releaseBoth.resolve();
      await Promise.all([first, second]);
    }

    expect(sharedConcurrently).toBe(true);
    expect(prepareSettled).toBe(false);
    expect((await prepare)?.status).toBe("pending");
  }, 30000);

  it("shared-to-exclusive upgrade is rejected before SQL instead of becoming a two-transaction deadlock", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const database = await db.getDb();
    if (!database) throw new Error("Database unavailable");

    let sharedCount = 0;
    const bothHaveSharedBarrier = deferred();

    const runLegacyUpgradeShape = () =>
      database.transaction(async (tx: any) => {
        await db.assertAccountMergeClassifiedMutationAllowed(f.sourceId, tx);
        sharedCount += 1;
        if (sharedCount === 2) bothHaveSharedBarrier.resolve();
        await bothHaveSharedBarrier.promise;
        await db.lockUserForPoints(f.sourceId, tx);
      });

    const results = await Promise.allSettled([runLegacyUpgradeShape(), runLegacyUpgradeShape()]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "ACCOUNT_MERGE_LOCK_UPGRADE_FORBIDDEN",
          userId: f.sourceId,
        });
      }
    }
  }, 30000);

  it("two point-capable same-user transactions serialize on the exclusive barrier before nested points work", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const database = await db.getDb();
    if (!database) throw new Error("Database unavailable");

    const firstHasExclusiveBarrier = deferred();
    const secondHasExclusiveBarrier = deferred();
    const releaseFirst = deferred();

    const first = database.transaction(async (tx: any) => {
      await db.assertAccountMergePointsMutationsAllowed([f.sourceId], tx);
      firstHasExclusiveBarrier.resolve();
      // Production point-capable flows may call lockUserForPoints again inside
      // nested finalization. Re-entering an already-exclusive barrier is safe.
      await db.lockUserForPoints(f.sourceId, tx);
      await releaseFirst.promise;
    });

    await firstHasExclusiveBarrier.promise;
    const second = database.transaction(async (tx: any) => {
      await db.assertAccountMergePointsMutationsAllowed([f.sourceId], tx);
      secondHasExclusiveBarrier.resolve();
      await db.lockUserForPoints(f.sourceId, tx);
    });

    const secondEnteredEarly = await Promise.race([
      secondHasExclusiveBarrier.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    expect(secondEnteredEarly).toBe(false);

    releaseFirst.resolve();
    await first;
    await secondHasExclusiveBarrier.promise;
    await second;
  }, 30000);

  it("a classified mutation after guard activation is refused before commit and creates no ledger row", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    await prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 });

    await expect(
      db.recordPointsTransaction({
        userId: f.sourceId,
        type: "earn",
        amount: "2.00",
        balanceAfter: "2.00",
        referenceType: "ipe005_after_guard",
        referenceId: 2,
      })
    ).rejects.toMatchObject({ code: "ACCOUNT_MERGE_SOURCE_GUARDED" });

    const rows = await requireTestDb()
      .select()
      .from(pointsTransactions)
      .where(and(eq(pointsTransactions.userId, f.sourceId), eq(pointsTransactions.referenceType, "ipe005_after_guard")));
    expect(rows).toHaveLength(0);
  }, 30000);

  it("completed Source remains fail-closed to a stale-session classified mutation", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const prepared = await prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 });
    await startAccountMergeGuard(prepared.id, 1);
    const completed = await completeAccountMergeGuard(prepared.id, 1);
    expect(completed.status).toBe("completed");

    await expect(
      db.recordPointsTransaction({
        userId: f.sourceId,
        type: "earn",
        amount: "3.00",
        balanceAfter: "3.00",
        referenceType: "ipe005_stale_completed",
        referenceId: 3,
      })
    ).rejects.toMatchObject({ code: "ACCOUNT_MERGE_SOURCE_GUARDED", mergeStatus: "completed" });
  }, 30000);

  it("injected failure AFTER case insert rolls back both case and prepare audit", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    __setAccountMergeLifecycleFaultForTests("after_case_insert");

    await expect(
      prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 })
    ).rejects.toThrow("Injected Account Merge lifecycle failure at after_case_insert");

    const cases = await requireTestDb().select().from(accountMergeCases).where(eq(accountMergeCases.sourceUserId, f.sourceId));
    const audits = await requireTestDb().select().from(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.sourceUserId, f.sourceId));
    expect(cases).toHaveLength(0);
    expect(audits).toHaveLength(0);
  }, 30000);

  it("injected failure AFTER transition update rolls status/timestamp back and appends no transition audit", async () => {
    const f = await createBlockedMergePair();
    fixtures.push(f);
    const prepared = await prepareAccountMergeGuard({ requestId: f.requestId, targetUserId: f.targetId, actorAdminId: 1 });
    __setAccountMergeLifecycleFaultForTests("after_transition_update");

    await expect(startAccountMergeGuard(prepared.id, 2)).rejects.toThrow(
      "Injected Account Merge lifecycle failure at after_transition_update"
    );

    const row = (await requireTestDb().select().from(accountMergeCases).where(eq(accountMergeCases.id, prepared.id)))[0];
    expect(row.status).toBe("pending");
    expect(row.startedAt).toBeNull();
    const starts = await requireTestDb()
      .select()
      .from(accountMergeAuditLogs)
      .where(and(eq(accountMergeAuditLogs.mergeCaseId, prepared.id), eq(accountMergeAuditLogs.action, "guard_started")));
    expect(starts).toHaveLength(0);
  }, 30000);
});
