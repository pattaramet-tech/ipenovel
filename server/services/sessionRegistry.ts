import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { authSessions, readingLeases, sessionSlots } from "../../drizzle/schema";
import {
  SESSION_LASTSEEN_THROTTLE_SECONDS,
  SESSION_PENDING_CHOICE_TTL_SECONDS,
  SESSION_ROTATION_EXPIRY_GRACE_SECONDS,
  SESSION_SLOT_LIMIT,
} from "../../shared/const";

/**
 * Reader Session Controls — session registry (R3 repairs over R2).
 *
 * Normative source: DESIGN-READER-SESSION-CONTROLS-R1D.md + Independent
 * Review R2 items F1–F3/F6–F8. Invariants:
 *  - Terminal states (revoked/superseded) are PERMANENT. Every transition is
 *    a CONDITIONAL UPDATE guarded by the source status — a terminal row can
 *    never be moved by a concurrent promoter/reconciler (F2).
 *  - The registry IS the revocation floor: lookups here are NEVER flagged.
 *  - Canonical lock order: sessionSlots row (FOR UPDATE) → authSessions row
 *    (FOR UPDATE) → readingLeases. Every transition re-reads rows AFTER the
 *    lock (fresh rows only — stale pre-lock snapshots are never decisions,
 *    F2) and compares deadlines against DB time (NOW(), F7).
 *  - v2 tokens are identified by their `sid` claim (row must bind the SAME
 *    userId — owner binding, F6); legacy v1 cookies by tokenHash.
 *  - Adoption is IDEMPOTENT across concurrent tabs (F2): the insert runs
 *    inside the user-lock tx; a duplicate tokenHash re-selects the existing
 *    row instead of erroring, and never changes a terminal status.
 */

export type AuthSessionRow = typeof authSessions.$inferSelect;
export type AuthSessionStatus = AuthSessionRow["status"];

export function sha256Token(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSid(): string {
  return randomBytes(16).toString("base64url");
}

/** Reads the flag without caching: the operator can flip it without a restart. */
export function isReaderSessionControlsEnabled(): boolean {
  return process.env.READER_SESSION_CONTROLS === "true";
}

/**
 * R4/A: MySQL result tuple — drizzle mysql2 returns [OkPacket, fields] but
 * flat shapes have been observed across driver versions; parse BOTH so
 * durable-revoke/affected checks never silently read undefined as 0-success.
 */
function affectedOf(result: any): number {
  if (result == null) return 0;
  if (Array.isArray(result)) return Number(result[0]?.affectedRows ?? 0);
  if (typeof result.affectedRows === "number") return result.affectedRows;
  return 0;
}

async function getDbOrNull() {
  const { getDb } = await import("../db");
  return getDb();
}

/** Locks (creating if needed) the user's single sessionSlots row FOR UPDATE. */
async function lockUserSlotRow(db: any, userId: number) {
  await db
    .insert(sessionSlots)
    .values({ userId, activeCount: 0 })
    .onDuplicateKeyUpdate({ set: { userId } });
  const [row] = await db
    .select()
    .from(sessionSlots)
    .where(eq(sessionSlots.userId, userId))
    .for("update");
  return row;
}

/**
 * Authoritative active-session count, recomputed inside a user-lock tx.
 * R4/IR-04: the aggregate is a LOCKING read (FOR UPDATE) — a locking current
 * read sees the LATEST committed rows after this tx waited on the slots
 * lock; a plain REPEATABLE-READ snapshot taken before the wait could answer
 * with a stale quota count.
 */
async function countActive(db: any, userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.status, "active"),
        gt(authSessions.expiresAt, sql`NOW()`)
      )
    )
    .for("update");
  return Number(row?.n ?? 0);
}

/** Reads one row FOR UPDATE inside the caller's transaction (fresh rows only — F2). */
async function selectRowForUpdate(tx: any, sessionId: number): Promise<AuthSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .for("update");
  return row;
}

/**
 * R4/B: a pending row's stored deadline is computed BY THE DB —
 * LEAST(JWT exp, NOW + 30m) — never from app-wall-clock arithmetic, so an
 * app/DB skew cannot stretch (or shrink) the chooser window.
 */
function pendingExpirySql(jwtExpiresAt: Date) {
  return sql`LEAST(${jwtExpiresAt}, DATE_ADD(NOW(), INTERVAL ${sql.raw(String(SESSION_PENDING_CHOICE_TTL_SECONDS))} SECOND))`;
}

/**
 * Allocates a registry row for a freshly minted v2 cookie (F2/F6).
 * Flag ON: lock slots row → (optional guarded rotation supersede) → recount
 * → status active|pending_choice; a pending row's deadline is
 * min(JWT exp, NOW + 30m). Flag OFF: still `active` (revocation floor needs
 * the row), quota unenforced, never pending.
 */
export async function allocateSessionRow(params: {
  userId: number;
  token: string;
  sid: string;
  expiresAt: Date;
  createdVia: "google" | "manus" | "offpath";
  clientLabel?: string | null;
  adoptOf?: number | null;
  rotateRowId?: number | null;
}): Promise<AuthSessionRow> {
  const db = await getDbOrNull();
  if (!db) throw new Error("Database not available");
  const tokenHash = sha256Token(params.token);
  const flagOn = isReaderSessionControlsEnabled();

  return db.transaction(async (tx: any) => {
    if (flagOn) await lockUserSlotRow(tx, params.userId);

    if (params.rotateRowId) {
      // F3 fast path — guarded supersede: ONLY an active, unexpired row of
      // the same owner may free its slot (conditional UPDATE, F2). R4/F: a
      // displaced-by-rotation holder's lease dies in the SAME tx (v++),
      // under the canonical slots→sessions→leases lock order.
      const superseded = await tx
        .update(authSessions)
        .set({ status: "superseded", revokedReason: "by_rotation" })
        .where(
          and(
            eq(authSessions.id, params.rotateRowId),
            eq(authSessions.userId, params.userId),
            eq(authSessions.status, "active"),
            gt(authSessions.expiresAt, sql`NOW()`)
          )
        );
      if (affectedOf(superseded) > 0) {
        await tx
          .update(readingLeases)
          .set({ leaseVersion: sql`${readingLeases.leaseVersion} + 1`, expiresAt: sql`NOW()` })
          .where(eq(readingLeases.holderSessionId, params.rotateRowId));
      }
    }

    let status: AuthSessionStatus = "active";
    let expiresAt: AuthSessionRow["expiresAt"] | ReturnType<typeof pendingExpirySql> = params.expiresAt;
    if (flagOn) {
      const activeCount = await countActive(tx, params.userId);
      status = activeCount < SESSION_SLOT_LIMIT ? "active" : "pending_choice";
      if (status === "pending_choice") {
        // R4/B/C: deadline computed by the DB (LEAST), never app arithmetic.
        expiresAt = pendingExpirySql(params.expiresAt);
      }
      await tx
        .update(sessionSlots)
        .set({ activeCount: status === "active" ? activeCount + 1 : activeCount })
        .where(eq(sessionSlots.userId, params.userId));
    }

    const [row] = await tx
      .insert(authSessions)
      .values({
        userId: params.userId,
        sid: params.sid,
        tokenHash,
        tokenVersion: 2,
        status,
        loginAt: new Date(),
        expiresAt: expiresAt as AuthSessionRow["expiresAt"],
        createdVia: params.createdVia,
        clientLabel: params.clientLabel ?? null,
        adoptOf: params.adoptOf ?? null,
      })
      .$returningId();
    const [full] = await tx.select().from(authSessions).where(eq(authSessions.id, row.id));
    return full;
  });
}

/** Looks up a session row by the raw cookie (v2 via sid claim, v1 via tokenHash). */
export async function findSessionByCookie(params: {
  token: string;
  sid: string | null;
}): Promise<AuthSessionRow | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  if (params.sid) {
    const [row] = await db.select().from(authSessions).where(eq(authSessions.sid, params.sid)).limit(1);
    return row ?? null;
  }
  const tokenHash = sha256Token(params.token);
  const [row] = await db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/**
 * Adoption of a legacy v1 cookie (F2 idempotency repair): the pre-check and
 * insert run INSIDE the user-lock tx; a concurrent adoption of the same
 * cookie serializes on the slot lock, and a lost UNIQUE(tokenHash) race
 * re-selects the EXISTING row instead of erroring or creating a second row.
 * The existing row's status is returned as-is — adoption never changes a
 * terminal state.
 */
export async function adoptLegacySession(params: {
  userId: number;
  token: string;
  expiresAt: Date;
  clientLabel?: string | null;
}): Promise<AuthSessionRow | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  const tokenHash = sha256Token(params.token);
  const [precheck] = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.tokenHash, tokenHash))
    .limit(1);
  if (precheck) return precheck;

  if (!isReaderSessionControlsEnabled()) return null;

  const sid = generateSid();
  try {
    return await db.transaction(async (tx: any) => {
      await lockUserSlotRow(tx, params.userId);
      // F2: re-check INSIDE the lock — a concurrent tab may have adopted
      // this exact cookie while we waited.
      const [existing] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.tokenHash, tokenHash))
        .limit(1);
      if (existing) return existing;
      const activeCount = await countActive(tx, params.userId);
      const status: AuthSessionStatus = activeCount < SESSION_SLOT_LIMIT ? "active" : "unslotted_legacy";
      const [created] = await tx
        .insert(authSessions)
        .values({
          userId: params.userId,
          sid,
          tokenHash,
          tokenVersion: 1,
          status,
          loginAt: new Date(),
          expiresAt: params.expiresAt,
          createdVia: "adoption",
          clientLabel: params.clientLabel ?? null,
        })
        .$returningId();
      if (status === "active") {
        await tx
          .update(sessionSlots)
          .set({ activeCount: activeCount + 1 })
          .where(eq(sessionSlots.userId, params.userId));
      }
      const [full] = await tx.select().from(authSessions).where(eq(authSessions.id, created.id));
      return full;
    });
  } catch (error: any) {
    // Lost the UNIQUE(tokenHash) race to a concurrent tab — the winner's row
    // is THE adoption result (idempotent), never an error surfaced to login.
    if (error?.code === "ER_DUP_ENTRY") {
      const [existing] = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.tokenHash, tokenHash))
        .limit(1);
      return existing ?? null;
    }
    throw error;
  }
}

/**
 * C1 promotion (F2 conditional-update repair): an unslotted_legacy row
 * becomes active ONLY via a status-guarded UPDATE inside the user-lock tx —
 * a row that concurrently became revoked/superseded can NEVER be revived.
 */
export async function maybePromoteUnslotted(sessionId: number): Promise<AuthSessionRow | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  const [row] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId)).limit(1);
  if (!row) return null;
  if (row.status === "revoked" || row.status === "superseded") return row; // terminal — no revive
  if (row.status !== "unslotted_legacy") return row;
  if (!isReaderSessionControlsEnabled()) {
    // Flag OFF: no quota concept — but still only FROM unslotted_legacy.
    await db
      .update(authSessions)
      .set({ status: "active" })
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.status, "unslotted_legacy")));
    return (await db.select().from(authSessions).where(eq(authSessions.id, sessionId)).limit(1))[0] ?? null;
  }
  return db.transaction(async (tx: any) => {
    await lockUserSlotRow(tx, row.userId);
    // F2: re-read FRESH after the lock — a concurrent revoke/rotation may
    // have moved the row while we waited for the slots lock.
    const [fresh] = await tx.select().from(authSessions).where(eq(authSessions.id, sessionId)).for("update");
    if (!fresh || fresh.status !== "unslotted_legacy") return fresh ?? null;
    const activeCount = await countActive(tx, row.userId);
    if (activeCount < SESSION_SLOT_LIMIT) {
      await tx
        .update(authSessions)
        .set({ status: "active" })
        .where(and(eq(authSessions.id, sessionId), eq(authSessions.status, "unslotted_legacy")));
      await tx
        .update(sessionSlots)
        .set({ activeCount: activeCount + 1 })
        .where(eq(sessionSlots.userId, row.userId));
    }
    const [full] = await tx.select().from(authSessions).where(eq(authSessions.id, sessionId));
    return full ?? null;
  });
}

/**
 * R8B-4C — slot recovery: a pending_choice session claims a FREED slot on
 * its own next authenticated request, WITHOUT displacing any live session.
 *
 * Invariants carried over unchanged:
 *  - Terminal states are PERMANENT: activation is a CONDITIONAL UPDATE from
 *    `pending_choice` only — a row concurrently revoked/superseded can never
 *    be revived (durable revocation floor, F2).
 *  - Pending expiry is a DB-time fact (F7): a chooser window that elapsed
 *    while every slot was taken flips to superseded(expired), never active.
 *  - Canonical lock order + fresh locked reads (F2): sessionSlots row FOR
 *    UPDATE → authSessions row FOR UPDATE → decisions; quota is a LOCKING
 *    recount (R4/IR-04) so a concurrent login/claim/rotation that waited on
 *    the slots lock can never push active past SESSION_SLOT_LIMIT.
 *  - R4/C: the activated row inherits the caller's VERIFIED JWT expiry —
 *    claiming the slot never cuts the session at the 30-minute window.
 *  - Flag OFF: the choose-a-session concept vanishes (the pending gate is
 *    flag-gated too), so the row promotes via a status-guarded update with
 *    the verified exp; sessionSlots stays untouched while OFF (mirrors
 *    allocateSessionRow's OFF path).
 */
export async function maybeActivatePending(params: {
  sessionId: number;
  activateExpiresAt: Date;
}): Promise<AuthSessionRow | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  const [row] = await db.select().from(authSessions).where(eq(authSessions.id, params.sessionId)).limit(1);
  if (!row) return null;
  if (row.status !== "pending_choice") return row;
  // A caller whose verified JWT is already expired (or malformed) cannot
  // claim a slot — the activated cookie would outlive nothing (F7/DB time
  // still re-checks the deadline inside the tx below).
  if (
    !Number.isFinite(params.activateExpiresAt.getTime()) ||
    params.activateExpiresAt.getTime() <= Date.now()
  ) {
    return row;
  }
  if (!isReaderSessionControlsEnabled()) {
    await db
      .update(authSessions)
      .set({ status: "active", expiresAt: params.activateExpiresAt })
      .where(and(eq(authSessions.id, params.sessionId), eq(authSessions.status, "pending_choice")));
    return (await db.select().from(authSessions).where(eq(authSessions.id, params.sessionId)).limit(1))[0] ?? null;
  }
  return db.transaction(async (tx: any) => {
    await lockUserSlotRow(tx, row.userId);
    // F2: fresh locked read AFTER the slots lock — a concurrent logout /
    // rotation / revoke may have moved the row while we waited.
    const [fresh] = await tx
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, params.sessionId))
      .for("update");
    if (!fresh || fresh.status !== "pending_choice") return fresh ?? null;
    // F7: DB-time expiry — the chooser window elapsed → expired, never active.
    const [expiredNow] = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, fresh.id), sql`${authSessions.expiresAt} <= NOW()`))
      .for("update");
    if (expiredNow) {
      await tx
        .update(authSessions)
        .set({ status: "superseded", revokedReason: "expired" })
        .where(and(eq(authSessions.id, fresh.id), eq(authSessions.status, "pending_choice")));
      const [flipped] = await tx.select().from(authSessions).where(eq(authSessions.id, fresh.id));
      return flipped ?? null;
    }
    // R4/IR-04: locking recount decides AFTER the wait on the slots lock —
    // a concurrent login that took the last slot makes this claim a no-op
    // (the chooser stays; displacement via resolveThirdLogin is unchanged).
    const activeCount = await countActive(tx, fresh.userId);
    if (activeCount >= SESSION_SLOT_LIMIT) return fresh;
    const activated = await tx
      .update(authSessions)
      .set({ status: "active", expiresAt: params.activateExpiresAt })
      .where(and(eq(authSessions.id, fresh.id), eq(authSessions.status, "pending_choice")));
    if (affectedOf(activated) === 0) {
      // Unreachable while the row lock is held — kept as a truth-teller.
      const [current] = await tx.select().from(authSessions).where(eq(authSessions.id, fresh.id));
      return current ?? null;
    }
    await tx
      .update(sessionSlots)
      .set({ activeCount: activeCount + 1 })
      .where(eq(sessionSlots.userId, fresh.userId));
    const [full] = await tx.select().from(authSessions).where(eq(authSessions.id, fresh.id));
    return full ?? null;
  });
}

/** Throttled lastSeenAt (≥60s apart) — a small authSessions write, never the users row. */
export async function touchLastSeen(sessionId: number): Promise<void> {
  const db = await getDbOrNull();
  if (!db) return;
  await db
    .update(authSessions)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(authSessions.id, sessionId),
        sql`(${authSessions.lastSeenAt} IS NULL OR ${authSessions.lastSeenAt} < NOW() - INTERVAL ${sql.raw(String(SESSION_LASTSEEN_THROTTLE_SECONDS))} SECOND)`
      )
    );
}

/**
 * R3/F7 — DB-time row expiry: flips a non-terminal row past its deadline
 * to superseded(expired) via a status-guarded conditional UPDATE (DB time).
 * Returns true when THIS call flipped the row (caller must then reject).
 */
export async function expireRowIfPastDeadline(sessionId: number): Promise<boolean> {
  const db = await getDbOrNull();
  if (!db) return false;
  const result = await db
    .update(authSessions)
    .set({ status: "superseded", revokedReason: "expired" })
    .where(
      and(
        eq(authSessions.id, sessionId),
        inArray(authSessions.status, ["active", "pending_choice", "unslotted_legacy"]),
        sql`${authSessions.expiresAt} <= NOW()`
      )
    );
  const affected = affectedOf(result);
  return affected > 0;
}

/** R4/A: fresh post-transition read (e.g. rights decided AFTER reconcile). */
export async function getSessionRowById(sessionId: number): Promise<AuthSessionRow | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  const [row] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId)).limit(1);
  return row ?? null;
}
/** Current logins for the owner of the account: active + pending, newest first. */
export async function listUserSessions(userId: number, currentSessionId: number | null) {
  const db = await getDbOrNull();
  if (!db) return [];
  const rows = await db
    .select({
      id: authSessions.id,
      status: authSessions.status,
      loginAt: authSessions.loginAt,
      lastSeenAt: authSessions.lastSeenAt,
      clientLabel: authSessions.clientLabel,
      createdVia: authSessions.createdVia,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        inArray(authSessions.status, ["active", "pending_choice", "unslotted_legacy"])
      )
    )
    .orderBy(sql`${authSessions.loginAt} DESC`);
  return rows.map(row => ({ ...row, current: row.id === currentSessionId }));
}

/**
 * Third-login chooser resolution (F2 fresh-row repair): the caller row is
 * re-read FOR UPDATE after the slots lock — its pending status, expiry (DB
 * time) and every state move are decided from the locked fresh row with
 * status-guarded conditional updates.
 *
 * R4/C: activation also REPLACES the stored deadline with the caller's own
 * verified JWT expiry (`activateExpiresAt`) — a resolved login is never cut
 * at the 30-minute pending window.
 * R4/F: the displaced session's lease dies in the SAME tx (v++), after the
 * sessions lock, per the canonical lock order.
 */
export async function resolveThirdLogin(params: {
  callerSessionId: number;
  displaceSessionId: number;
  activateExpiresAt: Date;
}): Promise<
  | { ok: true; session: AuthSessionRow }
  | { ok: false; code: "NOT_PENDING" | "KEEP_NOT_FOUND" | "EXPIRED" }
> {
  const db = await getDbOrNull();
  if (!db) return { ok: false, code: "NOT_PENDING" };
  if (!Number.isFinite(params.activateExpiresAt.getTime()) || params.activateExpiresAt.getTime() <= Date.now()) {
    // A caller whose verified JWT is already expired (or malformed) cannot
    // activate into an active row — the cookie would outlive nothing.
    return { ok: false, code: "EXPIRED" };
  }
  return db.transaction(async (tx: any) => {
    // Locate the caller (plain snapshot — only to find the lock target).
    const [locator] = await tx
      .select({ id: authSessions.id, userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.id, params.callerSessionId));
    if (!locator) return { ok: false as const, code: "NOT_PENDING" as const };
    await lockUserSlotRow(tx, locator.userId);
    // F2: fresh locked read AFTER the slots lock (stale snapshot guard).
    const caller = await selectRowForUpdate(tx, params.callerSessionId);
    if (!caller || caller.status !== "pending_choice") {
      return { ok: false as const, code: "NOT_PENDING" as const };
    }
    // F7: expiry against DB time. R4/IR-04: locking read — the decision
    // must see the LATEST committed state after waiting on the slots lock,
    // not this tx's pre-wait REPEATABLE-READ snapshot.
    const [expiredNow] = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, caller.id), sql`${authSessions.expiresAt} <= NOW()`))
      .for("update");
    if (expiredNow) {
      await tx
        .update(authSessions)
        .set({ status: "superseded", revokedReason: "expired" })
        .where(and(eq(authSessions.id, caller.id), eq(authSessions.status, "pending_choice")));
      return { ok: false as const, code: "EXPIRED" as const };
    }
    // R4/F2: fresh locked read of the keep-row too — a pre-lock snapshot
    // must never decide the displacement.
    const keep = await selectRowForUpdate(tx, params.displaceSessionId);
    if (!keep || keep.userId !== caller.userId) {
      return { ok: false as const, code: "KEEP_NOT_FOUND" as const };
    }
    if (keep.status === "active" || keep.status === "pending_choice" || keep.status === "unslotted_legacy") {
      // DB-time guard lives in the UPDATE itself: an already-expired row is
      // left exactly as the expirer wrote it.
      const displaced = await tx
        .update(authSessions)
        .set({ status: "superseded", revokedReason: "displaced_by_login" })
        .where(
          and(
            eq(authSessions.id, keep.id),
            inArray(authSessions.status, ["active", "pending_choice", "unslotted_legacy"]),
            sql`${authSessions.expiresAt} > NOW()`
          )
        );
      if (affectedOf(displaced) > 0) {
        await tx
          .update(readingLeases)
          .set({ leaseVersion: sql`${readingLeases.leaseVersion} + 1`, expiresAt: sql`NOW()` })
          .where(eq(readingLeases.holderSessionId, keep.id));
      }
    }
    const activeCount = await countActive(tx, caller.userId);
    if (activeCount >= SESSION_SLOT_LIMIT) {
      return { ok: false as const, code: "NOT_PENDING" as const };
    }
    // R4/C: the activated row inherits the VERIFIED JWT expiry — the 30m
    // pending cut stops at resolution.
    await tx
      .update(authSessions)
      .set({ status: "active", expiresAt: params.activateExpiresAt })
      .where(and(eq(authSessions.id, caller.id), eq(authSessions.status, "pending_choice")));
    await tx
      .update(sessionSlots)
      .set({ activeCount: activeCount + 1 })
      .where(eq(sessionSlots.userId, caller.userId));
    const [full] = await tx.select().from(authSessions).where(eq(authSessions.id, caller.id));
    return { ok: true as const, session: full };
  });
}

/**
 * Self-revoke (F2): status-guarded conditional update — a row that
 * concurrently rotated/turned terminal is left exactly as the winner wrote
 * it. A lease held by the revoked session dies in the same tx (v++).
 */
export async function revokeOwnSession(params: { userId: number; sessionId: number }): Promise<boolean> {
  const db = await getDbOrNull();
  if (!db) return false;
  return db.transaction(async (tx: any) => {
    const row = await selectRowForUpdate(tx, params.sessionId);
    if (!row || row.userId !== params.userId) return false;
    if (row.status === "revoked" || row.status === "superseded") return true;
    const updated = await tx
      .update(authSessions)
      .set({ status: "revoked", revokedReason: "admin_revoke" })
      .where(
        and(
          eq(authSessions.id, params.sessionId),
          inArray(authSessions.status, ["active", "pending_choice", "unslotted_legacy"])
        )
      );
    const affected = affectedOf(updated);
    if (affected > 0) {
      await tx
        .update(readingLeases)
        .set({ leaseVersion: sql`${readingLeases.leaseVersion} + 1`, expiresAt: sql`NOW()` })
        .where(eq(readingLeases.holderSessionId, params.sessionId));
    }
    return true;
  });
}

/**
 * Marks the caller's own row revoked at logout (the revocation floor).
 * R4/F: the logout terminal transition also kills the holder's lease in the
 * SAME tx (v++) — a logged-out session never keeps reading rights past the
 * logout, and concurrent lease renewals lose the version race.
 * R4/IR-03: the outcome is REPORTED, never swallowed —
 *   "revoked"    = the durable registry write happened (or the row was
 *                  already terminal, i.e. revocation already holds);
 *   "not_found"  = no durable registry row backs this cookie value;
 *   "unavailable"= the registry store is unreachable (no write happened).
 * Driver-level errors throw (the caller maps them to "unconfirmed").
 */
export async function revokeByToken(
  token: string
): Promise<"revoked" | "not_found" | "unavailable"> {
  const db = await getDbOrNull();
  if (!db) return "unavailable";
  const tokenHash = sha256Token(token);
  return db.transaction(async (tx: any): Promise<"revoked" | "not_found"> => {
    const [row] = await tx
      .select({ id: authSessions.id, status: authSessions.status })
      .from(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash))
      .for("update");
    if (!row) return "not_found";
    if (row.status === "revoked" || row.status === "superseded") {
      // Already terminal — durable revocation already holds.
      return "revoked";
    }
    const updated = await tx
      .update(authSessions)
      .set({ status: "revoked", revokedReason: "user_logout" })
      .where(
        and(
          eq(authSessions.id, row.id),
          inArray(authSessions.status, ["active", "pending_choice", "unslotted_legacy"])
        )
      );
    if (affectedOf(updated) > 0) {
      await tx
        .update(readingLeases)
        .set({ leaseVersion: sql`${readingLeases.leaseVersion} + 1`, expiresAt: sql`NOW()` })
        .where(eq(readingLeases.holderSessionId, row.id));
      return "revoked";
    }
    // A concurrent transition moved the row between the lock and the write.
    // Re-read under the same tx to report the truth.
    const [fresh] = await tx
      .select({ status: authSessions.status })
      .from(authSessions)
      .where(eq(authSessions.id, row.id));
    return fresh && (fresh.status === "revoked" || fresh.status === "superseded")
      ? "revoked"
      : "not_found";
  });
}

/**
 * OFF→ON reconciliation (C3): keep the two most-recently-seen active rows,
 * demote the rest to unslotted_legacy via status-guarded per-row updates.
 * Deterministic, idempotent, never revokes.
 */
export async function reconcileAfterFlagOn(userId: number): Promise<void> {
  const db = await getDbOrNull();
  if (!db) return;
  await db.transaction(async (tx: any) => {
    await lockUserSlotRow(tx, userId);
    const rows = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          eq(authSessions.status, "active"),
          gt(authSessions.expiresAt, sql`NOW()`)
        )
      )
      .orderBy(sql`${authSessions.lastSeenAt} DESC`, sql`${authSessions.loginAt} DESC`, sql`${authSessions.id} ASC`);
    if (rows.length <= SESSION_SLOT_LIMIT) return;
    const excess = rows.slice(SESSION_SLOT_LIMIT).map((r: any) => r.id);
    for (const id of excess) {
      // Status-guarded: a row moved elsewhere concurrently is left alone.
      await tx
        .update(authSessions)
        .set({ status: "unslotted_legacy" })
        .where(and(eq(authSessions.id, id), eq(authSessions.status, "active")));
    }
    await tx
      .update(sessionSlots)
      .set({ activeCount: SESSION_SLOT_LIMIT })
      .where(eq(sessionSlots.userId, userId));
  });
}

/** True when the caller's session currently holds the user's live lease. */
export async function sessionHoldsLease(sessionId: number): Promise<boolean> {
  const db = await getDbOrNull();
  if (!db) return false;
  const [row] = await db
    .select({ id: readingLeases.userId })
    .from(readingLeases)
    .where(
      and(
        eq(readingLeases.holderSessionId, sessionId),
        gt(readingLeases.expiresAt, sql`NOW()`)
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Same-account rotation lookup (F7): usability decided by a DB-time
 * predicate — `status='active' AND expiresAt > NOW() - grace`.
 */
export async function findRotatableRow(params: {
  userId: number;
  sid: string | null;
  token: string;
}): Promise<number | null> {
  const db = await getDbOrNull();
  if (!db) return null;
  const graceSeconds = Math.max(1, SESSION_ROTATION_EXPIRY_GRACE_SECONDS);
  if (params.sid) {
    const [row] = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.sid, params.sid),
          eq(authSessions.userId, params.userId),
          eq(authSessions.status, "active"),
          sql`${authSessions.expiresAt} > NOW() - INTERVAL ${sql.raw(String(graceSeconds))} SECOND`
        )
      )
      .limit(1);
    return row?.id ?? null;
  }
  const tokenHash = sha256Token(params.token);
  const [row] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        eq(authSessions.userId, params.userId),
        eq(authSessions.status, "active"),
        sql`${authSessions.expiresAt} > NOW() - INTERVAL ${sql.raw(String(graceSeconds))} SECOND`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/** Display-only label from the login User-Agent (never an authority). */
export function labelFromUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = String(userAgent).slice(0, 200);
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device";
}
