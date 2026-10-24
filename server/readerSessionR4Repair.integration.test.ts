import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getTestDb } from "./test-helpers/testDb";
import { __setDbForTests } from "./db";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import type { TrpcContext } from "./_core/context";
import * as registry from "./services/sessionRegistry";
import { authSessions, sessionSlots, users } from "../drizzle/schema";

/**
 * R4 — RED tests for the bounded contract repair (R3-A..G as enumerated in
 * the Owner brief). Written against the CURRENT R3 source FIRST; the failing
 * assertions are the proof of the reported defects. GREEN expected only
 * after the repairs land (same file, same fixtures).
 *
 * Defects under test:
 *  - C-cut: a RESOLVED pending login keeps its 30-minute registry deadline
 *    instead of the verified JWT expiry (resolved login cut at 30m).
 *  - E: auth.sessions.revoke is reachable by a pending_choice session
 *    (outside the exact pending allowlist me/list/resolveThirdLogin/logout).
 *  - G: raw (unsanitized) OAuth debug logging in googleOAuth.ts.
 *  - F6: strict tv/sid/userId binding (owner mismatch must fail).
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("no id");
  return id;
}

describe("R4 — bounded contract repair (red first)", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const SESSION_30D_MS = 30 * 86400000;
  let userA = 0;
  const sessionIds: number[] = [];
  // rowId → the VERIFIED JWT exp the harness would put in ctx (mirrors
  // createContext.authSessionExpiresAt).
  const expByRowId = new Map<number, Date>();

  beforeAll(async () => {
    __setDbForTests(db);
    // The session gate + reconcile-before-rights are flag-gated: ON.
    process.env.READER_SESSION_CONTROLS = "true";
    userA = insertId(await db.insert(users).values({
      openId: `r4-${tag}`,
      name: "R4 User",
      email: `r4-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
  });

  afterAll(async () => {
    process.env.READER_SESSION_CONTROLS = "false";
    await db.delete(authSessions).where(eq(authSessions.userId, userA));
    await db.delete(sessionSlots).where(eq(sessionSlots.userId, userA));
    await db.delete(users).where(eq(users.id, userA));
  });

  async function allocate(params: {
    status?: "active" | "pending_choice";
    sid?: string;
    expiresAt?: Date;
  }) {
    // sid shape mirrors generateSid() (base64url, 16–64 chars) — the strict
    // R4/C claim check rejects anything shorter/malformed.
    const sid = params.sid ?? `r4${randomUUID().replace(/-/g, "")}`;
    const token = await sdk.createSessionToken(`r4-${tag}`, { sid, expiresInMs: SESSION_30D_MS });
    const row = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: params.expiresAt ?? new Date(Date.now() + SESSION_30D_MS),
      createdVia: "google",
    });
    sessionIds.push(row.id);
    expByRowId.set(row.id, new Date(Date.now() + SESSION_30D_MS));
    if (params.status && row.status !== params.status) {
      await db.update(authSessions).set({ status: params.status }).where(eq(authSessions.id, row.id));
      return (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
    }
    return row;
  }

  function callerFor(row: any, role: string = "user") {
    const user = {
      id: userA, openId: `r4-${tag}`, email: `r4-${tag}@t.test`, name: "R4",
      loginMethod: "test", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as TrpcContext["user"];
    return appRouter.createCaller({
      user,
      authSession: row,
      authSessionExpiresAt: expByRowId.get(row.id) ?? null,
      req: { protocol: "https", headers: {} } as any,
      res: {} as any,
    });
  }

  it("R4-RED/C: a RESOLVED pending login is NOT cut at the 30m registry deadline — its deadline becomes the verified JWT expiry", async () => {
    // Fill both slots → third mint is pending (30m registry deadline).
    await allocate({ status: "active" });
    await allocate({ status: "active" });
    const pending = await allocate({}); // allocator → pending_choice (expires ≈ NOW+30m)
    expect(pending.status).toBe("pending_choice");
    const pendingDeadlineBefore = pending.expiresAt.getTime();
    expect(pendingDeadlineBefore - Date.now()).toBeLessThanOrEqual(31 * 60 * 1000);

    // The user resolves the chooser by displacing the FIRST active session.
    const firstActive = (await db.select().from(authSessions).where(eq(authSessions.userId, userA)))
      .filter(r => r.status === "active")
      .sort((a, b) => a.id - b.id)[0]!;
    const caller = callerFor(pending);
    await caller.auth.sessions.resolveThirdLogin({ displaceSessionId: firstActive.id });

    // FIXED contract: the activated session's deadline must now be the FULL
    // session term (the verified JWT exp ≈ mint + 30d), NOT the 30-minute
    // pending cut. (Pre-fix this stayed at ≈ NOW+30m.)
    const after = (await db.select().from(authSessions).where(eq(authSessions.id, pending.id)))[0];
    expect(after.status).toBe("active");
    const daysToExpiry = (after.expiresAt.getTime() - Date.now()) / 86400000;
    expect(daysToExpiry).toBeGreaterThan(29); // ≈ 30d, not minutes/hours
  });

  it("R4-RED/E: auth.sessions.revoke is GATED for a pending_choice session (exact allowlist)", async () => {
    const pending = await allocate({ status: "pending_choice" });
    const caller = callerFor(pending);
    // Exact pending allowlist = me/list/resolveThirdLogin/logout ONLY.
    // revoke is NOT on it — a pending session must resolve (or logout), it
    // may not evict OTHER sessions before it holds a slot itself.
    await expect(
      caller.auth.sessions.revoke({ sessionId: pending.id })
    ).rejects.toMatchObject({ cause: { code: "SESSION_SLOT_PENDING" } });
  });

  it("R4-RED/F6: strict owner binding — a session row owned by a DIFFERENT user never authenticates", async () => {
    const attacker = insertId(await db.insert(users).values({
      openId: `r4-x-${tag}`, name: "X", email: `r4x-${tag}@t.test`, loginMethod: "test", role: "user",
    }));
    // attacker presents a cookie whose sid row is OWNED by userA
    const victimSid = `r4victim${randomUUID().replace(/-/g, "")}`;
    const victimToken = await sdk.createSessionToken(`r4-${tag}`, { sid: victimSid });
    await registry.allocateSessionRow({
      userId: userA, token: victimToken, sid: victimSid,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    // attacker mints their OWN v2 token carrying the VICTIM's sid
    const attackerToken = await sdk.createSessionToken(`r4-x-${tag}`, { sid: victimSid });
    await expect(
      sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${attackerToken}` } } as any)
    ).rejects.toMatchObject({ reason: "invalid_session_token" });
    void attacker;
  });

  it("R4-RED/F6: expired-by-DB-time non-terminal row is flipped superseded and rejected (DB-time expiry)", async () => {
    const sid = `r4exp${randomUUID().replace(/-/g, "")}`;
    const token = await sdk.createSessionToken(`r4-${tag}`, { sid });
    const row = await registry.allocateSessionRow({
      userId: userA, token, sid,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    sessionIds.push(row.id);
    // Force the DB deadline into the past directly (DB-time semantics).
    await db
      .update(authSessions)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(authSessions.id, row.id));

    await expect(
      sdk.authenticateRequestWithSession({ headers: { cookie: `app_session_id=${token}` } } as any)
    ).rejects.toMatchObject({ reason: "invalid_session_token" });
    const after = (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
    expect(after.status).toBe("superseded"); // flipped expired, terminal
  });

  it("R4-RED/G: googleOAuth.ts carries NO raw (unsanitized) debug logging", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("server/_core/googleOAuth.ts", "utf8");
    expect(src).not.toMatch(/console\.log\("\[R3CB\]/); // raw String(error) channel
    // sanitized channel retained
    expect(src).toContain('console.error("[GoogleOAuth] Callback failed:", safeErrorSummary(error))');
  });
});
