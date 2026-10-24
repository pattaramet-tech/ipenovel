import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getTestDb } from "./test-helpers/testDb";
import { __setDbForTests } from "./db";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import * as registry from "./services/sessionRegistry";
import * as leaseService from "./services/readingLease";
import { authSessions, readingLeases, sessionSlots, users } from "../drizzle/schema";

/**
 * R4/IR-03 — durable-revoke TRUTH against the real registry (integration):
 * logout distinguishes revoked / not_found, keeps clearing the cookie, and
 * the revocation is DURABLE — the token replay is rejected by the registry,
 * not merely by the missing browser cookie.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("no id");
  return id;
}

describe("R4/IR-03 — logout durable-revoke truth (integration)", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  let userA = 0;

  beforeAll(async () => {
    __setDbForTests(db);
    process.env.READER_SESSION_CONTROLS = "true";
    userA = insertId(await db.insert(users).values({
      openId: `r4ir3-${tag}`,
      name: "IR03",
      email: `r4ir3-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
  });

  afterAll(async () => {
    process.env.READER_SESSION_CONTROLS = "false";
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    await db.delete(authSessions).where(eq(authSessions.userId, userA));
    await db.delete(sessionSlots).where(eq(sessionSlots.userId, userA));
    await db.delete(users).where(eq(users.id, userA));
  });

  async function activeSession() {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r4ir3-${tag}`, { sid, expiresInMs: 30 * 86400000 });
    const row = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: new Date(Date.now() + 30 * 86400000),
      createdVia: "google",
    });
    return { token, row };
  }

  function logoutCaller(token: string | null) {
    const cleared: Array<{ name: string }> = [];
    const caller = appRouter.createCaller({
      user: null,
      authSession: null,
      authSessionExpiresAt: null,
      req: { protocol: "https", headers: token ? { cookie: `app_session_id=${token}` } : {} },
      res: { clearCookie: (name: string) => cleared.push({ name }) },
    } as any);
    return { caller, cleared };
  }

  it("live session logout → 'revoked', row revoked, lease killed in same tx, token replay rejected", async () => {
    const { token, row } = await activeSession();
    await db.insert(readingLeases).values({
      userId: userA,
      holderSessionId: row.id,
      leaseVersion: 5,
      acquiredAt: new Date(),
      expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
    });

    const { caller, cleared } = logoutCaller(token);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "revoked" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);

    const after = (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
    expect(after.status).toBe("revoked");

    // Durable: replay the SAME token — the registry rejects it, not the
    // missing browser cookie.
    await expect(
      sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${token}` } } as any),
    ).rejects.toMatchObject({ reason: "session_revoked" });

    // Same-tx lease invalidation (F preserved).
    const lease = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userA)))[0];
    expect(lease.leaseVersion).toBe(6);
    expect(new Date(lease.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it("re-logout of an already-revoked token → still truthfully 'revoked' (revocation holds)", async () => {
    const { token } = await activeSession();
    const first = await logoutCaller(token).caller.auth.logout();
    expect(first.durableRevocation).toBe("revoked");
    const second = await logoutCaller(token).caller.auth.logout();
    expect(second).toEqual({ success: true, durableRevocation: "revoked" });
  });

  it("unknown/garbage token → 'not_found', cookie still cleared", async () => {
    const { caller, cleared } = logoutCaller(`app_session_id=does-not-exist-${tag}`);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "not_found" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
  });

  it("no cookie → 'not_found', nothing invoked, cookie cleared", async () => {
    const { caller, cleared } = logoutCaller(null);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "not_found" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
  });

  it("flag OFF: the revocation floor still applies and reports truthfully", async () => {
    const { token, row } = await activeSession();
    expect(row.status).toBe("active");
    process.env.READER_SESSION_CONTROLS = "false";
    try {
      const { caller } = logoutCaller(token);
      const result = await caller.auth.logout();
      expect(result.durableRevocation).toBe("revoked");
      const after = (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
      expect(after.status).toBe("revoked");
    } finally {
      process.env.READER_SESSION_CONTROLS = "true";
    }
  });

  it("typing guard: lease of the revoked session cannot renew (typed SESSION_NOT_ACTIVE)", async () => {
    await db.delete(readingLeases).where(eq(readingLeases.userId, userA));
    const { token, row } = await activeSession();
    await db.insert(readingLeases).values({
      userId: userA,
      holderSessionId: row.id,
      leaseVersion: 1,
      acquiredAt: new Date(),
      expiresAt: sql`NOW() + INTERVAL 300 SECOND`,
    });
    await logoutCaller(token).caller.auth.logout();
    const renew = await leaseService.renewLease({ sessionId: row.id, userId: userA, leaseVersion: 1 });
    expect(renew).toMatchObject({ ok: false, code: "SESSION_NOT_ACTIVE" });
  });
});
