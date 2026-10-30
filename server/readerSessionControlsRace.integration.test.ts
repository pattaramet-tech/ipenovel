import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { __setDbForTests } from "./db";
import * as registry from "./services/sessionRegistry";
// R40R61R1: the race-attribution connection MUST be the SAME MySQL instance
// as the test database - previously hardcoded to the IPE-070R4B author's own
// container (root@127.0.0.1:3311), which split the barrier across two
// servers and broke sys.innodb_lock_waits attribution. Now guarded through
// TEST_DATABASE_URL with a live DATABASE() = ipenovel_test check before any
// transaction. Never falls back to DATABASE_URL.
async function openAttributionConnection(): Promise<mysql.Connection> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  assertSafeTestDatabaseUrl(url);
  const conn = await mysql.createConnection(url);
  const [rows] = await conn.query("SELECT DATABASE() AS db");
  const dbName = (rows as any[])[0]?.db;
  if (dbName !== "ipenovel_test") {
    await conn.end();
    throw new Error(`Attribution connection must target ipenovel_test, got: ${String(dbName)}`);
  }
  return conn;
}

import * as leaseService from "./services/readingLease";
import { authSessions, readingLeases, sessionSlots, users } from "../drizzle/schema";

/**
 * R3 race/red proofs (F1/F2) — REAL concurrency over the shared pool
 * (mysql2 pool serves each transaction on its own connection) plus a
 * deterministic third-connection lock interleave.
 *
 * RED here = the R2 failure modes this round repairs:
 *  - RA: concurrent acquire of the same fresh lease → raw ER_DUP_ENTRY (untyped 500-class)
 *  - RC: promotion vs revoke race → terminal (revoked) row revived to active
 *  - RD: same legacy cookie adopted from two tabs concurrently → raw duplicate error
 *  - RE: pending_choice row expires at JWT exp (30 days) instead of min(exp, NOW+30m)
 *  - RH: transfer with no lease row → raw TypeError (500-class)
 *
 * These tests are written BEFORE the core repair (red), then kept as the
 * permanent green regression after it.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("no id");
  return id;
}

describe("R3 Reader Session Controls — race/red proofs", () => {
  function setFlagTrue() { process.env.READER_SESSION_CONTROLS = "true"; }
  function setFlagFalse() { process.env.READER_SESSION_CONTROLS = "false"; }
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  let userR = 0;
  const sessionIds: number[] = [];

  beforeAll(async () => {
    __setDbForTests(db);
    userR = insertId(await db.insert(users).values({
      openId: `r3-${tag}`,
      name: "R3 Racer",
      email: `r3-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
  });

  afterAll(async () => {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userR));
    await db.delete(authSessions).where(eq(authSessions.userId, userR));
    await db.delete(sessionSlots).where(eq(sessionSlots.userId, userR));
    await db.delete(users).where(eq(users.id, userR));
  });

  async function freshActiveSession(): Promise<{ id: number }> {
    const sid = `r3-${randomUUID().slice(0, 12)}`;
    const [row] = await db.insert(authSessions).values({
      userId: userR,
      sid,
      tokenHash: `th-${sid}-${randomUUID().slice(0, 8)}`,
      tokenVersion: 2,
      status: "active",
      loginAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      createdVia: "google",
    }).$returningId();
    const id = Number(row.id);
    sessionIds.push(id);
    return { id };
  }

  async function seedExpiredLease() {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userR));
    await db.insert(readingLeases).values({
      userId: userR,
      holderSessionId: sessionIds[0],
      leaseVersion: 1,
      acquiredAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 500),
    });
  }

  it("RA: concurrent acquire of a fresh lease — every settled result TYPED, exactly one winner, one row", async () => {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userR));
    const s1 = await freshActiveSession();
    const s2 = await freshActiveSession();
    const results = await Promise.allSettled([
      leaseService.acquireLease({ sessionId: s1.id, userId: userR }),
      leaseService.acquireLease({ sessionId: s2.id, userId: userR }),
    ]);
    // IR-04 strict contract: NO raw rejection of ANY kind is accepted —
    // the deadlock-retry layer must resolve every race into a typed outcome.
    // (previously: any rejection whose message was not "Duplicate entry"
    // slipped through.)
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") {
        const typed = (r.value as { ok: boolean; code?: string }).ok === true ||
          (r.value as { ok: false; code: string }).ok === false;
        expect(typed).toBe(true);
        if ((r.value as { ok: boolean }).ok === false) {
          expect(["LEASE_HELD", "SESSION_NOT_ACTIVE"]).toContain((r.value as { code: string }).code);
        }
      }
    }
    const winners = results.filter(r => r.status === "fulfilled" && (r.value as { ok: boolean }).ok);
    expect(winners.length).toBe(1);
    const winnerId = (winners[0] as PromiseFulfilledResult<{ ok: true; leaseVersion: number }>).value;
    void winnerId;
    const [lease] = await db.select().from(readingLeases).where(eq(readingLeases.userId, userR));
    expect(lease).toBeDefined();
    expect([s1.id, s2.id]).toContain(lease.holderSessionId);
    // cleanup invariant: the winner actually holds the live lease
    expect(await registry.sessionHoldsLease(lease.holderSessionId)).toBe(true);
  });

  it("RC: promotion vs revoke race — revoke outcome asserted, final terminal status exact, never revived", async () => {
    const target = await freshActiveSession();
    // park the row at unslotted_legacy (the only state promotion may move)
    await db.update(authSessions).set({ status: "unslotted_legacy" }).where(eq(authSessions.id, target.id));

    // Deterministic interleave: hold the session row lock on a raw
    // connection; queue REVOKE FIRST then promotion. Both must be observed
    // in sys.innodb_lock_waits as blocked BY THIS connection (attributable,
    // not a global count). After release the revoke commits first → row
    // revoked; the queued promotion re-reads a terminal row and must NOT
    // revive it.
    const raw = await openAttributionConnection();
    try {
      await raw.query("SET time_zone = '+00:00'");
      await raw.beginTransaction();
      await raw.query("SELECT id FROM authSessions WHERE id = ? FOR UPDATE", [target.id]);

      const revokeP = registry.revokeOwnSession({ userId: userR, sessionId: target.id });
      // attributable wait for the revoke (blocked by THIS connection)
      const deadline1 = Date.now() + 15000;
      let waits: any[] = [];
      while (Date.now() < deadline1) {
        const [rows] = await raw.query(
          "SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits WHERE blocking_pid = CONNECTION_ID()"
        );
        waits = rows as any[];
        if (waits.length >= 1) break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(waits.length).toBeGreaterThanOrEqual(1);
      const promoteP = registry.maybePromoteUnslotted(target.id);
      const deadline2 = Date.now() + 15000;
      while (Date.now() < deadline2) {
        const [rows] = await raw.query(
          "SELECT waiting_pid, blocking_pid FROM sys.innodb_lock_waits WHERE blocking_pid = CONNECTION_ID()"
        );
        waits = rows as any[];
        if (waits.length >= 2) break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(waits.length).toBeGreaterThanOrEqual(2); // BOTH attributable waiters
      await raw.commit();
      const [revokeResult, promoted] = await Promise.all([revokeP, promoteP]);
      // Returned outcomes asserted per the fixture: revoke was queued first
      // and MUST have revoked (true); the promotion must NOT have revived
      // the terminal row (returns it as-is or no row — never active).
      expect(revokeResult).toBe(true);
      if (promoted) {
        expect(promoted.status).not.toBe("active");
      }
    } catch (error) {
      await raw.rollback().catch(() => {});
      await raw.end().catch(() => {});
      throw error;
    }
    await raw.end();

    const after = (await db.select().from(authSessions).where(eq(authSessions.id, target.id)))[0];
    expect(after.status).toBe("revoked"); // exact terminal status, not one-of-three
    expect(after.status).not.toBe("active"); // terminal revival = the F2 bug
  });

  it("RD: same legacy cookie adopted from two tabs concurrently — SAME row id returned to both, exactly one row", async () => {
    setFlagTrue();
    const legacyToken = `legacy-${tag}-${randomUUID().slice(0, 8)}`;
    const results = await Promise.allSettled([
      registry.adoptLegacySession({ userId: userR, token: legacyToken, expiresAt: new Date(Date.now() + 86400000) }),
      registry.adoptLegacySession({ userId: userR, token: legacyToken, expiresAt: new Date(Date.now() + 86400000) }),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value).not.toBeNull();
    }
    // IR-04: both callers must receive the SAME adopted row id (idempotent
    // adoption), and the registry must hold EXACTLY one row for this cookie.
    const ids = results.map(r =>
      r.status === "fulfilled" ? (r.value as { id: number } | null)?.id : undefined
    );
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
    const rows = (await db.select().from(authSessions).where(eq(authSessions.userId, userR)))
      .filter(r => r.tokenVersion === 1 && r.tokenHash !== null);
    const thisCookie = rows.filter(r => r.tokenHash === registry.sha256Token(legacyToken));
    expect(thisCookie.length).toBe(1);
    expect(thisCookie[0].id).toBe(ids[0]);
  });

  it("RE: pending_choice rows expire at min(JWT exp, NOW+30m) — the pending-TTL branch is FORCED, never accepted as active", async () => {
    setFlagTrue();
    // IR-04: force the pending branch deterministically — fill BOTH slots
    // with standing actives BEFORE the mint, so the third login cannot race
    // into "active". The old version accepted "active" as still-fine.
    const filler1 = await freshActiveSession();
    const filler2 = await freshActiveSession();
    void filler1;
    void filler2;
    const sid = `r3-pend-${randomUUID().slice(0, 8)}`;
    const token = await sdkMint(`r3-${tag}`, sid);
    const row = await registry.allocateSessionRow({
      userId: userR,
      token,
      sid,
      expiresAt: new Date(Date.now() + 30 * 86400000), // JWT exp: 30 days out
      createdVia: "google",
    });
    sessionIds.push(row.id);
    expect(row.status).toBe("pending_choice"); // forced — no active fallback
    const ttlMs = row.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(31 * 60 * 1000); // ≤ ~30m (+skew)
    expect(ttlMs).toBeGreaterThan(25 * 60 * 1000);
    setFlagFalse();
  });

  it("RH: transfer with NO lease row returns a typed acquire outcome — never a raw TypeError/500", async () => {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userR));
    const s = await freshActiveSession();
    const outcome = await leaseService.transferLease({ sessionId: s.id, userId: userR });
    expect(outcome.ok).toBe(true);
    const [lease] = await db.select().from(readingLeases).where(eq(readingLeases.userId, userR));
    expect(lease.holderSessionId).toBe(s.id);
  });

  // sdk mint helper (v2 token, same shape the callbacks produce)
  async function sdkMint(openId: string, sid: string): Promise<string> {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode("integration-test-only-jwt-secret-0123456789abcdef");
    return new SignJWT({ openId, appId: "ipenovel-integration-test-app", name: "R3", sid, tv: 2 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 30 * 86400)
      .setIssuer("ipenovel-session").setAudience("ipenovel-integration-test-app")
      .sign(secret);
  }
  void sql;
});
