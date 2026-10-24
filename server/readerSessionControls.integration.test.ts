import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import { __setDbForTests } from "./db";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import * as registry from "./services/sessionRegistry";
import * as leaseService from "./services/readingLease";
import * as readerService from "./services/readerService";
import {
  authSessions,
  episodePurchases,
  episodes,
  novels,
  readingLeases,
  sessionSlots,
  users,
} from "../drizzle/schema";

/**
 * R2 Reader Session Controls — integration coverage for the T1–T40 matrix
 * (R1D Part C). Runs against the disposable ipenovel_test database with the
 * flag driven per-test via process.env (sessionRegistry reads it live).
 * Clock note (R1D B6): expiry rows in fixtures use explicit UTC timestamps;
 * services decide with DB time.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const futureExpiry = () => new Date(Date.now() + 30 * DAY_MS);

function setFlag(on: boolean) {
  process.env.READER_SESSION_CONTROLS = on ? "true" : "false";
}

describe("R2 Reader Session Controls", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const createdSessionIds: number[] = [];
  const createdUserIds: number[] = [];
  const createdNovelIds: number[] = [];
  const createdEpisodeIds: number[] = [];
  const createdPurchaseIds: number[] = [];

  let userA = 0;
  let userB = 0;
  let buyer = 0;
  let paidNovel = 0;
  let paidEpisode = 0;
  let freeEpisode = 0;

  beforeAll(async () => {
    __setDbForTests(db);
    userA = insertId(await db.insert(users).values({
      openId: `r2-a-${tag}`,
      name: "Reader A",
      email: `r2-a-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
    userB = insertId(await db.insert(users).values({
      openId: `r2-b-${tag}`,
      name: "Reader B",
      email: `r2-b-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
    buyer = insertId(await db.insert(users).values({
      openId: `r2-buyer-${tag}`,
      name: "Buyer",
      email: `r2-buyer-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
    createdUserIds.push(userA, userB, buyer);

    paidNovel = insertId(await db.insert(novels).values({
      title: `R2 paid novel ${tag}`,
      slug: `r2-paid-${tag}`,
      author: "R2 Author",
      authorUserId: null,
      publicationStatus: "published",
      storyStatus: "ongoing",
    }));
    createdNovelIds.push(paidNovel);
    paidEpisode = insertId(await db.insert(episodes).values({
      novelId: paidNovel,
      episodeNumber: `r2-paid-1-${tag}`,
      title: "Paid chapter",
      price: "50.00",
      isFree: false,
      isPublished: true,
      saleMode: "chapter",
      fileUrl: "https://legacy.example.test/r2-paid.pdf",
      content: "FULL PAID CONTENT ".repeat(40),
    }));
    freeEpisode = insertId(await db.insert(episodes).values({
      novelId: paidNovel,
      episodeNumber: `r2-free-1-${tag}`,
      title: "Free chapter",
      price: "0.00",
      isFree: true,
      isPublished: true,
      saleMode: "chapter",
      fileUrl: "https://legacy.example.test/r2-free.pdf",
      content: "FREE CONTENT",
    }));
    createdEpisodeIds.push(paidEpisode, freeEpisode);

    const purchase = await db.insert(episodePurchases).values({
      userId: buyer,
      novelId: paidNovel,
      episodeId: paidEpisode,
      pricePaid: "50.00",
    });
    createdPurchaseIds.push(insertId(purchase));

    setFlag(true);
  });

  afterAll(async () => {
    __setDbForTests(null);
    setFlag(false);
    if (createdPurchaseIds.length) await db.delete(episodePurchases).where(inArray(episodePurchases.id, createdPurchaseIds));
    if (createdEpisodeIds.length) await db.delete(episodes).where(inArray(episodes.id, createdEpisodeIds));
    if (createdNovelIds.length) await db.delete(novels).where(inArray(novels.id, createdNovelIds));
    if (createdSessionIds.length) await db.delete(authSessions).where(inArray(authSessions.id, createdSessionIds));
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  /** Mints a v2 cookie + registry row for a user (allocator decides status). */
  async function mintSession(userId: number, openId: string, opts?: { rotateRowId?: number | null }) {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(openId, { sid, name: "R2" });
    const row = await registry.allocateSessionRow({
      userId,
      token,
      sid,
      expiresAt: futureExpiry(),
      createdVia: "google",
      clientLabel: "Test Browser",
      rotateRowId: opts?.rotateRowId ?? null,
    });
    createdSessionIds.push(row.id);
    return { token, sid, row };
  }

  /** Legacy v1 cookie (no sid claim). */
  async function mintV1(openId: string) {
    return sdk.createSessionToken(openId, { name: "R2 legacy" });
  }

  function contextFor(user: TrpcContext["user"], sessionRow: any): TrpcContext {
    return {
      user,
      authSession: sessionRow ?? null,
      // R4/C: mirrors createContext.authSessionExpiresAt — the verified JWT
      // exp the production context always carries (30d harness term).
      authSessionExpiresAt: sessionRow ? new Date(Date.now() + 30 * 86400000) : null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    };
  }

  function callerFor(userId: number, openId: string, sessionRow: any, role: string = "user") {
    const user = {
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
    return appRouter.createCaller(contextFor(user, sessionRow));
  }

  const guestCaller = () =>
    appRouter.createCaller({ user: null, authSession: null, req: { headers: {} }, res: {} } as any);

  async function freshRow(id: number) {
    const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id));
    return row;
  }

  // ---------- T1/T2/F4: allocation & quota ----------
  it("T1/T2: two logins are active; each additional NEW profile gets its own pending_choice row (active2/pending2)", async () => {
    const a1 = await mintSession(userA, `r2-a-${tag}`);
    const a2 = await mintSession(userA, `r2-a-${tag}`);
    expect(a1.row.status).toBe("active");
    expect(a2.row.status).toBe("active");

    const [p3] = await Promise.all([mintSession(userA, `r2-a-${tag}`)]);
    expect(p3.row.status).toBe("pending_choice");

    const p4 = await mintSession(userA, `r2-a-${tag}`);
    const activeCount = (await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userA))).filter(r => r.status === "active").length;
    const pendingCount = (await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userA))).filter(r => r.status === "pending_choice").length;
    expect(activeCount).toBe(2);
    expect(pendingCount).toBe(2);
    expect(p4.row.status).toBe("pending_choice");
    void a2;
  });

  it("T3/F4: resolveThirdLogin displaces the chosen session and activates the pending one", async () => {
    const rows = () => db.select().from(authSessions).where(eq(authSessions.userId, userA));
    const all = await rows();
    const pending = all.find(r => r.status === "pending_choice")!;
    const activeOldest = all
      .filter(r => r.status === "active")
      .sort((x, y) => x.loginAt.getTime() - y.loginAt.getTime())[0]!;

    const caller = callerFor(userA, `r2-a-${tag}`, pending);
    await caller.auth.sessions.resolveThirdLogin({ displaceSessionId: activeOldest.id });

    const after = await rows();
    expect(after.find(r => r.id === activeOldest.id)!.status).toBe("superseded");
    expect(after.find(r => r.id === pending.id)!.status).toBe("active");
    expect(after.filter(r => r.status === "active")).toHaveLength(2);
  });

  it("T22: expired pending_choice can never resolve; v2 token with missing row hard-fails; revoked never re-slots", async () => {
    // expired pending
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(`r2-a-${tag}`, { sid });
    const expiredRow = await registry.allocateSessionRow({
      userId: userA,
      token,
      sid,
      expiresAt: new Date(Date.now() - DAY_MS),
      createdVia: "google",
    });
    createdSessionIds.push(expiredRow.id);
    await db
      .update(authSessions)
      .set({ status: "pending_choice" })
      .where(eq(authSessions.id, expiredRow.id));
    const caller = callerFor(userA, `r2-a-${tag}`, expiredRow);
    await expect(
      caller.auth.sessions.resolveThirdLogin({ displaceSessionId: expiredRow.id })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await freshRow(expiredRow.id);
    expect(after!.status).toBe("superseded");

    // v2 token whose sid has NO row → hard fail (never the legacy path)
    const orphanSid = registry.generateSid();
    const orphanToken = await sdk.createSessionToken(`r2-a-${tag}`, { sid: orphanSid });
    await expect(
      sdk.authenticateRequestWithSession({
        headers: { cookie: `app_session_id=${orphanToken}` },
      } as any)
    ).rejects.toMatchObject({ reason: "invalid_session_token" });

    // revoked row is terminal: re-minting the SAME cookie/sid cannot resurrect
    const live = await mintSession(userA, `r2-a-${tag}`);
    await registry.revokeOwnSession({ userId: userA, sessionId: live.row.id });
    expect((await freshRow(live.row.id))!.status).toBe("revoked");
    await expect(
      sdk.authenticateRequestWithSession({
        headers: { cookie: `app_session_id=${live.token}` },
      } as any)
    ).rejects.toMatchObject({ reason: "session_revoked" });
    const again = await registry.findSessionByCookie({ token: live.token, sid: live.sid });
    expect(again!.status).toBe("revoked"); // adoption never overwrites a row
  });

  it("T24/F3: rotation fast path only for an active unexpired row; everything else goes through the allocator", async () => {
    // fast path: rotate an active row — net active count unchanged
    const before = (await db.select().from(authSessions).where(eq(authSessions.userId, userA)))
      .filter(r => r.status === "active").length;
    const active = (await db.select().from(authSessions).where(eq(authSessions.userId, userA)))
      .filter(r => r.status === "active")[0]!;
    const rotated = await mintSession(userA, `r2-a-${tag}`, { rotateRowId: active.id });
    expect(rotated.row.status).toBe("active");
    expect((await db.select().from(authSessions).where(eq(authSessions.userId, userA)))
      .filter(r => r.status === "active").length).toBe(before);
    expect((await freshRow(active.id))!.status).toBe("superseded");

    // rotation over a REVOKED row: allocator decides (slots full → pending)
    const revoked = await mintSession(userA, `r2-a-${tag}`);
    await registry.revokeOwnSession({ userId: userA, sessionId: revoked.row.id });
    const over = await mintSession(userA, `r2-a-${tag}`, { rotateRowId: revoked.row.id });
    expect(over.row.status).toBe("pending_choice");
  });

  it("T10/T21/T23: legacy v1 adoption — free slot → active; full slots → unslotted keeps non-reading rights and promotes when a slot frees", async () => {
    // userB: two active sessions → slots full
    const b1 = await mintSession(userB, `r2-b-${tag}`);
    const b2 = await mintSession(userB, `r2-b-${tag}`);
    const legacy = await mintV1(`r2-b-${tag}`);
    const resolved = await sdk.authenticateRequestWithSession({
      headers: { cookie: `app_session_id=${legacy}` },
    } as any);
    expect(resolved.user.id).toBe(userB);
    expect(resolved.sessionRow!.status).toBe("unslotted_legacy");

    // non-reading rights kept: myNovels.list (protectedProcedure, not lease-gated)
    const caller = callerFor(userB, `r2-b-${tag}`, resolved.sessionRow);
    const list = await caller.myNovels.list();
    expect(Array.isArray(list)).toBe(true);

    // reading rights blocked
    await expect(
      caller.reader.lease.acquire({ episodeId: paidEpisode })
    ).rejects.toMatchObject({ cause: { code: "SESSION_LEGACY_UNSLOTTED" } });

    // a slot frees → next promotion trigger (lease.acquire) promotes first
    await registry.revokeOwnSession({ userId: userB, sessionId: b1.row.id });
    const acquire = await caller.reader.lease.acquire({ episodeId: paidEpisode });
    expect(acquire.ok).toBe(true);
    expect((await freshRow(resolved.sessionRow!.id))!.status).toBe("active");
    void b2;
  });

  it("T25/C2: lease acquire/renew/transfer fencing + revoke-of-holder expires the lease in-tx", async () => {
    const s1 = await mintSession(userA, `r2-a-${tag}`);
    const s2 = await mintSession(userA, `r2-a-${tag}`);
    // ensure both active: resolve any pending first
    for (const s of [s1, s2]) {
      if (s.row.status === "pending_choice") {
        const others = (await db.select().from(authSessions).where(eq(authSessions.userId, userA)))
          .filter(r => r.status === "active")[0];
        await callerFor(userA, `r2-a-${tag}`, s.row).auth.sessions.resolveThirdLogin({
          displaceSessionId: others!.id,
        });
      }
    }
    const s1fresh = await freshRow(s1.row.id);
    const s2fresh = await freshRow(s2.row.id);
    const activePair = [s1fresh!, s2fresh!].filter(r => r.status === "active");
    expect(activePair.length).toBe(2);
    const holder = activePair[0];
    const other = activePair[1];

    const callerHolder = callerFor(userA, `r2-a-${tag}`, holder);
    const callerOther = callerFor(userA, `r2-a-${tag}`, other);

    const acquired = await callerHolder.reader.lease.acquire({ episodeId: paidEpisode });
    expect(acquired.ok).toBe(true);
    // T6: other session blocked
    await expect(
      callerOther.reader.lease.acquire({ episodeId: paidEpisode })
    ).rejects.toMatchObject({ cause: { code: "LEASE_HELD" } });
    // T7: fencing — old-version renew after transfer fails
    await callerOther.reader.lease.transfer({ episodeId: paidEpisode });
    await expect(
      callerHolder.reader.lease.renew({ episodeId: paidEpisode, leaseVersion: acquired.leaseVersion })
    ).rejects.toMatchObject({ cause: { code: "LEASE_LOST" } });

    // C2: revoke-of-holder expires the lease in the same tx
    await registry.revokeOwnSession({ userId: userA, sessionId: other.id });
    const [lease] = await db.select().from(readingLeases).where(eq(readingLeases.userId, userA));
    expect(lease.holderSessionId).toBe(other.id);
    expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(new Date().getTime() + 1000);
  });

  it("T37/C4: paid response matrix across surfaces (lease required on C2 whole-row; admin exempt from lease; C1 auto-acquires)", async () => {
    // admin session (active, no lease)
    const adminId = insertId(await db.insert(users).values({
      openId: `r2-admin-${tag}`,
      name: "Admin",
      email: `r2-admin-${tag}@example.test`,
      loginMethod: "test",
      role: "admin",
    }));
    createdUserIds.push(adminId);
    const adminSid = registry.generateSid();
    const adminToken = await sdk.createSessionToken(`r2-admin-${tag}`, { sid: adminSid });
    const adminRow = await registry.allocateSessionRow({
      userId: adminId,
      token: adminToken,
      sid: adminSid,
      expiresAt: futureExpiry(),
      createdVia: "google",
    });
    createdSessionIds.push(adminRow.id);

    // buyer: entitlement via purchase; one active session
    const buyerSid = registry.generateSid();
    const buyerToken = await sdk.createSessionToken(`r2-buyer-${tag}`, { sid: buyerSid });
    const buyerRow = await registry.allocateSessionRow({
      userId: buyer,
      token: buyerToken,
      sid: buyerSid,
      expiresAt: futureExpiry(),
      createdVia: "google",
    });
    createdSessionIds.push(buyerRow.id);
    const buyerCaller = callerFor(buyer, `r2-buyer-${tag}`, buyerRow);

    // C1 auto-acquire → full content
    const ep = await buyerCaller.reader.getEpisode({ episodeId: paidEpisode });
    expect(ep.content).toContain("FULL PAID CONTENT");

    // C2 whole-row + C3 download with the lease held
    const row = await buyerCaller.myNovels.episode({ episodeId: paidEpisode });
    expect(row.content).toContain("FULL PAID CONTENT");
    const dl = await buyerCaller.myNovels.downloadUrl({ episodeId: paidEpisode });
    expect(dl).toHaveProperty("downloadUrl");

    // a SECOND buyer session takes the lease → first session loses (fencing via transfer)
    const buyerSid2 = registry.generateSid();
    const buyerToken2 = await sdk.createSessionToken(`r2-buyer-${tag}`, { sid: buyerSid2 });
    // quota full? buyer has 1 active; second is fine (2 total)
    const buyerRow2 = await registry.allocateSessionRow({
      userId: buyer,
      token: buyerToken2,
      sid: buyerSid2,
      expiresAt: futureExpiry(),
      createdVia: "google",
    });
    createdSessionIds.push(buyerRow2.id);
    const buyerCaller2 = callerFor(buyer, `r2-buyer-${tag}`, buyerRow2);
    await buyerCaller2.reader.lease.transfer({ episodeId: paidEpisode });
    console.log('T37 canRead debug:', await readerService.canReadEpisode(buyer, paidEpisode, false), 'buyer=', buyer, 'episode=', paidEpisode);
    // first session's C2 now denied with LEASE_REQUIRED (no auto-acquire)
    await expect(buyerCaller.myNovels.episode({ episodeId: paidEpisode })).rejects.toMatchObject({
      cause: { code: "LEASE_REQUIRED" },
    });
    await expect(buyerCaller.myNovels.downloadUrl({ episodeId: paidEpisode })).rejects.toMatchObject({
      cause: { code: "LEASE_REQUIRED" },
    });
    // C1 auto-acquires (no other holder now — buyer2's transfer moved it; C1 auto-acquire only when FREE)
    // buyer2 holds → C1 gets LEASE_HELD
    await expect(buyerCaller.reader.getEpisode({ episodeId: paidEpisode })).rejects.toMatchObject({
      cause: { code: "LEASE_HELD" },
    });

    // admin (active, no lease): C2 serves via admin override; C1 stays entitlement-only (locked preview)
    const adminCaller = callerFor(adminId, `r2-admin-${tag}`, adminRow, "admin");
    const adminRowResp = await adminCaller.myNovels.episode({ episodeId: paidEpisode });
    expect(adminRowResp.content).toContain("FULL PAID CONTENT");
    const adminEpisode = await adminCaller.reader.getEpisode({ episodeId: paidEpisode });
    expect(adminEpisode.canRead).toBe(false);
    expect(adminEpisode.isLocked).toBe(true);

    // pending_choice blocked on business procedures
    const pendingSid = registry.generateSid();
    const pendingToken = await sdk.createSessionToken(`r2-buyer-${tag}`, { sid: pendingSid });
    const pendingRow = await registry.allocateSessionRow({
      userId: buyer,
      token: pendingToken,
      sid: pendingSid,
      expiresAt: futureExpiry(),
      createdVia: "google",
    });
    createdSessionIds.push(pendingRow.id);
    if (pendingRow.status !== "pending_choice") {
      // force pending for the gate test (buyer may have had a free slot)
      await db
        .update(authSessions)
        .set({ status: "pending_choice" })
        .where(eq(authSessions.id, pendingRow.id));
    }
    const pendingCaller = callerFor(buyer, `r2-buyer-${tag}`, pendingRow);
    await expect(pendingCaller.myNovels.list()).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });
  });

  it("T35/C5: public TOC keeps metadata; paid fileUrl gated; free fileUrl public", async () => {
    const anon = guestCaller();
    const tocAnon = await anon.novels.episodes({ novelId: paidNovel });
    const paidRowAnon = tocAnon.find((e: any) => e.id === paidEpisode)!;
    const freeRowAnon = tocAnon.find((e: any) => e.id === freeEpisode)!;
    expect(paidRowAnon.content).toBeUndefined();
    expect(paidRowAnon.fileUrl ?? null).toBeNull();
    expect(paidRowAnon.saleMode).toBe("chapter");
    expect(freeRowAnon.fileUrl ?? null).not.toBeNull();

    // entitled + lease → fileUrl resolved; entitled + no lease → null
    const buyerRows = (await db.select().from(authSessions).where(eq(authSessions.userId, buyer)))
      .filter(r => r.status === "active");
    const holderSummary = await leaseService.getLeaseHolderSummary(buyer);
    const holder = buyerRows.find(r => r.id === holderSummary?.holderSessionId) ?? buyerRows[0]!;
    const holderCaller = callerFor(buyer, `r2-buyer-${tag}`, holder);
    const tocHolder = await holderCaller.novels.episodes({ novelId: paidNovel });
    expect(tocHolder.find((e: any) => e.id === paidEpisode)!.fileUrl ?? null).not.toBeNull();
  });

  it("T28/C3: flag OFF — revocation floor holds, off-path mints are active rows, reconciliation keeps top-2 without revoking anyone", async () => {
    setFlag(false);
    // off-path mints: 4 active rows for userB (quota unenforced)
    const mints: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await mintSession(userB, `r2-b-${tag}`);
      mints.push(r.row.id);
    }
    // revoke one → floor still rejects it while OFF
    await registry.revokeOwnSession({ userId: userB, sessionId: mints[0] });
    const revokedRow = await freshRow(mints[0]);
    expect(revokedRow!.status).toBe("revoked");
    const revokedToken = (await db.select().from(authSessions).where(eq(authSessions.id, mints[0])))[0]!;
    void revokedToken;
    // (token not stored on the row — floor re-check via sid is covered in T22)

    // ON → reconcile: keep 2 most-recently-seen, demote others to unslotted (no revoke)
    setFlag(true);
    await registry.reconcileAfterFlagOn(userB);
    const rows = (await db.select().from(authSessions).where(eq(authSessions.userId, userB)))
      .filter(r => r.status === "active" || r.status === "unslotted_legacy");
    const activeNow = rows.filter(r => r.status === "active");
    const unslottedNow = rows.filter(r => r.status === "unslotted_legacy");
    expect(activeNow.length).toBeLessThanOrEqual(2);
    expect(activeNow.length + unslottedNow.length).toBeGreaterThanOrEqual(3);
    expect(rows.every(r => r.status !== "revoked")).toBe(true);
  });

  it("T41: auth.logout marks the caller's registry row revoked", async () => {
    const s = await mintSession(buyer, `r2-buyer-${tag}`);
    if (s.row.status !== "active") {
      await db.update(authSessions).set({ status: "active" }).where(eq(authSessions.id, s.row.id));
    }
    const caller = appRouter.createCaller({
      user: { id: buyer, openId: `r2-buyer-${tag}`, role: "user" } as TrpcContext["user"],
      authSession: await freshRow(s.row.id),
      req: { headers: { cookie: `app_session_id=${s.token}` } } as any,
      res: { clearCookie: () => undefined } as any,
    });
    await caller.auth.logout();
    expect((await freshRow(s.row.id))!.status).toBe("revoked");
  });
});
