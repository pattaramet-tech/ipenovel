import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { getTestDb } from "./test-helpers/testDb";
import { __setDbForTests } from "./db";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import type { TrpcContext } from "./_core/context";
import * as registry from "./services/sessionRegistry";
import * as leaseService from "./services/readingLease";
import { SignJWT } from "jose";
import { authSessions, readingLeases, sessionSlots, users } from "../drizzle/schema";

/**
 * R4 barrier proofs (R3-A..G repair) — the two-connection / terminal
 * transition / strict-claim behaviors the R4 brief enumerates:
 *
 *  A1  reconcile-before-rights runs on the FIRST real request after OFF→ON
 *      even when lastSeen is fresh (the old throttle-gated hook skipped it),
 *      and the request's rights are decided from the POST-reconcile status.
 *  B1  DB-time expiry under the locks: a DB-expired session can never
 *      renew/acquire (typed SESSION_NOT_ACTIVE); a lapsed lease renews only
 *      as a typed failure, then re-acquires cleanly.
 *  B2  absent-lease race: concurrent transfer+acquire over NO lease row both
 *      resolve typed (no raw ER_DUP_ENTRY), one row, consistent version.
 *  C2  strict claim validation BEFORE any legacy/v2 branch: short/malformed
 *      sid and a signature-valid token with NO exp are structural failures.
 *  E2  pending allowlist positives: list/me still work for a pending caller
 *      (revoke blocked — proven in readerSessionR4Repair).
 *  F1  chooser displacement kills the displaced session's lease in the SAME
 *      tx (version bump) — the displaced reader's renew loses typed.
 *  F2  logout (revokeByToken) kills the holder's lease in the SAME tx.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("no id");
  return id;
}

/**
 * R4R4/IR-04 — ATTRIBUTABLE wait-reached evidence. The global
 * `INNODB_TRX WHERE trx_state='LOCK WAIT'` count used in R4R3 could be
 * satisfied by waiters unrelated to this test. This version queries
 * `sys.innodb_lock_waits` and filters on `blocking_pid = CONNECTION_ID()` of
 * the RAW BLOCKER CONNECTION — so the observed waiters are provably blocked
 * BY THIS TEST'S blocker transaction (the one holding the row lock we are
 * about to release). Evidence rows (waiting/blocking pid+trx, lock
 * table/index/type) are returned and asserted by callers.
 */
type LockWaitEvidence = {
  wait_pid: string | number;
  wait_trx: string;
  block_pid: string | number;
  lock_table: string;
  lock_type: string;
  lock_index: string | null;
};

async function attributableLockWaits(raw: mysql.Connection): Promise<LockWaitEvidence[]> {
  const [rows] = await raw.query(
    `SELECT waiting_pid AS wait_pid, waiting_trx_id AS wait_trx,
            blocking_pid AS block_pid,
            locked_table_schema AS lock_schema, locked_table_name AS lock_table,
            locked_type AS lock_type, locked_index AS lock_index
     FROM sys.innodb_lock_waits
     WHERE blocking_pid = CONNECTION_ID()`
  );
  return (rows as any[]).map(r => ({
    wait_pid: r.wait_pid,
    wait_trx: String(r.wait_trx ?? ""),
    block_pid: r.block_pid,
    lock_table: r.lock_schema ? `${r.lock_schema}.${r.lock_table}` : String(r.lock_table),
    lock_type: String(r.lock_type ?? ""),
    lock_index: r.lock_index ?? null,
  }));
}

/**
 * Poll until `expected` connections are provably blocked BY THIS raw
 * connection's lock (attributable relation), bounded at 15s. Returns the
 * observed evidence; throws with the last observed state on timeout — the
 * test fails rather than passing on unrelated waiters or un-dispatched SQL.
 */
async function waitForLockWaiters(
  raw: mysql.Connection,
  expected: number,
  label: string,
  tableHint?: string
): Promise<LockWaitEvidence[]> {
  const deadline = Date.now() + 15000;
  let last: LockWaitEvidence[] = [];
  while (Date.now() < deadline) {
    last = await attributableLockWaits(raw);
    if (tableHint) {
      const matching = last.filter(w => w.lock_table.includes(tableHint));
      if (matching.length >= expected) return matching;
    } else if (last.length >= expected) {
      return last;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = last.map(w => `${w.wait_pid}→${w.block_pid} on ${w.lock_table}`).join("; ") || "none";
  throw new Error(
    `ATTRIBUTABLE wait-reached barrier NOT observed for ${label}: expected >=${expected} waiters blocked by this connection (raw id) on ${tableHint ?? "any table"} within 15s. Observed: ${seen}`
  );
}

describe("R4 Reader Session Controls — barrier proofs", () => {
  function setFlagTrue() { process.env.READER_SESSION_CONTROLS = "true"; }
  function setFlagFalse() { process.env.READER_SESSION_CONTROLS = "false"; }
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  let userA = 0;
  const sessionIds: number[] = [];

  beforeAll(async () => {
    __setDbForTests(db);
    userA = insertId(await db.insert(users).values({
      openId: `r4b-${tag}`,
      name: "R4 Barrier",
      email: `r4b-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
  });

  afterAll(async () => {
    setFlagFalse();
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    await db.delete(authSessions).where(eq(authSessions.userId, userA));
    await db.delete(sessionSlots).where(eq(sessionSlots.userId, userA));
    await db.delete(users).where(eq(users.id, userA));
  });

  /** Pre-ON-shaped active row: inserted directly (no allocator, no slots). */
  async function rawActiveSession(params?: { lastSeenAt?: Date | null }) {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
    const [row] = await db.insert(authSessions).values({
      userId: userA,
      sid,
      tokenHash: registry.sha256Token(token),
      tokenVersion: 2,
      status: "active",
      loginAt: new Date(),
      lastSeenAt: params?.lastSeenAt ?? null,
      expiresAt: new Date(Date.now() + 30 * 86400000),
      createdVia: "google",
    }).$returningId();
    const id = Number(row.id);
    sessionIds.push(id);
    return { id, sid, token };
  }

  async function holderLease(sessionId: number) {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    await db.insert(readingLeases).values({
      userId: userA,
      holderSessionId: sessionId,
      leaseVersion: 7,
      acquiredAt: new Date(),
      expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
    });
  }

  /** Isolate each test: drop the user's sessions/lease (state bleed guard). */
  async function wipeUser() {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    await db.delete(authSessions).where(eq(authSessions.userId, userA));
    await db.delete(sessionSlots).where(eq(sessionSlots.userId, userA));
    sessionIds.length = 0;
  }

  it("R4-A1: reconcile-before-rights fires on the FIRST request after ON with a FRESH lastSeen — excess demoted, status returned post-reconcile", async () => {
    setFlagTrue();
    await wipeUser();
    // 4 standing actives existed before the flip; the caller's lastSeen is
    // fresh (NOW) — the old throttle-gated hook (touchLastSeenAndMark) would
    // have reported "throttle not elapsed" and SKIPPED reconcile entirely.
    const caller = await rawActiveSession({ lastSeenAt: new Date() });
    const newer = await rawActiveSession({ lastSeenAt: new Date(Date.now() - 3600_000) });
    await rawActiveSession({ lastSeenAt: new Date(Date.now() - 7200_000) });
    await rawActiveSession({ lastSeenAt: new Date(Date.now() - 10800_000) });

    const result = await sdk.authenticateRequestWithSession({
      headers: { cookie: `app_session_id=${caller.token}` },
    } as any);

    // Reconciliation ran: exactly the two most-recently-seen rows survive.
    const activeRows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userA), eq(authSessions.status, "active"), gt(authSessions.expiresAt, sql`NOW()`)));
    expect(activeRows.length).toBe(2);
    expect(activeRows.map(r => r.id).sort((a, b) => a - b)).toEqual([caller.id, newer.id].sort((a, b) => a - b));

    // The request's rights come from the POST-reconcile row (fresh read),
    // identical to what the DB now holds for the caller.
    expect(result.sessionRow?.id).toBe(caller.id);
    expect(result.sessionRow?.status).toBe("active");
  });

  it("R4-B1: DB-expired session cannot renew (typed); lapsed lease renews typed-fail then re-acquires", async () => {
    setFlagTrue();
    await wipeUser();
    const s1 = await rawActiveSession();
    const s2 = await rawActiveSession();
    await holderLease(s2.id);

    // (a) caller's session row expired by DB time → typed SESSION_NOT_ACTIVE,
    // never a success and never a raw error.
    await db
      .update(authSessions)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(authSessions.id, s1.id));
    const expiredRenew = await leaseService.renewLease({ sessionId: s1.id, userId: userA, leaseVersion: 7 });
    expect(expiredRenew).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" });

    // (b) lapsed lease (DB time): renew with the holder's own version is a
    // typed failure (must re-acquire), not a silent extension.
    await db
      .update(readingLeases)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(readingLeases.userId, userA));
    const lapsed = await leaseService.renewLease({ sessionId: s2.id, userId: userA, leaseVersion: 7 });
    expect(lapsed).toMatchObject({ ok: false, code: "LEASE_HELD" });

    // (c) re-acquire after lapse succeeds (DB-time expiry recognized).
    const reAcquired = await leaseService.acquireLease({ sessionId: s2.id, userId: userA });
    expect(reAcquired.ok).toBe(true);
  });

  it("R4-IR-04a: absent-lease BARRIER — a real gap-lock interleave forces both operations through the absent-row path; every outcome typed, exactly one row", async () => {
    setFlagTrue();
    await wipeUser();
    const s1 = await rawActiveSession();
    const s2 = await rawActiveSession();
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));

    // Deterministic two-connection barrier (the pattern RC uses): a raw
    // connection pins the PK gap over the ABSENT lease row, so BOTH
    // operations must queue on lockLeaseRow BEFORE either can insert. After
    // release they genuinely race the absent-row insert (dup-key typed path
    // vs live-holder path) — not a mere Promise.allSettled toss.
    const raw = await mysql.createConnection("mysql://root:root@127.0.0.1:3311/ipenovel_test");
    try {
      await raw.query("SET time_zone = '+00:00'");
      await raw.beginTransaction();
      await raw.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
      const transferP = leaseService.transferLease({ sessionId: s1.id, userId: userA });
      const acquireP = leaseService.acquireLease({ sessionId: s2.id, userId: userA });
      // R4R3/IR-04 WAIT-REACHED: both operations must appear in
      // information_schema.INNODB_TRX as LOCK WAIT — proving their SQL
      // reached the gap lock BEFORE we release it (done-flags could not
      // distinguish "blocked on lock" from "not dispatched yet").
      const waiters = await waitForLockWaiters(raw, 2, "IR-04a absent-lease gap lock", "readingLeases");
      expect(waiters.length).toBeGreaterThanOrEqual(2);
      await raw.commit();

      const [transfer, acquire] = await Promise.all([transferP, acquireP]);
      // STRICT typed-outcome contract: every result is a TYPED shape —
      // either ok:true, or ok:false with a known code. Never a raw driver
      // rejection escaping as an exception.
      for (const r of [transfer, acquire]) {
        const typed = r.ok || (r as { ok: false; code: string }).ok === false;
        expect(typed).toBe(true);
        if (!r.ok) expect(["LEASE_HELD", "SESSION_NOT_ACTIVE"]).toContain(r.code);
      }
      expect(transfer.ok || acquire.ok).toBe(true); // exactly one winner at least

      const rows = await db.select().from(readingLeases).where(eq(readingLeases.userId, userA));
      expect(rows.length).toBe(1);
      expect([s1.id, s2.id]).toContain(rows[0].holderSessionId);
      expect(rows[0].leaseVersion).toBeGreaterThanOrEqual(1);
      // Cleanup invariant: the winner is a live lease.
      expect(await registry.sessionHoldsLease(rows[0].holderSessionId)).toBe(true);
    } catch (error) {
      await raw.rollback().catch(() => {});
      throw error;
    } finally {
      await raw.end();
    }
  });

  it("R4-IR-04b: quota decision is FRESH after waiting on the slots lock — a slot freed DURING the wait is usable", async () => {
    setFlagTrue();
    await wipeUser();
    const a = await rawActiveSession(); // oldest active — displaced DURING the wait
    await rawActiveSession(); // second active — keeps its slot
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
    const pending = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: new Date(Date.now() + 30 * 86400000),
      createdVia: "google",
    });
    expect(pending.status).toBe("pending_choice");

    // Two-connection barrier: hold the SLOTS row on a raw connection so the
    // resolver queues on lockUserSlotRow; WHILE it waits, free a slot via a
    // normal committed displacement. The post-wait quota read must see the
    // freed slot (locking current read), not a pre-wait snapshot.
    const raw = await mysql.createConnection("mysql://root:root@127.0.0.1:3311/ipenovel_test");
    try {
      await raw.query("SET time_zone = '+00:00'");
      await raw.beginTransaction();
      await raw.query("SELECT userId FROM sessionSlots WHERE userId = ? FOR UPDATE", [userA]);
      const resolveP = registry.resolveThirdLogin({
        callerSessionId: pending.id,
        displaceSessionId: a.id,
        activateExpiresAt: new Date(Date.now() + 30 * 86400000),
      });
      // R4R3/IR-04 WAIT-REACHED: the resolver's SQL must actually be blocked
      // on the slots lock BEFORE the slot is freed — otherwise the fresh-quota
      // claim is unproven (snapshot may have been taken pre-wait).
      const waiters = await waitForLockWaiters(raw, 1, "IR-04b slots lock (resolver)", "sessionSlots");
      expect(waiters.length).toBeGreaterThanOrEqual(1);
      await db
        .update(authSessions)
        .set({ status: "superseded", revokedReason: "concurrent_displaced" })
        .where(and(eq(authSessions.id, a.id), eq(authSessions.status, "active")));
      await raw.commit();

      const resolved = await resolveP;
      // With a pre-wait snapshot the resolver would count 2 actives and give
      // up (NOT_PENDING). The locking fresh count sees 1 active → activates.
      expect(resolved.ok).toBe(true);
      const callerRow = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
      expect(callerRow.status).toBe("active");
      const actives = await db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(and(eq(authSessions.userId, userA), eq(authSessions.status, "active")));
      expect(actives.length).toBe(2); // survivor + newly activated pending
    } catch (error) {
      await raw.rollback().catch(() => {});
      throw error;
    } finally {
      await raw.end();
    }
  });

  it("R4-C2: strict claims BEFORE legacy/v2 — short sid and a valid-signature token with NO exp both hard-fail", async () => {
    setFlagTrue();
    // (a) structurally short sid (production sids are 22-char base64url).
    const shortSidToken = await sdk.createSessionToken(`r4b-${tag}`, { sid: "short-sid" });
    await expect(
      sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${shortSidToken}` } } as any)
    ).rejects.toMatchObject({ reason: "invalid_session_token" });

    // (b) signature-valid, iss/aud-correct, but NO exp claim.
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "integration-test-only-jwt-secret-0123456789abcdef");
    const noExpToken = await new SignJWT({
      openId: `r4b-${tag}`,
      appId: process.env.VITE_APP_ID ?? "ipenovel-integration-test-app",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setIssuer("ipenovel-session")
      .setAudience(process.env.VITE_APP_ID ?? "ipenovel-integration-test-app")
      .sign(secret);
    await expect(
      sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${noExpToken}` } } as any)
    ).rejects.toMatchObject({ reason: "invalid_session_token" });
  });

  it("R4-E2: pending allowlist positives — list and me answer a pending caller", async () => {
    setFlagTrue();
    await wipeUser();
    // Fill both slots, then allocate through the allocator → pending.
    await rawActiveSession();
    await rawActiveSession();
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
    const pendingRow = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: new Date(Date.now() + 30 * 86400000),
      createdVia: "google",
    });
    expect(pendingRow.status).toBe("pending_choice");

    const user = {
      id: userA, openId: `r4b-${tag}`, email: `r4b-${tag}@t.test`, name: "R4B",
      loginMethod: "test", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as TrpcContext["user"];
    const caller = appRouter.createCaller({
      user,
      authSession: pendingRow,
      authSessionExpiresAt: new Date(Date.now() + 30 * 86400000),
      req: { protocol: "https", headers: {} } as any,
      res: {} as any,
    });
    const listed = await caller.auth.sessions.list();
    expect(listed.readerSessionControls).toBe(true);
    expect(listed.sessions.some(s => s.id === pendingRow.id && s.status === "pending_choice" && s.current)).toBe(true);
    // auth.me answers the caller's user directly (publicProcedure → ctx.user).
    const me = (await caller.auth.me()) as any;
    expect(me.id).toBe(userA);
  });

  it("R4-F1: chooser displacement kills the displaced session's lease in the SAME tx — its renew loses typed", async () => {
    setFlagTrue();
    await wipeUser();
    const keeper = await rawActiveSession();
    const displaced = await rawActiveSession();
    await holderLease(displaced.id);
    expect(await registry.sessionHoldsLease(displaced.id)).toBe(true);

    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
    const pendingRow = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: new Date(Date.now() + 30 * 86400000),
      createdVia: "google",
    });
    // The allocator made this row pending (slots full) — resolve by
    // displacing the LEASE HOLDER.
    expect(pendingRow.status).toBe("pending_choice");
    const resolved = await registry.resolveThirdLogin({
      callerSessionId: pendingRow.id,
      displaceSessionId: displaced.id,
      activateExpiresAt: new Date(Date.now() + 30 * 86400000),
    });
    expect(resolved.ok).toBe(true);

    // Displaced row terminal; its lease died in the same tx (v++ / NOW()).
    const displacedAfter = (await db.select().from(authSessions).where(eq(authSessions.id, displaced.id)))[0];
    expect(displacedAfter.status).toBe("superseded");
    expect(await registry.sessionHoldsLease(displaced.id)).toBe(false);
    const leaseRow = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
    expect(leaseRow.holderSessionId).toBe(displaced.id);
    expect(leaseRow.leaseVersion).toBe(8); // 7 → 8: invalidated, not stolen
    const staleRenew = await leaseService.renewLease({ sessionId: displaced.id, userId: userA, leaseVersion: 7 });
    expect(staleRenew).toMatchObject({ ok: false });
  });

  it("R4-F2: logout kills the holder's lease in the SAME tx — renew after logout loses typed", async () => {
    setFlagTrue();
    await wipeUser();
    const s = await rawActiveSession();
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    await db.insert(readingLeases).values({
      userId: userA,
      holderSessionId: s.id,
      leaseVersion: 3,
      acquiredAt: new Date(),
      expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
    });
    expect(await registry.sessionHoldsLease(s.id)).toBe(true);

    await registry.revokeByToken(s.token);

    const rowAfter = (await db.select().from(authSessions).where(eq(authSessions.id, s.id)))[0];
    expect(rowAfter.status).toBe("revoked");
    expect(await registry.sessionHoldsLease(s.id)).toBe(false);
    const leaseRow = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
    expect(leaseRow.leaseVersion).toBe(4); // invalidated in-tx
    const renew = await leaseService.renewLease({ sessionId: s.id, userId: userA, leaseVersion: 3 });
    expect(renew).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" });
  });

  // ===== IR-04 completion: forced interleavings, typed losers, two orders =====

  /** raw connection helper for the interleave tests below. */
  async function rawConn() {
    const c = await mysql.createConnection("mysql://root:root@127.0.0.1:3311/ipenovel_test");
    await c.query("SET time_zone = '+00:00'");
    return c;
  }

  it("R4-IR-04c: COMPETING ACQUIRES over a forced-expired lease, both wait-reached on the lease row — exactly one typed winner", async () => {
    setFlagTrue();
    await wipeUser();
    const holder = await rawActiveSession();
    const c1 = await rawActiveSession();
    const c2 = await rawActiveSession();
    await holderLease(holder.id); // live lease, version 7
    // FORCE the expired-LEASE branch at DB time WITHOUT expiring any session:
    // both competitors remain active, so the race is decided purely on the
    // expired lease row (the old version expired the holder session too,
    // which pre-empted the lease race with SESSION_NOT_ACTIVE).
    await db
      .update(readingLeases)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(readingLeases.userId, userA));

    // Both acquires must reach the lease-row lock wait BEFORE racing.
    const raw = await rawConn();
    try {
      await raw.beginTransaction();
      await raw.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
      const p1 = leaseService.acquireLease({ sessionId: c1.id, userId: userA });
      const p2 = leaseService.acquireLease({ sessionId: c2.id, userId: userA });
      const waiters = await waitForLockWaiters(raw, 2, "IR-04c competing acquires on expired lease", "readingLeases");
      expect(waiters.length).toBeGreaterThanOrEqual(2);
      await raw.commit();
      const [a1, a2] = await Promise.all([p1, p2]);
      // Exactly one typed winner; the loser is typed LEASE_HELD, never a raw
      // rejection and never SESSION_NOT_ACTIVE (all sessions stay active).
      const results = [a1, a2];
      const winners = results.filter(r => r.ok);
      expect(winners.length).toBe(1);
      for (const r of results) {
        if (!r.ok) expect(r.code).toBe("LEASE_HELD");
      }
      const rows = await db.select().from(readingLeases).where(eq(readingLeases.userId, userA));
      expect(rows.length).toBe(1);
      const winnerId = rows[0].holderSessionId;
      expect([c1.id, c2.id]).toContain(winnerId);
      expect(rows[0].leaseVersion).toBe(8); // re-arm fenced the expired v7
      expect(await registry.sessionHoldsLease(winnerId)).toBe(true);
      expect(await registry.sessionHoldsLease(holder.id)).toBe(false);
    } catch (error) {
      await raw.rollback().catch(() => {});
      await raw.end().catch(() => {});
      throw error;
    }
    await raw.end();
  });

  it("R4-IR-04d: renew/transfer BOTH orders — Order A transfer-wins makes stale renew typed LEASE_HELD; Order B successful renew precedes transfer", async () => {
    setFlagTrue();
    await wipeUser();
    const holder = await rawActiveSession();
    const mover = await rawActiveSession();
    await holderLease(holder.id); // v7

    // ORDER A — transfer completes WHILE the holder's renew is provably
    // blocked on the holder session-row lock; after release the stale renew
    // re-reads: holder is no longer the lease holder → TYPED LEASE_HELD
    // (ok:false is REQUIRED — ok:true would violate the service contract).
    const raw = await rawConn();
    try {
      await raw.beginTransaction();
      await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [holder.id]);
      const renewP = leaseService.renewLease({ sessionId: holder.id, userId: userA, leaseVersion: 7 });
      await waitForLockWaiters(raw, 1, "IR-04d Order A renew on holder row");
      const moved = await leaseService.transferLease({ sessionId: mover.id, userId: userA });
      expect(moved.ok).toBe(true);
      expect(moved.leaseVersion).toBe(8);
      await raw.commit();
      const staleRenew = await renewP;
      expect(staleRenew).toMatchObject({ ok: false, code: "LEASE_HELD" });
    } catch (error) {
      await raw.rollback().catch(() => {});
      await raw.end().catch(() => {});
      throw error;
    }
    await raw.end();
    let rows = await db.select().from(readingLeases).where(eq(readingLeases.userId, userA));
    expect(rows[0].holderSessionId).toBe(mover.id);
    expect(rows[0].leaseVersion).toBe(8);

    // ORDER B — FORCED OVERLAP, RENEW WINS: reset the fixture, then hold the
    // LEASE row on the raw connection. BOTH the holder's renew (lease-row
    // lock stage) and the mover's transfer queue on that SAME lock; renew is
    // queued first, so after release renew must win with its typed success
    // (ok:true, version UNCHANGED at 7 — renew never bumps), and the queued
    // transfer then lands (v8, holder=mover). This is the forced opposite
    // winner of Order A, not a sequential positive control.
    await db
      .update(readingLeases)
      .set({ holderSessionId: holder.id, leaseVersion: 7, expiresAt: sql`NOW() + INTERVAL 300 SECOND` })
      .where(eq(readingLeases.userId, userA));
    const rawB = await rawConn();
    try {
      await rawB.beginTransaction();
      await rawB.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
      const renewP = leaseService.renewLease({ sessionId: holder.id, userId: userA, leaseVersion: 7 });
      const wait1 = await waitForLockWaiters(rawB, 1, "IR-04d Order B renew", "readingLeases");
      expect(wait1.length).toBeGreaterThanOrEqual(1);
      const transferP = leaseService.transferLease({ sessionId: mover.id, userId: userA });
      const wait2 = await waitForLockWaiters(rawB, 2, "IR-04d Order B renew+transfer", "readingLeases");
      expect(wait2.length).toBeGreaterThanOrEqual(2);
      await rawB.commit();
      const [okRenew, moved] = await Promise.all([renewP, transferP]);
      expect(okRenew).toMatchObject({ ok: true, leaseVersion: 7 }); // renew wins, version unchanged
      expect(moved).toMatchObject({ ok: true, leaseVersion: 8 }); // transfer lands second
    } catch (error) {
      await rawB.rollback().catch(() => {});
      await rawB.end().catch(() => {});
      throw error;
    }
    await rawB.end();
    rows = await db.select().from(readingLeases).where(eq(readingLeases.userId, userA));
    expect(rows.length).toBe(1);
    expect(rows[0].holderSessionId).toBe(mover.id);
    expect(rows[0].leaseVersion).toBe(8);
    expect(await registry.sessionHoldsLease(mover.id)).toBe(true);
  });

  it("R4-IR-04e: terminal-vs-renew BOTH orders with wait-reached — logout outcome asserted, final always revoked+dead lease", async () => {
    setFlagTrue();
    await wipeUser();
    // ORDER A: logout fully commits FIRST (outcome asserted), renew AFTER → typed.
    {
      const s = await rawActiveSession();
      await db.insert(readingLeases).values({
        userId: userA, holderSessionId: s.id, leaseVersion: 1,
        acquiredAt: new Date(), expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
      });
      const logoutOutcome = await registry.revokeByToken(s.token);
      expect(logoutOutcome).toBe("revoked");
      const renew = await leaseService.renewLease({ sessionId: s.id, userId: userA, leaseVersion: 1 });
      expect(renew).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" });
      const after = (await db.select().from(authSessions).where(eq(authSessions.id, s.id)))[0];
      expect(after.status).toBe("revoked");
    }
    // ORDER B — FORCED RENEW-WINS: raw lock on the session row; renew is
    // queued FIRST, logout SECOND (both attributable on authSessions). After
    // release renew must win the row first → typed success ok:true v1
    // (asserted, not allowed to fail); logout then commits 'revoked'; the
    // revocation floor still guarantees the final invariant.
    {
      await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
      const s = await rawActiveSession();
      await db.insert(readingLeases).values({
        userId: userA, holderSessionId: s.id, leaseVersion: 1,
        acquiredAt: new Date(), expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
      });
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [s.id]);
        const renewP = leaseService.renewLease({ sessionId: s.id, userId: userA, leaseVersion: 1 });
        await waitForLockWaiters(raw, 1, "IR-04e Order B renew", "authSessions");
        const logoutP = registry.revokeByToken(s.token);
        const waiters = await waitForLockWaiters(raw, 2, "IR-04e Order B renew+logout", "authSessions");
        expect(waiters.length).toBeGreaterThanOrEqual(2);
        await raw.commit();
        const [renewed, logoutOutcome] = await Promise.all([renewP, logoutP]);
        expect(renewed).toMatchObject({ ok: true, leaseVersion: 1 }); // FORCED renew-wins outcome
        expect(logoutOutcome).toBe("revoked");
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const after = (await db.select().from(authSessions).where(eq(authSessions.id, s.id)))[0];
      expect(after.status).toBe("revoked");
      expect(await registry.sessionHoldsLease(s.id)).toBe(false);
      const leaseRow = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(new Date(leaseRow.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    }
    // ORDER C — FORCED LOGOUT-WINS: same barrier, but logout is queued FIRST
    // and renew SECOND. After release the revoke commits first → the renew
    // re-reads a REVOKED row under its lock → typed SESSION_NOT_ACTIVE
    // (asserted, not optional).
    {
      await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
      const s = await rawActiveSession();
      await db.insert(readingLeases).values({
        userId: userA, holderSessionId: s.id, leaseVersion: 1,
        acquiredAt: new Date(), expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
      });
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [s.id]);
        const logoutP = registry.revokeByToken(s.token);
        await waitForLockWaiters(raw, 1, "IR-04e Order C logout", "authSessions");
        const renewP = leaseService.renewLease({ sessionId: s.id, userId: userA, leaseVersion: 1 });
        await waitForLockWaiters(raw, 2, "IR-04e Order C logout+renew", "authSessions");
        await raw.commit();
        const [logoutOutcome, renewed] = await Promise.all([logoutP, renewP]);
        expect(logoutOutcome).toBe("revoked");
        expect(renewed).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" }); // FORCED logout-wins outcome
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const after = (await db.select().from(authSessions).where(eq(authSessions.id, s.id)))[0];
      expect(after.status).toBe("revoked");
      expect(await registry.sessionHoldsLease(s.id)).toBe(false);
    }
  });

  it("R4-IR-04f: DISTINCT pending callers compete for the last slot (both wait-reached on the slots lock) — one activates, the other stays pending typed", async () => {
    setFlagTrue();
    await wipeUser();
    const keeper = await rawActiveSession();
    const victim = await rawActiveSession(); // the one standing session both resolvers displace
    expect((await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userA), eq(authSessions.status, "active")))).length).toBe(2);

    // TWO DIFFERENT pending logins (distinct sids), both resolvers displace
    // the same victim. Distinct from the duplicate-resolution case: each
    // caller decides its OWN row; quota is decided fresh under the slots
    // lock after the wait.
    const mintPending = async () => {
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      const row = await registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
      });
      expect(row.status).toBe("pending_choice");
      return row;
    };
    const pending1 = await mintPending();
    const pending2 = await mintPending();

    const raw = await rawConn();
    try {
      await raw.beginTransaction();
      await raw.query("SELECT userId FROM sessionSlots WHERE userId = ? FOR UPDATE", [userA]);
      const r1 = registry.resolveThirdLogin({
        callerSessionId: pending1.id, displaceSessionId: victim.id,
        activateExpiresAt: new Date(Date.now() + 30 * 86400000),
      });
      const r2 = registry.resolveThirdLogin({
        callerSessionId: pending2.id, displaceSessionId: victim.id,
        activateExpiresAt: new Date(Date.now() + 30 * 86400000),
      });
      // BOTH resolvers must reach the slots-lock wait before release — the
      // quota decision is then made fresh, after the wait.
      const waiters = await waitForLockWaiters(raw, 2, "IR-04f distinct pending resolvers", "sessionSlots");
      expect(waiters.length).toBeGreaterThanOrEqual(2);
      await raw.commit();
      const outcomes = await Promise.all([r1, r2]);
      for (const o of outcomes) {
        const typed = o.ok === true || (o.ok === false && typeof o.code === "string");
        expect(typed).toBe(true);
      }
      const winners = outcomes.filter(o => o.ok);
      expect(winners.length).toBe(1); // exactly ONE pending gets the freed slot
      const loserOutcome = outcomes.find(o => !o.ok) as { ok: false; code: string };
      expect(loserOutcome.code).toBe("NOT_PENDING"); // quota full after the winner took it
      const rows = await db.select().from(authSessions).where(eq(authSessions.userId, userA));
      const actives = rows.filter(r => r.status === "active").map(r => r.id);
      expect(actives.length).toBe(2); // keeper + the winning pending — quota exact
      const victimRow = rows.find(r => r.id === victim.id);
      expect(victimRow.status).toBe("superseded");
      const loserRow = rows.find(r => r.id === pending1.id).status === "pending_choice"
        ? rows.find(r => r.id === pending1.id)
        : rows.find(r => r.id === pending2.id);
      expect(loserRow.status).toBe("pending_choice"); // loser keeps non-reading rights, stays pending
    } catch (error) {
      await raw.rollback().catch(() => {});
      await raw.end().catch(() => {});
      throw error;
    }
    await raw.end();
  });

  it("R4-IR-04g: rotation-vs-renew BOTH orders — Order A rotation-first typed rejection; Order B both wait-reached concurrently, invariant holds", async () => {
    setFlagTrue();
    await wipeUser();
    const oldSession = await rawActiveSession();
    await holderLease(oldSession.id); // v7 live
    const rotate = async () => {
      // each rotation mints its own sid (UNIQUE) — Order A and Order B both rotate
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      return registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
        rotateRowId: oldSession.id,
      });
    };

    // ORDER A: rotation fully commits first, then the old holder's renew is
    // typed-rejected (post-terminal).
    await rotate();
    const oldRowA = (await db.select().from(authSessions).where(eq(authSessions.id, oldSession.id)))[0];
    expect(oldRowA.status).toBe("superseded");
    const postTerminalRenew = await leaseService.renewLease({ sessionId: oldSession.id, userId: userA, leaseVersion: 7 });
    expect(postTerminalRenew).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" });
    expect(await registry.sessionHoldsLease(oldSession.id)).toBe(false);

    // ORDER B — FORCED RENEW-WINS: raw lock on the old holder's session row;
    // renew queued FIRST, rotation SECOND (both attributable on authSessions).
    // After release renew wins the row → ok:true v7 (asserted); the queued
    // rotation then supersedes the old row and kills its lease.
    await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, oldSession.id));
    await holderLease(oldSession.id); // fresh v7 live lease again
    const raw = await rawConn();
    try {
      await raw.beginTransaction();
      await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [oldSession.id]);
      const renewP = leaseService.renewLease({ sessionId: oldSession.id, userId: userA, leaseVersion: 7 });
      await waitForLockWaiters(raw, 1, "IR-04g Order B renew", "authSessions");
      const rotateP = rotate();
      await waitForLockWaiters(raw, 2, "IR-04g Order B renew+rotation", "authSessions");
      await raw.commit();
      const [renewed, rotated] = await Promise.all([renewP, rotateP]);
      expect(renewed).toMatchObject({ ok: true, leaseVersion: 7 }); // FORCED renew-wins
      expect(rotated.status).toBe("active");
      const oldRow = (await db.select().from(authSessions).where(eq(authSessions.id, oldSession.id)))[0];
      expect(oldRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(oldSession.id)).toBe(false);
    } catch (error) {
      await raw.rollback().catch(() => {});
      await raw.end().catch(() => {});
      throw error;
    }
    await raw.end();

    // ORDER C — FORCED ROTATION-WINS: same barrier, rotation queued FIRST,
    // renew SECOND. After release the rotation supersede commits first →
    // the renew re-reads a SUPERSEDED row → typed SESSION_NOT_ACTIVE
    // (asserted, not optional). The fixture is fully reset first: Order B's
    // rotation row occupies a slot, so without the reset this order's
    // rotation row would land as pending_choice.
    await wipeUser();
    const oldSession2 = await rawActiveSession();
    await holderLease(oldSession2.id); // v7 again on a clean slate
    const rotate2 = async () => {
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      return registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
        rotateRowId: oldSession2.id,
      });
    };
    const rawC = await rawConn();
    try {
      await rawC.beginTransaction();
      await rawC.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [oldSession2.id]);
      const rotateP = rotate2();
      await waitForLockWaiters(rawC, 1, "IR-04g Order C rotation", "authSessions");
      const renewP = leaseService.renewLease({ sessionId: oldSession2.id, userId: userA, leaseVersion: 7 });
      await waitForLockWaiters(rawC, 2, "IR-04g Order C rotation+renew", "authSessions");
      await rawC.commit();
      const [rotated, renewed] = await Promise.all([rotateP, renewP]);
      expect(rotated.status).toBe("active");
      expect(renewed).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" }); // FORCED rotation-wins
      const oldRow = (await db.select().from(authSessions).where(eq(authSessions.id, oldSession2.id)))[0];
      expect(oldRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(oldSession2.id)).toBe(false);
    } catch (error) {
      await rawC.rollback().catch(() => {});
      await rawC.end().catch(() => {});
      throw error;
    }
    await rawC.end();
  });

  it("R4-IR-04h: CHOOSER-vs-RENEW forced pair, BOTH orders — chooser-wins makes renew typed; renew-wins still ends displaced+dead", async () => {
    // Fixture builder: 2 standing actives (keeper + displaced holder with a
    // live v7 lease) + one pending caller that will displace the holder.
    const buildFixture = async () => {
      await wipeUser();
      const displaced = await rawActiveSession();
      await holderLease(displaced.id); // v7 live
      await rawActiveSession(); // keeper (fills the second slot)
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      const pending = await registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
      });
      expect(pending.status).toBe("pending_choice");
      return { displaced, pending };
    };

    // ORDER A — FORCED CHOOSER-WINS: raw-lock the displaced holder's session
    // row; queue the resolver FIRST, the holder's renew SECOND (both
    // attributable on authSessions). After release the chooser displaces and
    // kills the lease first; the renew re-reads a SUPERSEDED row → typed
    // SESSION_NOT_ACTIVE (asserted, not optional).
    {
      const { displaced, pending } = await buildFixture();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [displaced.id]);
        const resolveP = registry.resolveThirdLogin({
          callerSessionId: pending.id, displaceSessionId: displaced.id,
          activateExpiresAt: new Date(Date.now() + 30 * 86400000),
        });
        await waitForLockWaiters(raw, 1, "IR-04h Order A chooser", "authSessions");
        const renewP = leaseService.renewLease({ sessionId: displaced.id, userId: userA, leaseVersion: 7 });
        await waitForLockWaiters(raw, 2, "IR-04h Order A chooser+renew", "authSessions");
        await raw.commit();
        const [resolved, renewed] = await Promise.all([resolveP, renewP]);
        expect(resolved.ok).toBe(true);
        expect(renewed).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" }); // FORCED chooser-wins
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const displacedRow = (await db.select().from(authSessions).where(eq(authSessions.id, displaced.id)))[0];
      expect(displacedRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(displaced.id)).toBe(false);
      const callerRow = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
      expect(callerRow.status).toBe("active");
    }

    // ORDER B — FORCED RENEW-WINS: same barrier, the holder's renew queued
    // FIRST. After release the renew completes while the row is still
    // active → typed success ok:true v7 (asserted); the queued resolver then
    // displaces the holder and kills its lease — the final invariant is
    // still displaced-terminal + dead lease + caller active.
    {
      const { displaced, pending } = await buildFixture();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [displaced.id]);
        const renewP = leaseService.renewLease({ sessionId: displaced.id, userId: userA, leaseVersion: 7 });
        await waitForLockWaiters(raw, 1, "IR-04h Order B renew", "authSessions");
        const resolveP = registry.resolveThirdLogin({
          callerSessionId: pending.id, displaceSessionId: displaced.id,
          activateExpiresAt: new Date(Date.now() + 30 * 86400000),
        });
        await waitForLockWaiters(raw, 2, "IR-04h Order B renew+chooser", "authSessions");
        await raw.commit();
        const [renewed, resolved] = await Promise.all([renewP, resolveP]);
        expect(renewed).toMatchObject({ ok: true, leaseVersion: 7 }); // FORCED renew-wins
        expect(resolved.ok).toBe(true); // chooser still completes the displacement
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const displacedRow = (await db.select().from(authSessions).where(eq(authSessions.id, displaced.id)))[0];
      expect(displacedRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(displaced.id)).toBe(false); // lease dead in-tx either order
      const callerRow = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
      expect(callerRow.status).toBe("active");
    }
  });


  // ===== R4R5/IR-04: terminal-vs-TRANSFER forced pairs (both orders) =====
  // Determinism note: InnoDB does not DOCUMENT a FIFO guarantee between two
  // queued writers on one lock, so each forced order below pins the LOSING
  // writer at an EARLIER stage of its own lock chain (holder row / slots
  // row / mover row) that the winning writer never touches — the winner
  // therefore completes WHILE the loser is provably blocked, and the loser
  // resumes against the winner's committed state. No order depends on
  // cross-writer queue ordering.

  it("R4-IR-04i: LOGOUT-vs-TRANSFER both orders — deterministic winners, holder terminal + typed outcomes + lease destination per order", async () => {
    setFlagTrue();
    const build = async () => {
      await wipeUser();
      const holder = await rawActiveSession();
      const mover = await rawActiveSession();
      await holderLease(holder.id); // v7 live on holder
      return { holder, mover };
    };
    // ORDER A — TRANSFER WINS (overlap): pin the LOGOUT at its FIRST stage
    // (holder authSessions row, held by raw). While logout is provably
    // blocked there, the transfer — which never touches the holder row —
    // runs to completion (v8, holder→mover). Release; the logout then
    // revokes the (still-active) holder row and its lease-invalidation
    // matches no rows.
    {
      const { holder, mover } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [holder.id]);
        const logoutP = registry.revokeByToken(holder.token);
        await waitForLockWaiters(raw, 1, "IR-04i A logout pinned at holder row", "authSessions");
        // transfer runs to completion WHILE logout is blocked (deterministic:
        // the two lock chains are disjoint here).
        const moved = await leaseService.transferLease({ sessionId: mover.id, userId: userA });
        expect(moved).toMatchObject({ ok: true, leaseVersion: 8 });
        await raw.commit();
        const logoutOutcome = await logoutP;
        expect(logoutOutcome).toBe("revoked");
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const holderRow = (await db.select().from(authSessions).where(eq(authSessions.id, holder.id)))[0];
      expect(holderRow.status).toBe("revoked"); // terminal either way
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id); // transfer's destination stands
      expect(lease.leaseVersion).toBe(8); // logout invalidation matched no rows
      expect(await registry.sessionHoldsLease(mover.id)).toBe(true);
    }
    // ORDER B — LOGOUT/TERMINAL WINS (overlap): pin BOTH writers on their
    // own earlier stages — logout at the lease row (its last stage, after
    // its holder-row update), transfer at the mover row. They block on
    // DIFFERENT rows, so release lets logout finish first (its only
    // remaining lock); the transfer then takes over the dead lease (v9).
    {
      const { holder, mover } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [mover.id]);
        const logoutP = registry.revokeByToken(holder.token);
        await waitForLockWaiters(raw, 1, "IR-04i B logout at lease row", "readingLeases");
        const transferP = leaseService.transferLease({ sessionId: mover.id, userId: userA });
        await waitForLockWaiters(raw, 1, "IR-04i B transfer at mover row", "authSessions"); // logout already confirmed on readingLeases above
        await raw.commit();
        const [logoutOutcome, moved] = await Promise.all([logoutP, transferP]);
        expect(logoutOutcome).toBe("revoked");
        expect(moved).toMatchObject({ ok: true, leaseVersion: 9 }); // v8 kill → v9 takeover
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const holderRow = (await db.select().from(authSessions).where(eq(authSessions.id, holder.id)))[0];
      expect(holderRow.status).toBe("revoked");
      expect(await registry.sessionHoldsLease(holder.id)).toBe(false);
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id);
      expect(lease.leaseVersion).toBe(9);
      expect(await registry.sessionHoldsLease(mover.id)).toBe(true);
    }
  });

  it("R4-IR-04j: ROTATION-vs-TRANSFER both orders — deterministic winners, old row terminal + new row active + lease destination per order", async () => {
    setFlagTrue();
    const build = async () => {
      await wipeUser();
      const oldSession = await rawActiveSession();
      const mover = await rawActiveSession();
      await holderLease(oldSession.id); // v7 live on oldSession
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      const rotate = () => registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
        rotateRowId: oldSession.id,
      });
      return { oldSession, mover, rotate };
    };
    // ORDER A — TRANSFER WINS (overlap): pin the ROTATION at its FIRST
    // stage (sessionSlots row). While rotation is blocked there, the
    // transfer — which never takes the slots lock — completes (v8,
    // oldSession→mover). Release; the rotation then supersedes the old row
    // but its lease-invalidation matches no rows.
    {
      const { oldSession, mover, rotate } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT userId FROM sessionSlots WHERE userId = ? FOR UPDATE", [userA]);
        const rotateP = rotate();
        await waitForLockWaiters(raw, 1, "IR-04j A rotation pinned at slots", "sessionSlots");
        const moved = await leaseService.transferLease({ sessionId: mover.id, userId: userA });
        expect(moved).toMatchObject({ ok: true, leaseVersion: 8 });
        await raw.commit();
        const rotated = await rotateP;
        expect(rotated.status).toBe("active");
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const oldRow = (await db.select().from(authSessions).where(eq(authSessions.id, oldSession.id)))[0];
      expect(oldRow.status).toBe("superseded"); // rotation supersede always lands
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id);
      expect(lease.leaseVersion).toBe(8); // rotation invalidation matched no rows
      expect(await registry.sessionHoldsLease(mover.id)).toBe(true);
    }
    // ORDER B — ROTATION/TERMINAL WINS (overlap): pin BOTH on their own
    // earlier stages — rotation at the lease row, transfer at the mover
    // row; different rows, so rotation finishes first (v8 kill), transfer
    // takes over the dead lease (v9).
    {
      const { oldSession, mover, rotate } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [mover.id]);
        const rotateP = rotate();
        await waitForLockWaiters(raw, 1, "IR-04j B rotation at lease row", "readingLeases");
        const transferP = leaseService.transferLease({ sessionId: mover.id, userId: userA });
        await waitForLockWaiters(raw, 1, "IR-04j B transfer at mover row", "authSessions"); // rotation already confirmed on readingLeases above
        await raw.commit();
        const [rotated, moved] = await Promise.all([rotateP, transferP]);
        expect(rotated.status).toBe("active");
        expect(moved).toMatchObject({ ok: true, leaseVersion: 9 });
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const oldRow = (await db.select().from(authSessions).where(eq(authSessions.id, oldSession.id)))[0];
      expect(oldRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(oldSession.id)).toBe(false);
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id);
      expect(lease.leaseVersion).toBe(9);
    }
  });

  it("R4-IR-04k: CHOOSER-vs-TRANSFER both orders — deterministic winners, keep terminal + caller active + lease destination per order", async () => {
    setFlagTrue();
    const build = async () => {
      await wipeUser();
      const keep = await rawActiveSession();   // the standing session the chooser displaces
      const mover = await rawActiveSession();   // the explicit-transfer presser (2nd active — quota full)
      await holderLease(keep.id);              // v7 live on keep
      const sid = registry.generateSid();
      const token = await sdk.createSessionToken(`r4b-${tag}`, { sid, expiresInMs: 30 * 86400000 });
      const pending = await registry.allocateSessionRow({
        userId: userA, token, sid,
        expiresAt: new Date(Date.now() + 30 * 86400000),
        createdVia: "google",
      });
      expect(pending.status).toBe("pending_choice");
      const resolve = () => registry.resolveThirdLogin({
        callerSessionId: pending.id, displaceSessionId: keep.id,
        activateExpiresAt: new Date(Date.now() + 30 * 86400000),
      });
      return { keep, mover, pending, resolve };
    };
    // ORDER A — TRANSFER WINS (overlap): pin the CHOOSER at its FIRST stage
    // (sessionSlots row). While the resolver is blocked there, the transfer
    // — which never takes the slots lock — completes (v8, keep→mover).
    // Release; the resolver then displaces keep but its lease-invalidation
    // matches no rows; caller activates.
    {
      const { keep, mover, pending, resolve } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT userId FROM sessionSlots WHERE userId = ? FOR UPDATE", [userA]);
        const resolveP = resolve();
        await waitForLockWaiters(raw, 1, "IR-04k A chooser pinned at slots", "sessionSlots");
        const moved = await leaseService.transferLease({ sessionId: mover.id, userId: userA });
        expect(moved).toMatchObject({ ok: true, leaseVersion: 8 });
        await raw.commit();
        const resolved = await resolveP;
        expect(resolved.ok).toBe(true);
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const keepRow = (await db.select().from(authSessions).where(eq(authSessions.id, keep.id)))[0];
      expect(keepRow.status).toBe("superseded"); // chooser displacement always lands
      const callerRow = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
      expect(callerRow.status).toBe("active");
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id);
      expect(lease.leaseVersion).toBe(8); // chooser invalidation matched no rows
    }
    // ORDER B — CHOOSER/TERMINAL WINS (overlap): pin BOTH on their own
    // earlier stages — resolver at the lease row (after keep supersede),
    // transfer at the mover row; different rows, so the resolver finishes
    // first (v8 kill), transfer takes over the dead lease (v9).
    {
      const { keep, mover, pending, resolve } = await build();
      const raw = await rawConn();
      try {
        await raw.beginTransaction();
        await raw.query("SELECT userId FROM readingLeases WHERE userId = ? FOR UPDATE", [userA]);
        await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [mover.id]);
        const resolveP = resolve();
        await waitForLockWaiters(raw, 1, "IR-04k B chooser at lease row", "readingLeases");
        const transferP = leaseService.transferLease({ sessionId: mover.id, userId: userA });
        await waitForLockWaiters(raw, 1, "IR-04k B transfer at mover row", "authSessions"); // chooser already confirmed on readingLeases above
        await raw.commit();
        const [resolved, moved] = await Promise.all([resolveP, transferP]);
        expect(resolved.ok).toBe(true);
        expect(moved).toMatchObject({ ok: true, leaseVersion: 9 });
      } catch (error) {
        await raw.rollback().catch(() => {});
        await raw.end().catch(() => {});
        throw error;
      }
      await raw.end();
      const keepRow = (await db.select().from(authSessions).where(eq(authSessions.id, keep.id)))[0];
      expect(keepRow.status).toBe("superseded");
      expect(await registry.sessionHoldsLease(keep.id)).toBe(false);
      const callerRow = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
      expect(callerRow.status).toBe("active");
      const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
      expect(lease.holderSessionId).toBe(mover.id);
      expect(lease.leaseVersion).toBe(9);
    }
  });
});
