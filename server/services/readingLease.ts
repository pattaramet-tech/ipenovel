import { and, eq, gt, sql } from "drizzle-orm";
import { authSessions, readingLeases } from "../../drizzle/schema";
import { READING_LEASE_TTL_SECONDS } from "../../shared/const";

/**
 * Reader Session Controls — the per-user paid-reading lease (R3 repairs
 * over R2; normative source: R1D B4/B5 + Independent Review items F1/F2).
 *
 * Invariants:
 *  - REAL locking SQL: every mutation opens a tx, locks the CALLER's
 *    authSessions row FOR UPDATE first (fresh status/owner/expiry under the
 *    lock — never a stale ctx snapshot), THEN locks the lease row FOR
 *    UPDATE (canonical order sessions → leases). Lease-only operations
 *    never take the slots lock (deadlock-safe).
 *  - Fencing: every transfer bumps leaseVersion; a renew presenting a stale
 *    version fails deterministically with LEASE_HELD/LEASE_LOST.
 *  - There is NO release API: the lease ends only by TTL expiry (DB time)
 *    or an explicit transfer (owner+version-checked).
 *  - An ABSENT lease row on transfer/acquire is created (typed outcome) —
 *    never a raw driver error / 500 (E1).
 *  - Expiry decisions compare against DB time via SQL NOW() predicates.
 */

async function getDbOrNull() {
  const { getDb } = await import("../db");
  return getDb();
}

export type LeaseOutcome =
  | { ok: true; leaseVersion: number; expiresAt: Date }
  | { ok: false; code: "SESSION_NOT_ACTIVE" | "LEASE_HELD" };

/**
 * F1/C2: lock the caller's session row FOR UPDATE and return its fresh
 * state. ctx.authSession is advisory only — lease decisions come from this
 * locked fresh row (status/owner/expiry all verified here).
 * R4/B: liveness is a DB-time predicate INSIDE the locking SELECT, so an
 * app/DB clock skew (±120s) can never renew/steal through an expired row.
 */
async function lockCallerSession(tx: any, params: { sessionId: number; userId: number }) {
  const [session] = await tx
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.id, params.sessionId), sql`${authSessions.expiresAt} > NOW()`))
    .for("update");
  if (!session || session.userId !== params.userId || session.status !== "active") {
    return null;
  }
  return session;
}

async function lockLeaseRow(tx: any, userId: number) {
  const [lease] = await tx
    .select()
    .from(readingLeases)
    .where(eq(readingLeases.userId, userId))
    .for("update");
  return lease ?? null;
}

/** R4/B: lease liveness decided by DB time (NOW()), never app wall clock. */
async function leaseIsLive(tx: any, userId: number): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(readingLeases)
    .where(and(eq(readingLeases.userId, userId), gt(readingLeases.expiresAt, sql`NOW()`)))
    .limit(1);
  return Boolean(row);
}

/**
 * R4/B: absent-lease race — two concurrent acquire/transfer calls may both
 * see no row; the loser's INSERT hits the userId PK. Typed handling: take
 * the update path instead. Never a raw driver error / 500.
 */
function isDuplicateKeyError(error: any): boolean {
  return (
    error?.errno === 1062 ||
    error?.code === "ER_DUP_ENTRY" ||
    (typeof error?.cause === "object" && isDuplicateKeyError(error.cause))
  );
}

/**
 * R4/IR-04: concurrent lease operations can deadlock at the absent-row gap
 * (insert-intention vs the other tx's locks). A deadlock victim's tx is
 * rolled back whole, so RETRYING the operation re-decides every step under
 * fresh locks — the loser then sees the winner's committed (live) row and
 * resolves to the typed LEASE_HELD outcome instead of a raw driver error.
 * Other errors are never retried. (drizzle wraps driver errors in `cause`.)
 */
function isDeadlockError(error: any): boolean {
  return (
    error?.errno === 1213 ||
    error?.code === "ER_LOCK_DEADLOCK" ||
    error?.sqlState === "40001" ||
    (typeof error?.cause === "object" && isDeadlockError(error.cause))
  );
}

async function withLeaseTxRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (isDeadlockError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function armExpiry(tx: any, userId: number) {
  return tx
    .update(readingLeases)
    .set({ expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND` })
    .where(eq(readingLeases.userId, userId));
}

export async function acquireLease(params: {
  sessionId: number;
  userId: number;
}): Promise<LeaseOutcome> {
  const db = await getDbOrNull();
  if (!db) return { ok: false, code: "SESSION_NOT_ACTIVE" };
  return withLeaseTxRetry(() =>
    db.transaction(async (tx: any) => {
    const session = await lockCallerSession(tx, params);
    if (!session) return { ok: false as const, code: "SESSION_NOT_ACTIVE" as const };

    const lease = await lockLeaseRow(tx, params.userId);
    if (lease && (await leaseIsLive(tx, params.userId))) {
      if (lease.holderSessionId === params.sessionId) {
        // Own live lease (e.g. another tab renewed): idempotent re-arm.
        await armExpiry(tx, params.userId);
        const [fresh] = await tx
          .select()
          .from(readingLeases)
          .where(eq(readingLeases.userId, params.userId))
          .for("update");
        return { ok: true as const, leaseVersion: fresh.leaseVersion, expiresAt: fresh.expiresAt };
      }
      // Another session's LIVE lease is never stolen by acquire (policy).
      return { ok: false as const, code: "LEASE_HELD" as const };
    }
    // No lease / expired lease: acquire (version fences any stale holder).
    if (lease) {
      await tx
        .update(readingLeases)
        .set({
          holderSessionId: params.sessionId,
          leaseVersion: sql`${readingLeases.leaseVersion} + 1`,
          acquiredAt: new Date(),
          expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
        })
        .where(eq(readingLeases.userId, params.userId));
    } else {
      try {
        await tx.insert(readingLeases).values({
          userId: params.userId,
          holderSessionId: params.sessionId,
          leaseVersion: 1,
          expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        await tx
          .update(readingLeases)
          .set({
            holderSessionId: params.sessionId,
            leaseVersion: sql`${readingLeases.leaseVersion} + 1`,
            acquiredAt: new Date(),
            expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
          })
          .where(eq(readingLeases.userId, params.userId));
      }
    }
    const [fresh] = await tx
      .select()
      .from(readingLeases)
      .where(eq(readingLeases.userId, params.userId))
      .for("update");
    return { ok: true as const, leaseVersion: fresh.leaseVersion, expiresAt: fresh.expiresAt };
  }));
}

export async function renewLease(params: {
  sessionId: number;
  userId: number;
  leaseVersion: number;
}): Promise<LeaseOutcome> {
  const db = await getDbOrNull();
  if (!db) return { ok: false, code: "SESSION_NOT_ACTIVE" };
  return withLeaseTxRetry(() =>
    db.transaction(async (tx: any) => {
    const session = await lockCallerSession(tx, params);
    if (!session) return { ok: false as const, code: "SESSION_NOT_ACTIVE" as const };

    const lease = await lockLeaseRow(tx, params.userId);
    if (
      !lease ||
      lease.holderSessionId !== params.sessionId ||
      lease.leaseVersion !== params.leaseVersion
    ) {
      // Displaced (or stale fencing) — the reader degrades to the transfer screen.
      return { ok: false as const, code: "LEASE_HELD" as const };
    }
    if (!(await leaseIsLive(tx, params.userId))) {
      // Lapsed (DB time): the caller must re-acquire (typed — never a raw
      // error), and an app/DB skew can never renew a lapsed lease.
      return { ok: false as const, code: "LEASE_HELD" as const };
    }
    await armExpiry(tx, params.userId);
    const [fresh] = await tx
      .select()
      .from(readingLeases)
      .where(eq(readingLeases.userId, params.userId))
      .for("update");
    return { ok: true as const, leaseVersion: fresh.leaseVersion, expiresAt: fresh.expiresAt };
  }));
}

/**
 * The explicit "ย้ายมาอ่านที่นี่" press: steals the live lease from another
 * session of the SAME account (version fences the displaced reader). An
 * ABSENT lease row is created here (E1: never a raw TypeError/500).
 */
export async function transferLease(params: {
  sessionId: number;
  userId: number;
}): Promise<LeaseOutcome> {
  const db = await getDbOrNull();
  if (!db) return { ok: false, code: "SESSION_NOT_ACTIVE" };
  return withLeaseTxRetry(() =>
    db.transaction(async (tx: any) => {
    const session = await lockCallerSession(tx, params);
    if (!session) return { ok: false as const, code: "SESSION_NOT_ACTIVE" as const };

    const lease = await lockLeaseRow(tx, params.userId);
    if (!lease) {
      try {
        await tx.insert(readingLeases).values({
          userId: params.userId,
          holderSessionId: params.sessionId,
          leaseVersion: 1,
          acquiredAt: new Date(),
          expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        await tx
          .update(readingLeases)
          .set({
            holderSessionId: params.sessionId,
            leaseVersion: sql`${readingLeases.leaseVersion} + 1`,
            acquiredAt: new Date(),
            expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
          })
          .where(eq(readingLeases.userId, params.userId));
      }
    } else {
      await tx
        .update(readingLeases)
        .set({
          holderSessionId: params.sessionId,
          leaseVersion: sql`${readingLeases.leaseVersion} + 1`,
          acquiredAt: lease.holderSessionId === params.sessionId ? lease.acquiredAt : new Date(),
          expiresAt: sql`NOW() + INTERVAL ${sql.raw(String(READING_LEASE_TTL_SECONDS))} SECOND`,
        })
        .where(eq(readingLeases.userId, params.userId));
    }
    const [fresh] = await tx
      .select()
      .from(readingLeases)
      .where(eq(readingLeases.userId, params.userId))
      .for("update");
    return { ok: true as const, leaseVersion: fresh.leaseVersion, expiresAt: fresh.expiresAt };
  }));
}

/**
 * R2 C4 — the ONE composed paid-read predicate (R1D Part A/F5), now with
 * F5's real-isFree semantics and strict session-state handling:
 *   PAID emission := entitled(existing per-surface guard, checked by the
 *   caller BEFORE this helper) AND mayIssuePaid(session, lease).
 * autoAcquire: C1 auto-acquires when no lease is held; C2/C3/C4/C5 do not.
 * A non-entitled session NEVER reaches this helper from C1 (its surface
 * returns the baseline locked preview before any lease is touched).
 */
export async function evaluatePaidRead(params: {
  user: { id: number; role: string } | null;
  authSession: import('../../drizzle/schema').AuthSession | null;
  isFree: boolean;
  autoAcquire: boolean;
}): Promise<
  | { allowed: true }
  | { allowed: false; code: 'SESSION_SLOT_PENDING' | 'SESSION_LEGACY_UNSLOTTED' | 'LEASE_HELD' | 'LEASE_REQUIRED' }
> {
  if (!params.isFree) {
    const flagOn = (await import('./sessionRegistry')).isReaderSessionControlsEnabled();
    if (flagOn) {
      if (!params.user) {
        return { allowed: false, code: 'LEASE_REQUIRED' };
      }
      if (!params.authSession || params.authSession.status === 'pending_choice') {
        return { allowed: false, code: 'SESSION_SLOT_PENDING' };
      }
      if (params.authSession.status === 'unslotted_legacy') {
        return { allowed: false, code: 'SESSION_LEGACY_UNSLOTTED' };
      }
      if (params.authSession.status !== 'active') {
        return { allowed: false, code: 'LEASE_REQUIRED' };
      }
      if (params.user.role === 'admin') {
        return { allowed: true };
      }
      if (await holdsActiveLease(params.authSession.id)) {
        return { allowed: true };
      }
      if (params.autoAcquire) {
        const acquired = await acquireLease({ sessionId: params.authSession.id, userId: params.user.id });
        if (acquired.ok) return { allowed: true };
        return { allowed: false, code: 'LEASE_HELD' };
      }
      return { allowed: false, code: 'LEASE_REQUIRED' };
    }
  }
  return { allowed: true };
}

/** Non-mutating read for predicates: does this session hold the live lease? */
export async function holdsActiveLease(sessionId: number): Promise<boolean> {
  const db = await getDbOrNull();
  if (!db) return false;
  const [lease] = await db
    .select({ holderSessionId: readingLeases.holderSessionId })
    .from(readingLeases)
    .where(and(eq(readingLeases.holderSessionId, sessionId), gt(readingLeases.expiresAt, sql`NOW()`)))
    .limit(1);
  return Boolean(lease);
}

/** Lease holder summary for the LEASE_HELD payload (display only). */
export async function getLeaseHolderSummary(userId: number) {
  const db = await getDbOrNull();
  if (!db) return null;
  const [row] = await db
    .select({
      holderSessionId: readingLeases.holderSessionId,
      leaseVersion: readingLeases.leaseVersion,
      expiresAt: readingLeases.expiresAt,
      clientLabel: authSessions.clientLabel,
      loginAt: authSessions.loginAt,
      lastSeenAt: authSessions.lastSeenAt,
    })
    .from(readingLeases)
    .innerJoin(authSessions, eq(readingLeases.holderSessionId, authSessions.id))
    .where(and(eq(readingLeases.userId, userId), gt(readingLeases.expiresAt, sql`NOW()`)))
    .limit(1);
  if (!row) return null;
  return row;
}

/** TTL constant re-export kept for typed surface parity with earlier rounds. */
export const LEASE_TTL_SECONDS = READING_LEASE_TTL_SECONDS;
