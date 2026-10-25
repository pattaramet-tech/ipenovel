import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import { __setDbForTests } from "./db";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import * as registry from "./services/sessionRegistry";
import { authSessions, readingLeases, sessionSlots, users } from "../drizzle/schema";

/**
 * R8B-4E — Terminal Session Race regression battery (T12–T19).
 *
 * Defect class: the revocation floor ran ONCE (a plain snapshot read) at the
 * top of resolveRegistryRow. A concurrent logout / rotation-displacement /
 * chooser-window expiry that committed AFTER that read — while the request
 * was waiting on a lock or running promotion/reconcile/claim — could leave a
 * TERMINAL row (revoked/superseded) as ctx.authSession: the pending gate
 * only named pending_choice, so the request rode a dead session into
 * business procedures (TOCTOU on the floor).
 *
 * Fix under test: (a) sdk.assertRegistryRowLive at EVERY last-read exit of
 * session resolution (active-fresh, pending-claim, unslotted-promotion,
 * adoption, fall-through); (b) in-memory terminal guards on requireUser
 * (every user-bearing chain) and requireSessionSlotResolved.
 *
 * Race proof style (R4R4/IR-04): a raw blocker connection holds the row /
 * slots lock; the operation under test is started and proven PROVABLY
 * blocked via sys.innodb_lock_waits (attributable: blocking_pid = blocker's
 * CONNECTION_ID); the blocker then commits the terminal transition; the
 * resumed operation's decision is asserted. The linearization point of each
 * request is the locked re-read AFTER the wait — stated per test.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

const SESSION_30D_MS = 30 * 86400000;

type LockWaitEvidence = {
  wait_pid: string | number;
  block_pid: string | number;
  lock_table: string;
  lock_type: string;
};

async function attributableLockWaits(raw: mysql.Connection): Promise<LockWaitEvidence[]> {
  const [rows] = await raw.query(
    `SELECT waiting_pid AS wait_pid, blocking_pid AS block_pid,
            locked_table_schema AS lock_schema, locked_table_name AS lock_table,
            locked_type AS lock_type
     FROM sys.innodb_lock_waits
     WHERE blocking_pid = CONNECTION_ID()`
  );
  return (rows as any[]).map(r => ({
    wait_pid: r.wait_pid,
    block_pid: r.block_pid,
    lock_table: r.lock_schema ? `${r.lock_schema}.${r.lock_table}` : String(r.lock_table),
    lock_type: String(r.lock_type ?? ""),
  }));
}

/** Poll (bounded 15s) until `expected` waiters are provably blocked BY the blocker connection. */
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
    const matching = tableHint ? last.filter(w => w.lock_table.includes(tableHint)) : last;
    if (matching.length >= expected) return matching;
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = last.map(w => `${w.wait_pid}→${w.block_pid} on ${w.lock_table}`).join("; ") || "none";
  throw new Error(
    `barrier NOT observed for ${label}: expected >=${expected} waiters blocked by this connection on ${tableHint ?? "any table"} within 15s. Observed: ${seen}`
  );
}

describe("R8B-4E terminal session race (T12–T19)", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const createdUserIds: number[] = [];
  const createdSessionIds: number[] = [];

  let userU = 0;
  let userOpenId = "";

  beforeAll(async () => {
    __setDbForTests(db);
    process.env.READER_SESSION_CONTROLS = "true";
    const openId = `r8b4e-${tag}`;
    userU = insertId(
      await db.insert(users).values({
        openId,
        name: `R8B4E ${tag}`,
        email: `r8b4e-${tag}@example.test`,
        loginMethod: "test",
        role: "user",
      })
    );
    createdUserIds.push(userU);
    userOpenId = openId;
  });

  afterAll(async () => {
    process.env.READER_SESSION_CONTROLS = "false";
    __setDbForTests(null);
    if (createdSessionIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.id, createdSessionIds));
    }
    await db.delete(authSessions).where(inArray(authSessions.userId, createdUserIds));
    await db.delete(readingLeases).where(inArray(readingLeases.userId, createdUserIds));
    await db.delete(sessionSlots).where(inArray(sessionSlots.userId, createdUserIds));
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  /** Fresh user per race test — quota state must never leak between tests. */
  async function freshUser() {
    const openId = `r8b4e-${tag}-${randomUUID().slice(0, 8)}`;
    const id = insertId(
      await db.insert(users).values({
        openId,
        name: `R8B4E ${tag}`,
        email: `r8b4e-${randomUUID().slice(0, 8)}@example.test`,
        loginMethod: "test",
        role: "user",
      })
    );
    createdUserIds.push(id);
    userU = id;
    userOpenId = openId;
    return id;
  }

  async function mintV2(label: string, opts?: { expiresAt?: Date }) {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(userOpenId, { sid, expiresInMs: SESSION_30D_MS });
    const row = await registry.allocateSessionRow({
      userId: userU,
      token,
      sid,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + SESSION_30D_MS),
      createdVia: "google",
      clientLabel: label,
    });
    createdSessionIds.push(row.id);
    return { token, sid, row };
  }

  const authByCookie = (token: string) =>
    sdk.authenticateRequestWithSession({
      headers: { cookie: `app_session_id=${token}` },
    } as any);

  async function freshRow(id: number) {
    const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id));
    return row;
  }

  async function activeCountFor(userId: number) {
    const rows = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), eq(authSessions.status, "active")));
    return rows.length;
  }

  async function rawConn(): Promise<mysql.Connection> {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    return mysql.createConnection(url);
  }

  /** Fixture: fresh user with A + C active, B pending (third login). */
  async function activeActivePending() {
    await freshUser();
    const a = await mintV2("A device");
    const c = await mintV2("C device");
    const b = await mintV2("B device");
    expect(a.row.status).toBe("active");
    expect(c.row.status).toBe("active");
    expect(b.row.status).toBe("pending_choice");
    return { a, b, c };
  }

  // =====================================================================
  // T12 — revoke-vs-claim: a logout committing while the claim waits on the
  // row lock wins; the resumed claim no-ops on the FRESH terminal row.
  // Linearization point: maybeActivatePending's SELECT ... FOR UPDATE after
  // the slots lock (it re-reads post-commit state — F2 stale-snapshot guard).
  // =====================================================================
  it("T12: logout commits while the claim is blocked on the row lock → claim no-ops, row stays revoked", async () => {
    const { b, c } = await activeActivePending();
    await registry.revokeByToken(c.token); // slot frees

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `authSessions` WHERE `id` = ? FOR UPDATE", [b.row.id]);

      const claimPromise = registry
        .maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) })
        .catch(e => ({ error: e }));
      const waits = await waitForLockWaiters(blocker, 1, "T12 claim blocked on authSessions row", "authSessions");
      expect(waits.length).toBeGreaterThanOrEqual(1);

      // The logout lands (terminal transition) while the claim is parked.
      await blocker.query(
        "UPDATE `authSessions` SET `status` = 'revoked', `revokedReason` = 'user_logout' WHERE `id` = ? AND `status` IN ('active','pending_choice','unslotted_legacy')",
        [b.row.id]
      );
      await blocker.query("COMMIT");

      const claim = (await claimPromise) as any;
      expect(claim.status).toBe("revoked");
      expect(claim.revokedReason).toBe("user_logout");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    const finalRow = await freshRow(b.row.id);
    expect(finalRow!.status).toBe("revoked");
    // A + nobody: only the untouched A session remains active.
    const rows = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userU), eq(authSessions.status, "active")));
    expect(rows.map(r => r.clientLabel)).toEqual(["A device"]);
  });

  // =====================================================================
  // T13 — revoke-vs-auth (the active-branch TOCTOU this round fixes): a
  // logout committing while the request is parked on the row lock inside
  // session resolution must REJECT, never return the dead row as
  // ctx.authSession. Linearization point: the SDK's fresh re-read after the
  // wait (assertRegistryRowLive), preceded by the floor re-checks.
  // =====================================================================
  it("T13: logout commits while an authenticated request is blocked mid-resolution → the request is rejected session_revoked", async () => {
    const { a, b, c } = await activeActivePending(); // a active (the racing request), b pending, c active
    await registry.revokeByToken(b.token); // quiet the pending row

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `authSessions` WHERE `id` = ? FOR UPDATE", [a.row.id]);

      const authPromise = authByCookie(a.token).catch(e => e);
      await waitForLockWaiters(blocker, 1, "T13 auth blocked on active row", "authSessions");

      await blocker.query(
        "UPDATE `authSessions` SET `status` = 'revoked', `revokedReason` = 'user_logout' WHERE `id` = ? AND `status` IN ('active','pending_choice','unslotted_legacy')",
        [a.row.id]
      );
      await blocker.query("COMMIT");

      const err = (await authPromise) as any;
      expect(err).toBeInstanceOf(Error);
      expect(err.reason).toBe("session_revoked");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    expect((await freshRow(a.row.id))!.status).toBe("revoked");
    expect(await activeCountFor(userU)).toBe(1); // only c
  });

  // =====================================================================
  // T14 — supersede-vs-claim: a displacement (displaced_by_login) committing
  // while the claim waits wins over the claimer.
  // =====================================================================
  it("T14: displacement commits while the claim is blocked → claim no-ops, row stays superseded", async () => {
    const { b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `authSessions` WHERE `id` = ? FOR UPDATE", [b.row.id]);

      const claimPromise = registry
        .maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) })
        .catch(e => ({ error: e }));
      await waitForLockWaiters(blocker, 1, "T14 claim blocked", "authSessions");

      await blocker.query(
        "UPDATE `authSessions` SET `status` = 'superseded', `revokedReason` = 'displaced_by_login' WHERE `id` = ? AND `status` IN ('active','pending_choice','unslotted_legacy') AND `expiresAt` > NOW()",
        [b.row.id]
      );
      await blocker.query("COMMIT");

      const claim = (await claimPromise) as any;
      expect(claim.status).toBe("superseded");
      expect(claim.revokedReason).toBe("displaced_by_login");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    expect((await freshRow(b.row.id))!.status).toBe("superseded");
    expect(await activeCountFor(userU)).toBe(1);
  });

  // =====================================================================
  // T15 — expiry-vs-claim: the chooser window elapsing while the claim waits
  // on the row lock expires the row (DB time, inside the claim tx) — never
  // activates. Linearization point: the claim's DB-time deadline check on
  // the locked fresh row.
  // =====================================================================
  it("T15: chooser window elapses while the claim is blocked → the row flips superseded(expired), never active", async () => {
    const { b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);
    // Shorten B's pending deadline so it passes while B is parked on the lock.
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() + 1200) })
      .where(eq(authSessions.id, b.row.id));

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `authSessions` WHERE `id` = ? FOR UPDATE", [b.row.id]);

      const claimPromise = registry
        .maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) })
        .catch(e => ({ error: e }));
      await waitForLockWaiters(blocker, 1, "T15 claim blocked", "authSessions");

      // Hold past the deadline, then release WITHOUT changing the row.
      await new Promise(r => setTimeout(r, 1600));
      await blocker.query("COMMIT");

      const claim = (await claimPromise) as any;
      expect(claim.status).toBe("superseded");
      expect(claim.revokedReason).toBe("expired");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    const finalRow = await freshRow(b.row.id);
    expect(finalRow!.status).toBe("superseded");
    expect(finalRow!.revokedReason).toBe("expired");
    // The SDK floor rejects the dead cookie (the first floor check classifies
    // a terminal superseded row as session_revoked; both classes clear the
    // cookie and resolve anonymous).
    await expect(authByCookie(b.token)).rejects.toMatchObject({
      reason: "session_revoked",
    });
    expect(await activeCountFor(userU)).toBe(1);
  });

  // =====================================================================
  // T16 — claim-vs-claim linearization at the SLOTS lock: both claims park on
  // the user's single sessionSlots row; the first to acquire recomputes and
  // takes the slot, the second's LOCKING recount (R4/IR-04) sees the quota
  // full. Linearization point: slots-row lock acquisition order.
  // =====================================================================
  it("T16: two claims parked on the slots lock serialize — exactly one wins, active never exceeds 2", async () => {
    const { a, b, c } = await activeActivePending();
    const d = await mintV2("D device");
    expect(d.row.status).toBe("pending_choice");
    await registry.revokeByToken(c.token); // exactly one slot frees

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `sessionSlots` WHERE `userId` = ? FOR UPDATE", [userU]);

      const exp = new Date(Date.now() + SESSION_30D_MS);
      const pB = registry
        .maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: exp })
        .catch(e => ({ error: e }));
      const pD = registry
        .maybeActivatePending({ sessionId: d.row.id, activateExpiresAt: exp })
        .catch(e => ({ error: e }));
      const waits = await waitForLockWaiters(blocker, 2, "T16 both claims parked on slots lock", "sessionSlots");
      expect(waits.length).toBe(2);

      await blocker.query("COMMIT"); // release; claims serialize on acquisition order

      const [rB, rD] = (await Promise.all([pB, pD])) as any[];
      const statuses = [rB.status, rD.status].sort();
      expect(statuses).toEqual(["active", "pending_choice"]);
      expect(await activeCountFor(userU)).toBe(2);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    expect((await freshRow(a.row.id))!.status).toBe("active");
  });

  // =====================================================================
  // T17 — gate-level terminal rejection: even a hand-built ctx carrying a
  // terminal row is rejected by requireUser (every user-bearing chain,
  // including the sessionSelf allowlist) and by requireSessionSlotResolved.
  // =====================================================================
  it("T17: a revoked/superseded authSession in the context is rejected by the user chain and the slot gate", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(a.token);
    await registry.revokeByToken(c.token);
    // Make B superseded (by_rotation) so both terminal statuses are covered.
    await db
      .update(authSessions)
      .set({ status: "superseded", revokedReason: "by_rotation" })
      .where(eq(authSessions.id, b.row.id));
    const revokedRow = await freshRow(a.row.id);
    const supersededRow = await freshRow(b.row.id);

    const ctxFor = (row: any): TrpcContext => ({
      user: {
        id: userU,
        openId: userOpenId,
        email: "r8b4e@example.test",
        name: "R8B4E",
        loginMethod: "test",
        role: "user",
      } as TrpcContext["user"],
      authSession: row ?? null,
      authSessionExpiresAt: row ? new Date(Date.now() + SESSION_30D_MS) : null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: () => undefined } as TrpcContext["res"],
    });

    // requireUser guard (covers sessionSelfProcedure allowlist — sessions.list)
    await expect(appRouter.createCaller(ctxFor(revokedRow)).auth.sessions.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // requireSessionSlotResolved guard (authenticatedProcedure chain — sessions.revoke)
    await expect(
      appRouter.createCaller(ctxFor(revokedRow)).auth.sessions.revoke({ sessionId: supersededRow.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // superseded rows are equally terminal on both chains
    await expect(appRouter.createCaller(ctxFor(supersededRow)).auth.sessions.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    void supersededRow;
  });

  // =====================================================================
  // T18 — rotation-supersede-vs-auth: a same-session rotation superseding
  // the active row while a request is parked mid-resolution rejects that
  // request at the last read (superseded is terminal on the floor, same as
  // revoked).
  // =====================================================================
  it("T18: rotation supersede commits while an authenticated request is blocked → the request is rejected session_revoked", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(b.token);

    const blocker = await rawConn();
    try {
      await blocker.query("SET autocommit=0");
      await blocker.query("SELECT * FROM `authSessions` WHERE `id` = ? FOR UPDATE", [a.row.id]);

      const authPromise = authByCookie(a.token).catch(e => e);
      await waitForLockWaiters(blocker, 1, "T18 auth blocked", "authSessions");

      await blocker.query(
        "UPDATE `authSessions` SET `status` = 'superseded', `revokedReason` = 'by_rotation' WHERE `id` = ? AND `status` = 'active' AND `expiresAt` > NOW()",
        [a.row.id]
      );
      await blocker.query("COMMIT");

      const err = (await authPromise) as any;
      expect(err).toBeInstanceOf(Error);
      expect(err.reason).toBe("session_revoked");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    expect((await freshRow(a.row.id))!.status).toBe("superseded");
    expect(await activeCountFor(userU)).toBe(1); // only c
  });

  // =====================================================================
  // T19 — claim-then-logout ordering: when the claim WINS the race (activates
  // first), a logout landing afterwards still flips the row revoked and
  // REPORTS it — durable revocation wins under every interleaving.
  // =====================================================================
  it("T19: claim activates first, logout lands after → final status revoked and the logout reports durable revocation", async () => {
    const { b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);

    const claimed = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(claimed!.status).toBe("active");

    const outcome = await registry.revokeByToken(b.token);
    expect(outcome).toBe("revoked");
    expect((await freshRow(b.row.id))!.status).toBe("revoked");
    // The next request after the logout is rejected by the floor (cookie cleared upstream).
    await expect(authByCookie(b.token)).rejects.toMatchObject({ reason: "session_revoked" });
    expect(await activeCountFor(userU)).toBe(1); // only the untouched A session
  });
});
