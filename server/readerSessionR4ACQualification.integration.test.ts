import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import { __setDbForTests } from "./db";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import * as registry from "./services/sessionRegistry";
import * as leaseService from "./services/readingLease";
import {
  authSessions,
  episodes,
  novels,
  readingLeases,
  sessionSlots,
  users,
} from "../drizzle/schema";

/**
 * R4R7 — remaining original-AC qualification matrix (A/B/C/E/F).
 *
 * Bounds (per the R4R6 independent review, Review-Key 8b8c25ca|5eb0fe09):
 *  - NO application source is changed by this file; it executes the EXISTING
 *    R4 repairs through their REAL paths (SDK auth → context → tRPC caller,
 *    and the typed lease/registry services under real row locks).
 *  - A (PAT-6): OFF mint 4 → ON → FIRST direct authenticated SDK request
 *    reconciles to active2+unslotted2 — for both a JUST-touched lastSeen
 *    (the 60s-throttle regression) and a stale lastSeen — and the rights
 *    after the reconcile reflect the POST-reconciliation status. Never via
 *    sessions.list and never by calling reconcileAfterFlagOn directly.
 *  - B (PAT-7): app/DB clock skew ±120s (faked app clock, real DB NOW()):
 *    DB-live lease cannot be stolen by acquire; DB-expired lease acquires;
 *    expired session renew/transfer are typed SESSION_NOT_ACTIVE with no
 *    mutation; stale leaseVersion never mutates the row.
 *  - C (PAT-8): pending past its chooser deadline cannot resolve; a resolved
 *    login's deadline becomes the VERIFIED JWT exp (nondefault TTL), so it
 *    still authenticates past the 30m chooser mark while the JWT lives; a
 *    finally-expired JWT rejects; legacy adoption inherits the verified exp.
 *    (Strict tv/sid/exp claim shapes stay covered by
 *    sessionClaimShape.integration.test.ts — deliberately NOT re-implemented.)
 *  - E (PAT-10): the exact pending allowlist (me/list/resolveThirdLogin/
 *    logout) succeeds; every business chain (User / Author / Admin) and
 *    auth.sessions.revoke is denied with SESSION_SLOT_PENDING; active and
 *    unslotted rows keep their non-reading rights.
 *  - F (PAT-11): with the flag OFF, a captured cookie is durably dead after
 *    logout — replay through the SDK auth path, the full request path and a
 *    lease mutation is rejected/typed, and the row stays terminal.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

const MINUTE_MS = 60 * 1000;
const SESSION_30D_MS = 30 * 86400000;

function setFlag(on: boolean) {
  process.env.READER_SESSION_CONTROLS = on ? "true" : "false";
}

/** Fakes ONLY the app clock (Date), leaving timers and the DB real. */
function skewAppClock(deltaMs: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + deltaMs);
}
function resetAppClock() {
  vi.useRealTimers();
}

describe("R4R7 — remaining AC qualification (A/B/C/E/F)", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const createdUserIds: number[] = [];
  const createdSessionIds: number[] = [];
  let paidNovel = 0;
  let paidEpisode = 0;

  let userARecent = 0;
  let userAStale = 0;
  let userB = 0;
  let userC = 0;
  let userC2 = 0;
  let userC3 = 0;
  let userC4 = 0;
  let userE = 0;
  let userEAdmin = 0;
  let userEAuthor = 0;
  let userEUnslotted = 0;
  let userF = 0;

  beforeAll(async () => {
    __setDbForTests(db);
    setFlag(true);
    const mk = async (label: string, role: string = "user") => {
      const id = insertId(await db.insert(users).values({
        openId: `r4r7-${label}-${tag}`,
        name: `R4R7 ${label}`,
        email: `r4r7-${label}-${tag}@example.test`,
        loginMethod: "test",
        role,
      }));
      createdUserIds.push(id);
      return id;
    };
    userARecent = await mk("a-recent");
    userAStale = await mk("a-stale");
    userB = await mk("b");
    userC = await mk("c1");
    userC2 = await mk("c2");
    userC3 = await mk("c3");
    userC4 = await mk("c4");
    userE = await mk("e-user");
    userEAdmin = await mk("e-admin", "admin");
    userEAuthor = await mk("e-author", "author");
    userEUnslotted = await mk("e-unslotted");
    userF = await mk("f");

    // A real published PAID episode: lease surfaces look the episode up
    // before any lease/session decision, so a non-existent episode would
    // mask the typed outcomes under test with NOT_FOUND.
    paidNovel = insertId(await db.insert(novels).values({
      title: `R4R7 paid novel ${tag}`,
      slug: `r4r7-paid-${tag}`,
      author: "R4R7",
      authorUserId: null,
      publicationStatus: "published",
      storyStatus: "ongoing",
    }));
    paidEpisode = insertId(await db.insert(episodes).values({
      novelId: paidNovel,
      episodeNumber: `r4r7-p1-${tag}`,
      title: "R4R7 paid chapter",
      price: "20.00",
      isFree: false,
      isPublished: true,
      saleMode: "chapter",
      content: "R4R7 PAID CONTENT",
    }));
  });

  afterAll(async () => {
    setFlag(false);
    __setDbForTests(null);
    if (createdSessionIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.id, createdSessionIds));
    }
    await db.delete(authSessions).where(inArray(authSessions.userId, createdUserIds));
    await db.delete(readingLeases).where(inArray(readingLeases.userId, createdUserIds));
    await db.delete(sessionSlots).where(inArray(sessionSlots.userId, createdUserIds));
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
    await db.delete(episodes).where(eq(episodes.id, paidEpisode));
    await db.delete(novels).where(eq(novels.id, paidNovel));
  });

  /** Mints a v2 cookie + registry row (allocator decides status per flag/slots). */
  async function mintV2(
    userId: number,
    openId: string,
    opts?: { expiresInMs?: number; expiresAt?: Date; forceStatus?: "pending_choice" | "active" }
  ) {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(openId, {
      sid,
      expiresInMs: opts?.expiresInMs ?? SESSION_30D_MS,
    });
    const row = await registry.allocateSessionRow({
      userId,
      token,
      sid,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + (opts?.expiresInMs ?? SESSION_30D_MS)),
      createdVia: "google",
    });
    createdSessionIds.push(row.id);
    if (opts?.forceStatus && row.status !== opts.forceStatus) {
      await db.update(authSessions).set({ status: opts.forceStatus }).where(eq(authSessions.id, row.id));
      return { token, sid, row: (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0] };
    }
    return { token, sid, row };
  }

  async function mintLegacyV1(openId: string, expiresInMs: number = SESSION_30D_MS) {
    return sdk.createSessionToken(openId, { name: "R4R7 legacy", expiresInMs });
  }

  function userFor(userId: number, openId: string, role: string = "user"): TrpcContext["user"] {
    return {
      id: userId,
      openId,
      email: `${openId}@example.test`,
      name: openId,
      loginMethod: "test",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"];
  }

  function callerFor(userId: number, openId: string, sessionRow: any, opts?: { role?: string; jwtExp?: Date | null; cookie?: string }) {
    return appRouter.createCaller({
      user: userFor(userId, openId, opts?.role),
      authSession: sessionRow ?? null,
      // Mirrors createContext.authSessionExpiresAt — the VERIFIED JWT exp of
      // the presented cookie (what resolveThirdLogin must inherit).
      authSessionExpiresAt: opts?.jwtExp ?? (sessionRow ? new Date(Date.now() + SESSION_30D_MS) : null),
      req: {
        protocol: "https",
        headers: opts?.cookie ? { cookie: `app_session_id=${opts.cookie}` } : {},
      } as TrpcContext["req"],
      res: { clearCookie: () => undefined } as TrpcContext["res"],
    });
  }

  const authByCookie = (token: string) =>
    sdk.authenticateRequestWithSession({
      headers: { cookie: `app_session_id=${token}` },
    } as any);

  async function freshRow(id: number) {
    const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id));
    return row;
  }

  async function rowsOf(userId: number) {
    return db.select().from(authSessions).where(eq(authSessions.userId, userId));
  }

  // =====================================================================
  // A (PAT-6): OFF→ON reconciliation through the REAL auth path
  // =====================================================================

  for (const variant of ["recent", "stale"] as const) {
    it(`A/${variant}: OFF mint 4 → ON → FIRST direct authenticated SDK request reconciles to active 2 + unslotted 2 (${variant} lastSeen) and rights reflect the post-reconcile status`, async () => {
      const userId = variant === "recent" ? userARecent : userAStale;
      const openId = `r4r7-a-${variant}-${tag}`;
      setFlag(false);
      try {
        // 4 off-path mints → all active (quota unenforced), NO auth yet.
        const mints = [];
        for (let i = 0; i < 4; i++) mints.push(await mintV2(userId, openId));
        expect((await rowsOf(userId)).every((r) => r.status === "active")).toBe(true);

        // Deterministic ranking: row i is the (i+1)-th most recent.
        // recent variant: all four INSIDE the 60s throttle window (the
        // regression: a skipped throttled touch used to skip the reconcile).
        // stale variant: minutes-old lastSeen (touch will run).
        for (let i = 0; i < 4; i++) {
          const offset = variant === "recent" ? `${(i + 1) * 5} SECOND` : `${(i + 1) * 10} MINUTE`;
          await db
            .update(authSessions)
            .set({ lastSeenAt: sql`NOW() - INTERVAL ${sql.raw(offset)}` })
            .where(eq(authSessions.id, mints[i].row.id));
        }

        setFlag(true);

        // FIRST post-ON request = direct authenticated SDK call with a
        // captured cookie. NOT sessions.list, NOT a direct reconcile call.
        // Semantics note (real path): touchLastSeen runs BEFORE the
        // reconcile — for the stale variant that touch re-freshens the
        // AUTHENTICATING row (it becomes legitimately most-recent), while
        // for the recent variant the 60s throttle skips the write and the
        // pre-set ranking decides untouched. Both variants must reconcile.
        const resolvedOldest = await authByCookie(mints[3].token);
        expect(resolvedOldest.user.id).toBe(userId);

        // The returned row IS the post-reconciliation status — the SDK never
        // rides a stale pre-reconcile row.
        const expectedActive =
          variant === "recent"
            ? [mints[0].row.id, mints[1].row.id]
            : [mints[0].row.id, mints[3].row.id];
        const expectedUnslotted =
          variant === "recent"
            ? [mints[2].row.id, mints[3].row.id]
            : [mints[1].row.id, mints[2].row.id];
        expect(resolvedOldest.sessionRow!.status).toBe(
          variant === "recent" ? "unslotted_legacy" : "active"
        );

        const after = await rowsOf(userId);
        expect(after.filter((r) => r.status === "active").map((r) => r.id).sort()).toEqual(
          expectedActive.slice().sort()
        );
        expect(after.filter((r) => r.status === "unslotted_legacy").map((r) => r.id).sort()).toEqual(
          expectedUnslotted.slice().sort()
        );
        expect(after.some((r) => r.status === "revoked")).toBe(false);

        // Direct rights AFTER reconcile, for BOTH post-reconcile statuses
        // (the demoted session keeps its non-reading rights).
        const demotedRowId = variant === "recent" ? mints[3].row.id : mints[2].row.id;
        const demotedAuth =
          variant === "recent" ? resolvedOldest : await authByCookie(mints[2].token);
        expect(demotedAuth.sessionRow!.id).toBe(demotedRowId);
        const demotedCaller = callerFor(userId, openId, demotedAuth.sessionRow);
        await expect(demotedCaller.myNovels.list()).resolves.toEqual(expect.any(Array));

        const activeResolved = await authByCookie(mints[0].token);
        expect(activeResolved.sessionRow!.status).toBe("active");
        const activeCaller = callerFor(userId, openId, activeResolved.sessionRow);
        await expect(activeCaller.myNovels.list()).resolves.toEqual(expect.any(Array));
      } finally {
        setFlag(false);
      }
    });
  }

  // =====================================================================
  // B (PAT-7): app/DB skew ±120s + stale-version matrix
  // =====================================================================

  it("B/ahead+120s: a DB-live lease cannot be stolen — acquire is typed LEASE_HELD (service + tRPC surface) and the row is untouched", async () => {
    const openId = `r4r7-b-${tag}`;
    setFlag(true);
    await db.delete(readingLeases).where(eq(readingLeases.userId, userB));
    const s1 = await mintV2(userB, openId);
    const s2 = await mintV2(userB, openId);
    expect(s1.row.status).toBe("active");
    expect(s2.row.status).toBe("active");

    const acquired = await leaseService.acquireLease({ sessionId: s1.row.id, userId: userB });
    expect(acquired.ok).toBe(true);
    const before = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
    expect(before.holderSessionId).toBe(s1.row.id);

    // App clock runs 120s AHEAD of the DB: pre-DB-time code saw
    // lease.expiresAt as "past" under this skew and stole the lease.
    skewAppClock(120_000);
    try {
      const stolen = await leaseService.acquireLease({ sessionId: s2.row.id, userId: userB });
      expect(stolen).toEqual({ ok: false, code: "LEASE_HELD" });

      // Same refusal through the tRPC surface (typed LEASE_HELD error).
      const caller2 = callerFor(userB, openId, await freshRow(s2.row.id));
      await expect(caller2.reader.lease.acquire({ episodeId: paidEpisode })).rejects.toMatchObject({
        cause: { code: "LEASE_HELD" },
      });

      const untouched = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
      expect(untouched.holderSessionId).toBe(s1.row.id);
      expect(untouched.leaseVersion).toBe(before.leaseVersion);
      expect(untouched.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    } finally {
      resetAppClock();
    }
  });

  it("B/behind-120s: a DB-EXPIRED lease is acquirable (version bumps) even though the app clock lags", async () => {
    const openId = `r4r7-b-${tag}`;
    setFlag(true);
    await db.delete(readingLeases).where(eq(readingLeases.userId, userB));
    const s3 = await mintV2(userB, openId);
    const s4 = await mintV2(userB, openId);
    // Force both active regardless of allocator order for this user.
    if (s3.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s3.row.id));
    }
    if (s4.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s4.row.id));
    }

    const first = await leaseService.acquireLease({ sessionId: s3.row.id, userId: userB });
    expect(first.ok).toBe(true);

    // Expire the lease by DB time.
    await db
      .update(readingLeases)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(readingLeases.userId, userB));

    // App clock runs 120s BEHIND the DB: pre-DB-time code saw the expired
    // lease as still live and wrongly refused.
    skewAppClock(-120_000);
    try {
      const taken = await leaseService.acquireLease({ sessionId: s4.row.id, userId: userB });
      expect(taken).toMatchObject({ ok: true });
      const row = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
      expect(row.holderSessionId).toBe(s4.row.id);
      expect(row.leaseVersion).toBe((first as any).leaseVersion + 1);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      resetAppClock();
    }
  });

  it("B/expired-session: renew and transfer are typed SESSION_NOT_ACTIVE under app-clock lag, with NO row mutation", async () => {
    const openId = `r4r7-b-${tag}`;
    setFlag(true);
    await db.delete(readingLeases).where(eq(readingLeases.userId, userB));
    const s5 = await mintV2(userB, openId);
    if (s5.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s5.row.id));
    }
    const held = await leaseService.acquireLease({ sessionId: s5.row.id, userId: userB });
    expect(held.ok).toBe(true);
    const before = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];

    // The session row's DB deadline passes.
    await db
      .update(authSessions)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(authSessions.id, s5.row.id));

    // App clock BEHIND: a Node-time comparison would still consider the
    // session row live. The locked SELECT decides with DB NOW().
    skewAppClock(-120_000);
    try {
      await expect(
        leaseService.renewLease({ sessionId: s5.row.id, userId: userB, leaseVersion: (held as any).leaseVersion })
      ).resolves.toEqual({ ok: false, code: "SESSION_NOT_ACTIVE" });
      await expect(
        leaseService.transferLease({ sessionId: s5.row.id, userId: userB })
      ).resolves.toEqual({ ok: false, code: "SESSION_NOT_ACTIVE" });

      const untouched = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
      expect(untouched.holderSessionId).toBe(before.holderSessionId);
      expect(untouched.leaseVersion).toBe(before.leaseVersion);
      expect(untouched.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    } finally {
      resetAppClock();
    }
  });

  it("B/stale-version: renew with a superseded or wrong version is typed LEASE_HELD and never mutates the lease row", async () => {
    const openId = `r4r7-b-${tag}`;
    setFlag(true);
    await db.delete(readingLeases).where(eq(readingLeases.userId, userB));
    const s6 = await mintV2(userB, openId);
    const s7 = await mintV2(userB, openId);
    if (s6.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s6.row.id));
    }
    if (s7.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s7.row.id));
    }

    const v1 = await leaseService.acquireLease({ sessionId: s6.row.id, userId: userB });
    expect(v1.ok).toBe(true);
    const v2 = await leaseService.transferLease({ sessionId: s7.row.id, userId: userB });
    expect(v2.ok).toBe(true);
    const current = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
    expect(current.leaseVersion).toBe((v2 as any).leaseVersion);
    expect(current.holderSessionId).toBe(s7.row.id);

    // Superseded holder presenting its OLD version → typed refusal.
    await expect(
      leaseService.renewLease({ sessionId: s6.row.id, userId: userB, leaseVersion: (v1 as any).leaseVersion })
    ).resolves.toEqual({ ok: false, code: "LEASE_HELD" });
    // Current holder presenting a WRONG version → typed refusal.
    await expect(
      leaseService.renewLease({ sessionId: s7.row.id, userId: userB, leaseVersion: 999999 })
    ).resolves.toEqual({ ok: false, code: "LEASE_HELD" });

    const unchanged = (await db.select().from(readingLeases).where(eq(readingLeases.userId, userB)))[0];
    expect(unchanged.leaseVersion).toBe(current.leaseVersion);
    expect(unchanged.holderSessionId).toBe(current.holderSessionId);
    expect(unchanged.expiresAt.getTime()).toBe(current.expiresAt.getTime());
  });

  // =====================================================================
  // C (PAT-8): chooser deadline vs verified JWT expiry
  // =====================================================================

  it("C/past-deadline: a pending row past its chooser deadline cannot resolve (typed CONFLICT) and flips superseded", async () => {
    const openId = `r4r7-c1-${tag}`;
    setFlag(true);
    await mintV2(userC, openId);
    await mintV2(userC, openId); // slots now full
    const pending = await mintV2(userC, openId);
    expect(pending.row.status).toBe("pending_choice");

    // The 30-minute chooser window elapses (DB time).
    await db
      .update(authSessions)
      .set({ expiresAt: sql`NOW() - INTERVAL 1 SECOND` })
      .where(eq(authSessions.id, pending.row.id));

    const pendingCaller = callerFor(userC, openId, await freshRow(pending.row.id), {
      jwtExp: new Date(Date.now() + SESSION_30D_MS),
    });
    await expect(
      pendingCaller.auth.sessions.resolveThirdLogin({ displaceSessionId: pending.row.id })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await freshRow(pending.row.id))!.status).toBe("superseded");
  });

  /**
   * The review-required invariant oldPendingDeadline < DB_NOW < verifiedJwtExp,
   * evaluated ENTIRELY in DB time (the DB's own NOW() against its own stored
   * rows via UNIX_TIMESTAMP). Deliberately never compared against the Node
   * clock: mysql2 DATETIME→Date timezone conversion is not reliable across
   * writer/reader paths, and the ONLY clock expiry decisions use is DB time.
   * pendingRowId carries the RESOLVER-set expiry (already asserted equal to
   * the SDK-verified JWT exp in Node terms); deadlineRowId carries the
   * captured (shortened) chooser deadline.
   */
  async function dbBoundaryCrossed(deadlineRowId: number, pendingResolvedRowId: number) {
    const res: any = await db.execute(sql`
      SELECT
        (UNIX_TIMESTAMP(NOW()) * 1000) AS dbNowMs,
        (UNIX_TIMESTAMP((SELECT expiresAt FROM authSessions WHERE id = ${deadlineRowId})) * 1000) AS deadlineMs,
        (UNIX_TIMESTAMP((SELECT expiresAt FROM authSessions WHERE id = ${pendingResolvedRowId})) * 1000) AS resolvedExpiryMs,
        (UNIX_TIMESTAMP(NOW()) > UNIX_TIMESTAMP((SELECT expiresAt FROM authSessions WHERE id = ${deadlineRowId}))) AS pastPendingDeadline,
        (UNIX_TIMESTAMP(NOW()) < UNIX_TIMESTAMP((SELECT expiresAt FROM authSessions WHERE id = ${pendingResolvedRowId}))) AS beforeVerifiedJwtExp
    `);
    const rows = Array.isArray(res)
      ? Array.isArray(res[0])
        ? res[0]
        : res
      : (res.rows ?? [res]);
    return {
      dbNowMs: Number(rows[0].dbNowMs),
      deadlineMs: Number(rows[0].deadlineMs),
      resolvedExpiryMs: Number(rows[0].resolvedExpiryMs),
      pastPendingDeadline: Number(rows[0].pastPendingDeadline),
      beforeVerifiedJwtExp: Number(rows[0].beforeVerifiedJwtExp),
    };
  }

  it("C/chooser-deadline-elapsed: resolve stamps the SDK-VERIFIED JWT exp; real DB time then crosses the CAPTURED chooser deadline and the resolved row still authenticates — while an unresolved sibling with the same deadline dies (C-QUAL-01)", async () => {
    const openId = `r4r7-c2-${tag}`;
    setFlag(true);
    const JWT_TTL_MS = 40 * MINUTE_MS;
    await mintV2(userC2, openId);
    await mintV2(userC2, openId); // slots full → third mint is pending
    const mintTime = Date.now();
    const pending = await mintV2(userC2, openId, { expiresInMs: JWT_TTL_MS });
    expect(pending.row.status).toBe("pending_choice");

    // REAL wiring (C-QUAL-01): the chooser caller's ctx expiry must be the
    // SDK-VERIFIED expSeconds (createContext.authSessionExpiresAt), so it is
    // read from an actual authenticateRequestWithSession of the pending
    // cookie — never reconstructed from mintTime+TTL inside the test.
    const pendingAuth = await authByCookie(pending.token);
    expect(pendingAuth.user.id).toBe(userC2);
    const verifiedJwtExp = pendingAuth.sessionExpiresAt!;

    // The allocator cut the pending deadline to the chooser window
    // (SQL LEAST(verifiedExp, NOW+30m) = the 30-minute cut), NOT the JWT term.
    const capturedPendingDeadline = (await freshRow(pending.row.id))!.expiresAt.getTime();
    const pendingDeadlineMinutes = (capturedPendingDeadline - mintTime) / MINUTE_MS;
    expect(pendingDeadlineMinutes).toBeGreaterThanOrEqual(28);
    expect(pendingDeadlineMinutes).toBeLessThanOrEqual(31);

    // Negative control twin: same deadline shape, NEVER resolved.
    const sibling = await mintV2(userC2, openId, { expiresInMs: JWT_TTL_MS, forceStatus: "pending_choice" });
    expect(sibling.row.status).toBe("pending_choice");

    // Fixture-only equivalence for the 30-minute path (per review C-QUAL-01
    // work order): shorten BOTH pending windows to +3s BEFORE resolving. The
    // auth path's DB-time predicate (`expiresAt > NOW()`) and the resolver's
    // deadline inheritance are deadline-VALUE-independent — production mints
    // the same boundary at +30m via LEAST(jwtExp, NOW+30m); shortening only
    // moves the absolute point of the boundary, so real elapsed time can
    // cross it without a 30-minute wait and without touching production TTL.
    await db
      .update(authSessions)
      .set({ expiresAt: sql`NOW() + INTERVAL 3 SECOND` })
      .where(inArray(authSessions.id, [pending.row.id, sibling.row.id]));

    // Resolve WHILE the chooser window is still open — through the real
    // allowlisted caller carrying the SDK-VERIFIED exp. From here on the
    // test NEVER writes expiresAt (forbidden: a post-resolve expiry write
    // was the R4R7 C-QUAL-01 defect).
    const actives = (await rowsOf(userC2))
      .filter((r) => r.status === "active")
      .sort((a, b) => a.id - b.id);
    const chooserCaller = callerFor(userC2, openId, await freshRow(pending.row.id), {
      jwtExp: verifiedJwtExp,
    });
    await chooserCaller.auth.sessions.resolveThirdLogin({ displaceSessionId: actives[0].id });

    const afterResolve = (await freshRow(pending.row.id))!;
    expect(afterResolve.status).toBe("active");
    // The resolver stamped the VERIFIED JWT exp (≈ mint+40m), NOT the
    // 30-minute chooser cut and NOT a test-written value.
    const resolvedMinutes = (afterResolve.expiresAt.getTime() - mintTime) / MINUTE_MS;
    expect(resolvedMinutes).toBeGreaterThan(35);
    expect(resolvedMinutes).toBeLessThanOrEqual(40.5);
    expect(Math.abs(afterResolve.expiresAt.getTime() - verifiedJwtExp.getTime())).toBeLessThan(1500);

    // REAL elapsed boundary: DB time crosses the captured chooser deadline.
    // Window=3s, sleep=6s — 3s of margin so the crossing never depends on
    // scheduling jitter.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    // The review-required invariant, proven in DB time:
    //   oldPendingDeadline < observedDBNow < verifiedJwtExp
    // (pending.row.expiresAt = the resolver-set verified JWT exp — equality
    // with the SDK value is asserted above; sibling.row.expiresAt = the
    // captured shortened chooser deadline).
    const boundary = await dbBoundaryCrossed(sibling.row.id, pending.row.id);
    if (boundary.pastPendingDeadline !== 1 || boundary.beforeVerifiedJwtExp !== 1) {
      throw new Error(
        `C-QUAL-01 boundary not crossed (raw numbers): ${JSON.stringify(boundary)}; ` +
          `sleep=${3600}ms; shortenedWindowMs=3000`
      );
    }
    expect(boundary.pastPendingDeadline).toBe(1);
    expect(boundary.beforeVerifiedJwtExp).toBe(1);

    // Positive: the resolved row authenticates with the resolver-set expiry
    // untouched — exactly where a row still carrying the chooser cut would
    // already be superseded.
    const stillAuthed = await authByCookie(pending.token);
    expect(stillAuthed.user.id).toBe(userC2);
    expect(stillAuthed.sessionRow!.id).toBe(pending.row.id);
    expect(stillAuthed.sessionRow!.status).toBe("active");
    expect(Math.abs(stillAuthed.sessionRow!.expiresAt.getTime() - verifiedJwtExp.getTime())).toBeLessThan(1500);

    // Negative control: the unresolved sibling with the SAME shortened
    // deadline did NOT survive the same elapsed time — proving DB NOW truly
    // crossed the deadline (DB-time flip fires; not a fixture artifact).
    await expect(authByCookie(sibling.token)).rejects.toMatchObject({
      reason: "invalid_session_token",
    });
    expect((await freshRow(sibling.row.id))!.status).toBe("superseded");

    // Nondefault-TTL legacy adoption inherits the VERIFIED exp too (matrix).
    // (Fresh user so quota state cannot interfere.)
    const legacyOpenId = `r4r7-c4-${tag}`;
    await mintV2(userC4, legacyOpenId);
    await mintV2(userC4, legacyOpenId);
    const legacyToken = await mintLegacyV1(legacyOpenId, 45 * MINUTE_MS);
    const adopted = await authByCookie(legacyToken);
    expect(adopted.sessionRow!.status).toBe("unslotted_legacy");
    const adoptedMinutes = (adopted.sessionRow!.expiresAt.getTime() - Date.now()) / MINUTE_MS;
    expect(adoptedMinutes).toBeGreaterThan(40);
    expect(adoptedMinutes).toBeLessThanOrEqual(45.5);
  });

  it("C/final-jwt-expiry: a session whose JWT has expired (app-clock term, by design) is rejected on replay", async () => {
    const openId = `r4r7-c3-${tag}`;
    setFlag(true);
    const short = await mintV2(userC3, openId, { expiresInMs: 1500 });
    const liveAuth = await authByCookie(short.token);
    expect(liveAuth.user.id).toBe(userC3);

    await new Promise((resolve) => setTimeout(resolve, 1700));
    await expect(authByCookie(short.token)).rejects.toMatchObject({
      reason: "invalid_session_token",
    });
  });

  // =====================================================================
  // E (PAT-10): exact pending allowlist + denied business chains
  // =====================================================================

  it("E/allowlist: a pending session can me/list/resolveThirdLogin/logout — and NOTHING else: User/Author/Admin business chains + sessions.revoke are denied with SESSION_SLOT_PENDING", async () => {
    const openId = `r4r7-e-${tag}`;
    setFlag(true);
    const a1 = await mintV2(userE, openId);
    const a2 = await mintV2(userE, openId);
    const pending = await mintV2(userE, openId);
    expect(pending.row.status).toBe("pending_choice");
    void a2;

    const pendingCaller = callerFor(userE, openId, await freshRow(pending.row.id), {
      jwtExp: new Date(Date.now() + SESSION_30D_MS),
    });

    // ALLOWED — the exact allowlist, exercised for real:
    await expect(pendingCaller.auth.me()).resolves.toMatchObject({ id: userE });
    const list = await pendingCaller.auth.sessions.list();
    expect(list.sessions.map((s: any) => s.id)).toContain(pending.row.id);
    const resolveOutcome = await pendingCaller.auth.sessions.resolveThirdLogin({
      displaceSessionId: a1.row.id,
    });
    expect(resolveOutcome).toBeDefined();
    expect((await freshRow(pending.row.id))!.status).toBe("active");

    // A second pending row proves logout stays reachable pre-resolution.
    const pending2 = await mintV2(userE, openId);
    if (pending2.row.status !== "pending_choice") {
      await db.update(authSessions).set({ status: "pending_choice" }).where(eq(authSessions.id, pending2.row.id));
    }
    const logoutOutcome = await callerFor(userE, openId, await freshRow(pending2.row.id), {
      cookie: pending2.token,
    }).auth.logout();
    expect(logoutOutcome).toEqual({ success: true, durableRevocation: "revoked" });

    // DENIED — pending user on the User chain (protected + lease surface).
    const freshPending = await mintV2(userE, openId, { forceStatus: "pending_choice" });
    const deniedCaller = callerFor(userE, openId, await freshRow(freshPending.row.id));
    await expect(deniedCaller.myNovels.list()).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });
    await expect(deniedCaller.reader.lease.acquire({ episodeId: paidEpisode })).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });
    await expect(deniedCaller.auth.sessions.revoke({ sessionId: freshPending.row.id })).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });

    // DENIED — pending ADMIN on the admin chain.
    const adminPending = await mintV2(userEAdmin, `r4r7-e-admin-${tag}`, { forceStatus: "pending_choice" });
    const adminCaller = callerFor(userEAdmin, `r4r7-e-admin-${tag}`, await freshRow(adminPending.row.id), {
      role: "admin",
    });
    await expect(adminCaller.admin.dashboard.summary({ period: "all" })).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });

    // DENIED — pending AUTHOR on the authorContent chain.
    const authorPending = await mintV2(userEAuthor, `r4r7-e-author-${tag}`, { forceStatus: "pending_choice" });
    const authorCaller = callerFor(userEAuthor, `r4r7-e-author-${tag}`, await freshRow(authorPending.row.id), {
      role: "author",
    });
    await expect(authorCaller.admin.novels.create({ title: "t", author: "a" } as any)).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });

    // Active and unslotted keep NON-reading rights (matrix regression).
    const activeCaller = callerFor(userE, openId, await freshRow(pending.row.id));
    await expect(activeCaller.myNovels.list()).resolves.toEqual(expect.any(Array));

    const legacyOpenId = `r4r7-e-unslotted-${tag}`;
    await mintV2(userEUnslotted, legacyOpenId);
    await mintV2(userEUnslotted, legacyOpenId);
    const legacyToken = await mintLegacyV1(legacyOpenId);
    const unslotted = await authByCookie(legacyToken);
    expect(unslotted.sessionRow!.status).toBe("unslotted_legacy");
    const unslottedCaller = callerFor(userEUnslotted, legacyOpenId, unslotted.sessionRow);
    await expect(unslottedCaller.myNovels.list()).resolves.toEqual(expect.any(Array));
    await expect(unslottedCaller.reader.lease.acquire({ episodeId: paidEpisode })).rejects.toMatchObject({
      cause: { code: "SESSION_LEGACY_UNSLOTTED" },
    });
  });

  // =====================================================================
  // F (PAT-11): flag-OFF captured-token replay is durably dead
  // =====================================================================

  it("F/off-floor: with the flag OFF, a captured cookie dies at logout — replay through the SDK path, the full request path and a lease mutation all fail, and the row stays terminal", async () => {
    const openId = `r4r7-f-${tag}`;
    setFlag(false);
    try {
      const minted = await mintV2(userF, openId);
      expect(minted.row.status).toBe("active"); // off-path floor mint

      // The cookie works before logout (both SDK and full request path).
      const pre = await authByCookie(minted.token);
      expect(pre.user.id).toBe(userF);
      const preFull = await sdk.authenticateRequest({
        headers: { cookie: `app_session_id=${minted.token}` },
      } as any);
      expect(preFull.id).toBe(userF);

      // Logout through the real mutation (cookie → revokeByToken).
      const logoutCaller = callerFor(userF, openId, null, { cookie: minted.token });
      const outcome = await logoutCaller.auth.logout();
      expect(outcome).toEqual({ success: true, durableRevocation: "revoked" });
      expect((await freshRow(minted.row.id))!.status).toBe("revoked");

      // REPLAY the captured cookie while the flag is STILL OFF:
      await expect(authByCookie(minted.token)).rejects.toMatchObject({ reason: "session_revoked" });
      await expect(
        sdk.authenticateRequest({ headers: { cookie: `app_session_id=${minted.token}` } } as any)
      ).rejects.toMatchObject({ reason: "session_revoked" });
      // Replay is idempotent — the row is terminal and never re-adopted.
      const replayRow = await registry.findSessionByCookie({ token: minted.token, sid: minted.sid });
      expect(replayRow!.status).toBe("revoked");

      // A lease operation bound to the dead session is typed, not raw.
      await expect(
        leaseService.acquireLease({ sessionId: minted.row.id, userId: userF })
      ).resolves.toEqual({ ok: false, code: "SESSION_NOT_ACTIVE" });
      await expect(
        leaseService.transferLease({ sessionId: minted.row.id, userId: userF })
      ).resolves.toEqual({ ok: false, code: "SESSION_NOT_ACTIVE" });
    } finally {
      setFlag(true);
    }
  });
});
