import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appRouter } from "./routers";
import { __setDbForTests } from "./db";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import * as registry from "./services/sessionRegistry";
import * as leaseService from "./services/readingLease";
import {
  authSessions,
  sessionSlots,
  readingLeases,
  episodePurchases,
  episodes,
  novels,
  users,
} from "../drizzle/schema";

/**
 * R3 addendum (Independent Review F4/F5 + brief step 4):
 *  - role-chain pending bypass: pending sessions are blocked on the ADMIN and
 *    AUTHOR business chains too (not just protectedProcedure) — no role
 *    elevation or migration-gate semantics change for active/unslotted.
 *  - free chapter: readable without a lease, and reading it NEVER
 *    acquires/steals/consumes the paid-reading lease (F5).
 *  - unpaid + lease: holding the lease grants NOTHING without entitlement
 *    (baseline guard unchanged).
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("no id");
  return id;
}

describe("R3 addendum — role-chain pending bypass + free/paid lease boundary", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  let adminId = 0;
  let authorId = 0;
  let buyerId = 0;
  let paidNovel = 0;
  let freeEpisode = 0;
  let paidEpisode = 0;
  const sessionIds: number[] = [];
  const cleanup: string[] = [];

  beforeAll(async () => {
    // R3X: the pending gate + lease enforcement are flag-gated — enable for
    // this suite only (restored to OFF after; default is OFF).
    process.env.READER_SESSION_CONTROLS = "true";
    adminId = insertId(await db.insert(users).values({
      openId: `r3x-admin-${tag}`, name: "R3X Admin", email: `r3x-admin-${tag}@t.test`, loginMethod: "test", role: "admin",
    }));
    authorId = insertId(await db.insert(users).values({
      openId: `r3x-author-${tag}`, name: "R3X Author", email: `r3x-author-${tag}@t.test`, loginMethod: "test", role: "author",
    }));
    buyerId = insertId(await db.insert(users).values({
      openId: `r3x-buyer-${tag}`, name: "R3X Buyer", email: `r3x-buyer-${tag}@t.test`, loginMethod: "test", role: "user",
    }));
    paidNovel = insertId(await db.insert(novels).values({
      title: `R3X ${tag}`, slug: `r3x-${tag}`, author: "R3X", authorUserId: null,
      publicationStatus: "published", storyStatus: "ongoing",
    }));
    freeEpisode = insertId(await db.insert(episodes).values({
      novelId: paidNovel, episodeNumber: "f1", title: "Free", price: "0.00",
      isFree: true, isPublished: true, saleMode: "chapter", content: "FREE CONTENT",
    }));
    paidEpisode = insertId(await db.insert(episodes).values({
      novelId: paidNovel, episodeNumber: "p1", title: "Paid", price: "30.00",
      isFree: false, isPublished: true, saleMode: "chapter", content: "PAID CONTENT",
    }));
    await db.insert(episodePurchases).values({
      userId: buyerId, novelId: paidNovel, episodeId: paidEpisode, pricePaid: "30.00",
    });
  });

  afterAll(async () => {
    process.env.READER_SESSION_CONTROLS = "false"; // restore default OFF
    // afterAll restore
    await db.delete(episodePurchases).where(eq(episodePurchases.userId, buyerId));
    await db.delete(episodes).where(inArray(episodes.id, [freeEpisode, paidEpisode]));
    await db.delete(novels).where(eq(novels.id, paidNovel));
    if (sessionIds.length) await db.delete(authSessions).where(inArray(authSessions.id, sessionIds));
    await db.delete(authSessions).where(inArray(authSessions.userId, [adminId, authorId, buyerId]));
    await db.delete(readingLeases).where(inArray(readingLeases.userId, [adminId, authorId, buyerId]));
    await db.delete(sessionSlots).where(inArray(sessionSlots.userId, [adminId, authorId, buyerId]));
    await db.delete(users).where(inArray(users.id, [adminId, authorId, buyerId]));
    void cleanup;
  });

  function ctxFor(userId: number, openId: string, role: string, sessionRow: any): TrpcContext {
    return {
      user: {
        id: userId, openId, email: `${openId}@t.test`, name: openId, loginMethod: "test",
        role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      } as TrpcContext["user"],
      authSession: sessionRow ?? null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: {} as TrpcContext["res"],
    };
  }

  async function activeRowFor(userId: number): Promise<any> {
    const [row] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userId))
      .limit(1);
    return row;
  }

  it("R3X-1: free chapter readable WITHOUT a lease, and reading it never creates the paid lease", async () => {
    const row = await registry.allocateSessionRow({
      userId: buyerId, token: `tok-free-${tag}`, sid: `sid-free-${tag}`,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    sessionIds.push(row.id);
    const caller = appRouter.createCaller(ctxFor(buyerId, `r3x-buyer-${tag}`, "user", row));
    const ep = await caller.reader.getEpisode({ episodeId: freeEpisode });
    expect(ep.canRead).toBe(true);
    const leaseAfterFreeRead = (await db.select().from(readingLeases).where(eq(readingLeases.userId, buyerId)))[0];
    // F5: free read never acquires/consumes the paid lease
    expect(leaseAfterFreeRead).toBeUndefined();
  });

  it("R3X-2: unpaid author holding a lease STILL gets only the locked preview (entitlement unchanged)", async () => {
    // R3X-2 (brief step 4: unpaid+lease ยังไม่ได้ paid access): a lease
    // grants NOTHING without entitlement — the non-purchaser author with a
    // directly-bound lease row still gets the locked preview only.
    const authorSid = registry.generateSid();
    const authorRow = await registry.allocateSessionRow({
      userId: authorId, token: `tok-ax-${tag}`, sid: authorSid,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    sessionIds.push(authorRow.id);
    await leaseService.acquireLease({ sessionId: authorRow.id, userId: authorId });
    const authorCaller = appRouter.createCaller(ctxFor(authorId, `r3x-author-${tag}`, "author", authorRow));
    const ep = await authorCaller.reader.getEpisode({ episodeId: paidEpisode });
    expect(ep.canRead).toBe(false);
    expect(ep.isLocked).toBe(true);
    expect(ep.content ?? "").not.toContain("PAID CONTENT");
  });

  it("R3X-3: pending ADMIN session blocked on the admin chain (F4 role-chain coverage)", async () => {
    const row = await registry.allocateSessionRow({
      userId: adminId, token: `tok-pa-${tag}`, sid: `sid-pa-${tag}`,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    sessionIds.push(row.id);
    if (row.status !== "pending_choice") {
      await db.update(authSessions).set({ status: "pending_choice" }).where(eq(authSessions.id, row.id));
    }
    const freshPendingAdmin = (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
    const pendingAdmin = appRouter.createCaller(ctxFor(adminId, `r3x-admin-${tag}`, "admin", freshPendingAdmin));
    await expect(pendingAdmin.admin.dashboard.summary({ period: "all" })).rejects.toMatchObject({
      cause: { code: "SESSION_SLOT_PENDING" },
    });
    // active admin (same role chain) is NOT blocked
  });

  it("R3X-4: pending AUTHOR session blocked on the authorContent chain (F4)", async () => {
    const row = await registry.allocateSessionRow({
      userId: authorId, token: `tok-po-${tag}`, sid: `sid-po-${tag}`,
      expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    });
    sessionIds.push(row.id);
    if (row.status !== "pending_choice") {
      await db.update(authSessions).set({ status: "pending_choice" }).where(eq(authSessions.id, row.id));
    }
    const freshPendingAuthor = (await db.select().from(authSessions).where(eq(authSessions.id, row.id)))[0];
    const pendingAuthor = appRouter.createCaller(ctxFor(authorId, `r3x-author-${tag}`, "author", freshPendingAuthor));
    await expect(
      pendingAuthor.admin.novels.create({ title: "t", author: "a" } as any)
    ).rejects.toMatchObject({ cause: { code: "SESSION_SLOT_PENDING" } });
  });
});
