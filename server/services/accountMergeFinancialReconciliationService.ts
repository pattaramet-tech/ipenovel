import { eq, sql } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeFinancialReconciliations,
  pointsAccounts,
  pointsTransactions,
  walletAccounts,
  walletTransactions,
} from "../../drizzle/schema";
import * as db from "../db";
import {
  addNonNegativeFixedDecimals,
  minorUnitsToDecimal,
  type FixedDecimalSpec,
} from "./accountMergeFinancialMath";

const WALLET_SPEC: FixedDecimalSpec = { precision: 12, scale: 2 };
const POINTS_SPEC: FixedDecimalSpec = { precision: 10, scale: 2 };
const FINANCIAL_REFERENCE_TYPE = "account_merge_financial";

type FinancialFaultPoint = "after_wallet" | "after_points" | "before_receipt";
let financialFaultForTests: FinancialFaultPoint | null = null;

export class AccountMergeFinancialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AccountMergeFinancialError";
  }
}

/** Test-only deterministic fault injection for proving all-or-nothing writes. */
export function __setAccountMergeFinancialFaultForTests(point: FinancialFaultPoint | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Account Merge financial fault injection is test-only");
  }
  financialFaultForTests = point;
}

function maybeInjectFinancialFault(point: FinancialFaultPoint): void {
  if (financialFaultForTests === point) {
    throw new Error(`Injected Account Merge financial failure at ${point}`);
  }
}

function unwrapRows(raw: any): any[] {
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Array.isArray(rows) ? rows : [];
}

async function readMergeCase(caseId: number, database: any) {
  const rows = await database.select().from(accountMergeCases).where(eq(accountMergeCases.id, caseId)).limit(1);
  return rows[0];
}

async function lockMergeCase(caseId: number, tx: any) {
  const rows = unwrapRows(
    await tx.execute(
      sql`SELECT id, sourceUserId, targetUserId, status FROM accountMergeCases WHERE id = ${caseId} FOR UPDATE`
    )
  );
  return rows[0];
}

async function readReceipt(caseId: number, database: any) {
  // This must be a locking/current read. The standalone API performs an
  // ordinary merge-case read before acquiring canonical locks, which can
  // establish a REPEATABLE READ snapshot. A second concurrent admin that
  // waits behind the first transaction must see the receipt committed by the
  // winner after the lock wait; a plain snapshot SELECT can miss it and race
  // into the UNIQUE receipt constraint instead of returning idempotently.
  const rows = unwrapRows(
    await database.execute(
      sql`SELECT * FROM accountMergeFinancialReconciliations WHERE mergeCaseId = ${caseId} LIMIT 1 FOR UPDATE`
    )
  );
  return rows[0];
}

async function readWalletAccount(userId: number, tx: any) {
  const rows = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
  return rows[0];
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AccountMergeFinancialError("INVALID_ARGUMENT", `${fieldName} must be a positive integer`);
  }
}

/**
 * IPE-006 Wallet + Points reconciliation.
 *
 * This is intentionally NOT built on createWalletTransaction /
 * recordPointsTransaction: those public helpers correctly reject every
 * classified Source write once IPE-005's merge guard is active. Financial
 * reconciliation is the one privileged merge-only writer. It proves the exact
 * in-progress case under the canonical Source/Target users-row lock hierarchy,
 * writes both ledgers directly in one transaction, and persists a UNIQUE
 * per-case receipt as the durable once-only barrier.
 */
export async function reconcileAccountMergeFinancialsInTransaction(
  params: {
    caseId: number;
    actorAdminId: number;
  },
  tx: any
) {
  assertPositiveInteger(params.caseId, "caseId");
  assertPositiveInteger(params.actorAdminId, "actorAdminId");

  // External orchestrators may already hold the canonical participant/case
  // locks. Re-reading through the SAME transaction preserves the exact IPE-006
  // checks while allowing IPE-008 to include this phase in one outer atomic
  // transaction. The public wrapper below keeps the original standalone API.
  const initial = await readMergeCase(params.caseId, tx);
  if (!initial) throw new AccountMergeFinancialError("CASE_NOT_FOUND", "Account merge case not found");

    const sourceUserId = Number(initial.sourceUserId);
    const targetUserId = Number(initial.targetUserId);

    // Canonical IPE-005 hierarchy: all involved users in ascending id order,
    // then merge-case rows, then domain rows/ledgers.
    await db.lockAccountMergeUserRows([sourceUserId, targetUserId], tx);
    const current = await lockMergeCase(params.caseId, tx);
    if (!current) throw new AccountMergeFinancialError("CASE_NOT_FOUND", "Account merge case not found");
    if (
      Number(current.sourceUserId) !== sourceUserId ||
      Number(current.targetUserId) !== targetUserId
    ) {
      throw new AccountMergeFinancialError("INCONSISTENT_CASE", "Merge case participants changed unexpectedly");
    }

    // A completed receipt is authoritative even if a later orchestration phase
    // has already advanced the coarse case status. Retrying IPE-006 therefore
    // returns the same committed result without creating a second credit.
    const existingReceipt = await readReceipt(params.caseId, tx);
    if (existingReceipt) {
      if (
        Number(existingReceipt.sourceUserId) !== sourceUserId ||
        Number(existingReceipt.targetUserId) !== targetUserId
      ) {
        throw new AccountMergeFinancialError("INCONSISTENT_RECEIPT", "Financial receipt participants do not match merge case");
      }
      return { alreadyReconciled: true, reconciliation: existingReceipt };
    }

    if (current.status !== "in_progress") {
      throw new AccountMergeFinancialError(
        "CASE_NOT_IN_PROGRESS",
        `Financial reconciliation requires in_progress merge case, got ${String(current.status)}`
      );
    }

    // The target may itself be the Source of another guarded merge. Ordinary
    // target-account writes would be refused in that situation, so the
    // privileged merge writer must preserve the same fail-closed invariant.
    const targetSourceCases = await db.getAccountMergeCasesForSourceForUpdate(targetUserId, tx);
    const targetGuard = targetSourceCases.find((row: any) => row.status !== "cancelled");
    if (targetGuard) {
      throw new AccountMergeFinancialError(
        "TARGET_ACCOUNT_GUARDED",
        `Target account is guarded by merge case ${Number(targetGuard.id)}`
      );
    }

    // Account Merge already owns the exclusive account guards. Lock the new
    // authoritative points rows in ascending userId before reading either
    // balance so reconciliation uses the same mutex as every ordinary points
    // writer and cannot race a pre-cutover transaction that reached balance
    // locking before the merge guard was acquired.
    await db.lockPointsAccountRowsForUpdate([sourceUserId, targetUserId], tx);

    const [sourceWallet, targetWallet, sourcePointsRaw, targetPointsRaw] = await Promise.all([
      readWalletAccount(sourceUserId, tx),
      readWalletAccount(targetUserId, tx),
      db.getAccountMergePointsBalance(sourceUserId, tx),
      db.getAccountMergePointsBalance(targetUserId, tx),
    ]);

    const wallet = addNonNegativeFixedDecimals(
      sourceWallet?.balance ?? "0.00",
      targetWallet?.balance ?? "0.00",
      "walletMerge",
      WALLET_SPEC
    );
    const points = addNonNegativeFixedDecimals(
      sourcePointsRaw,
      targetPointsRaw,
      "pointsMerge",
      POINTS_SPEC
    );

    const walletSourceBefore = minorUnitsToDecimal(wallet.leftMinor, WALLET_SPEC.scale);
    const walletTargetBefore = minorUnitsToDecimal(wallet.rightMinor, WALLET_SPEC.scale);
    const walletTargetAfter = wallet.sum;
    const pointsSourceBefore = minorUnitsToDecimal(points.leftMinor, POINTS_SPEC.scale);
    const pointsTargetBefore = minorUnitsToDecimal(points.rightMinor, POINTS_SPEC.scale);
    const pointsTargetAfter = points.sum;

    if (wallet.leftMinor > 0) {
      if (!sourceWallet) {
        throw new AccountMergeFinancialError("INCONSISTENT_WALLET", "Positive Source wallet balance has no wallet account row");
      }

      await tx
        .update(walletAccounts)
        .set({ balance: "0.00" })
        .where(eq(walletAccounts.userId, sourceUserId));

      if (targetWallet) {
        await tx
          .update(walletAccounts)
          .set({ balance: walletTargetAfter })
          .where(eq(walletAccounts.userId, targetUserId));
      } else {
        await tx.insert(walletAccounts).values({
          userId: targetUserId,
          balance: walletTargetAfter,
          totalTopupApproved: "0.00",
          totalSpent: "0.00",
        });
      }

      await tx.insert(walletTransactions).values([
        {
          userId: sourceUserId,
          type: "adjust" as const,
          amount: minorUnitsToDecimal(-wallet.leftMinor, WALLET_SPEC.scale),
          balanceBefore: walletSourceBefore,
          balanceAfter: "0.00",
          referenceType: FINANCIAL_REFERENCE_TYPE,
          referenceId: params.caseId,
          note: `Account merge #${params.caseId}: balance transferred to target ${targetUserId}`,
        },
        {
          userId: targetUserId,
          type: "adjust" as const,
          amount: walletSourceBefore,
          balanceBefore: walletTargetBefore,
          balanceAfter: walletTargetAfter,
          referenceType: FINANCIAL_REFERENCE_TYPE,
          referenceId: params.caseId,
          note: `Account merge #${params.caseId}: balance received from source ${sourceUserId}`,
        },
      ]);
    }

    maybeInjectFinancialFault("after_wallet");

    if (points.leftMinor > 0) {
      await tx
        .update(pointsAccounts)
        .set({ balance: "0.00", version: sql`${pointsAccounts.version} + 1` })
        .where(eq(pointsAccounts.userId, sourceUserId));
      await tx
        .update(pointsAccounts)
        .set({ balance: pointsTargetAfter, version: sql`${pointsAccounts.version} + 1` })
        .where(eq(pointsAccounts.userId, targetUserId));

      await tx.insert(pointsTransactions).values([
        {
          userId: sourceUserId,
          type: "adjust" as const,
          amount: minorUnitsToDecimal(-points.leftMinor, POINTS_SPEC.scale),
          balanceAfter: "0.00",
          referenceType: FINANCIAL_REFERENCE_TYPE,
          referenceId: params.caseId,
          effectKey: `account_merge:${params.caseId}:points_transfer`,
          note: `Account merge #${params.caseId}: points transferred to target ${targetUserId}`,
        },
        {
          userId: targetUserId,
          type: "adjust" as const,
          amount: pointsSourceBefore,
          balanceAfter: pointsTargetAfter,
          referenceType: FINANCIAL_REFERENCE_TYPE,
          referenceId: params.caseId,
          effectKey: `account_merge:${params.caseId}:points_transfer`,
          note: `Account merge #${params.caseId}: points received from source ${sourceUserId}`,
        },
      ]);
    }

    maybeInjectFinancialFault("after_points");
    maybeInjectFinancialFault("before_receipt");

    await tx.insert(accountMergeFinancialReconciliations).values({
      mergeCaseId: params.caseId,
      sourceUserId,
      targetUserId,
      actorAdminId: params.actorAdminId,
      walletSourceBefore,
      walletTargetBefore,
      walletTransferred: walletSourceBefore,
      walletSourceAfter: "0.00",
      walletTargetAfter,
      pointsSourceBefore,
      pointsTargetBefore,
      pointsTransferred: pointsSourceBefore,
      pointsSourceAfter: "0.00",
      pointsTargetAfter,
    });

    await tx.insert(accountMergeAuditLogs).values({
      mergeCaseId: params.caseId,
      actorAdminId: params.actorAdminId,
      action: "financial_reconciled",
      sourceUserId,
      targetUserId,
      safeMetadata: JSON.stringify({
        wallet: {
          sourceBefore: walletSourceBefore,
          targetBefore: walletTargetBefore,
          transferred: walletSourceBefore,
          sourceAfter: "0.00",
          targetAfter: walletTargetAfter,
        },
        points: {
          sourceBefore: pointsSourceBefore,
          targetBefore: pointsTargetBefore,
          transferred: pointsSourceBefore,
          sourceAfter: "0.00",
          targetAfter: pointsTargetAfter,
        },
      }),
    });

    const reconciliation = await readReceipt(params.caseId, tx);
    if (!reconciliation) {
      throw new AccountMergeFinancialError("RECEIPT_MISSING", "Financial reconciliation receipt was not persisted");
    }

  return { alreadyReconciled: false, reconciliation };
}

export async function reconcileAccountMergeFinancials(params: {
  caseId: number;
  actorAdminId: number;
}) {
  const database = await db.getDb();
  if (!database) throw new AccountMergeFinancialError("DATABASE_UNAVAILABLE", "Database unavailable");
  return database.transaction((tx: any) => reconcileAccountMergeFinancialsInTransaction(params, tx));
}
