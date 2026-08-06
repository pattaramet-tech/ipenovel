import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestNovel, uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";
import { wishlists, novels } from "../drizzle/schema";

/**
 * feature/profile-wishlist - coverage for the wishlists.list join query
 * (server/db.ts's getWishlistNovelsByUserId) and the ownership/validation
 * rules around wishlists.add/remove, backing the new Wishlist section on
 * /profile.
 *
 * These tests deliberately do NOT use the `if (!db) return` escape hatch
 * some legacy files use (see daily-checkin-foundation.integration.test.ts's
 * own docstring for why): this file lives in the integration project, whose
 * globalSetup already refuses to run without a verified disposable
 * `ipenovel_test` database - silently no-op'ing here would hide exactly the
 * regressions this file exists to catch.
 */

function ctxFor(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `wishlist-${userId}`,
      email: `wishlist-${userId}@example.test`,
      name: "Wishlist Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

/** Fails loudly (never silently skips) if the integration DB is missing. */
function requireIntegrationDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "profileWishlist.integration.test.ts requires a prepared disposable test database " +
        "(TEST_DATABASE_URL pointing at ipenovel_test). Run `pnpm test:db:prepare` first."
    );
  }
  return getTestDb();
}

async function cleanupWishlists(userIds: number[]) {
  const testDb = requireIntegrationDb();
  for (const userId of userIds) {
    await testDb.delete(wishlists).where(eq(wishlists.userId, userId));
  }
}

async function expectTRPCErrorCode(promise: Promise<unknown>, code: TRPCError["code"]) {
  try {
    await promise;
    expect.fail(`expected a TRPCError with code ${code}, but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe(code);
  }
}

describe.sequential("wishlists.list / add / remove (real disposable test database)", () => {
  it("a user sees only their own wishlist, never another user's", async () => {
    requireIntegrationDb();
    const userA = await createTestUser();
    const userB = await createTestUser();
    const novelA = await createTestNovel();
    const novelB = await createTestNovel();
    const callerA = appRouter.createCaller(ctxFor(userA.id));
    const callerB = appRouter.createCaller(ctxFor(userB.id));

    await callerA.wishlists.add({ novelId: novelA.id });
    await callerB.wishlists.add({ novelId: novelB.id });

    const listA = await callerA.wishlists.list();
    const listB = await callerB.wishlists.list();

    expect(listA).toHaveLength(1);
    expect(listA[0].novel.id).toBe(novelA.id);
    expect(listB).toHaveLength(1);
    expect(listB[0].novel.id).toBe(novelB.id);

    await cleanupWishlists([userA.id, userB.id]);
    await deleteFixtures({ novelIds: [novelA.id, novelB.id], userIds: [userA.id, userB.id] });
  });

  it("a novel archived after being wishlisted disappears from the list, but its wishlist row is left untouched", async () => {
    const testDb = requireIntegrationDb();
    const user = await createTestUser();
    const novel = await createTestNovel({ publicationStatus: "published" });
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.wishlists.add({ novelId: novel.id });
    expect(await caller.wishlists.list()).toHaveLength(1);

    await testDb.update(novels).set({ publicationStatus: "archived" }).where(eq(novels.id, novel.id));

    expect(await caller.wishlists.list()).toEqual([]);

    // Never auto-deleted - the row is still there, just filtered out of the
    // profile view, so it would reappear if the novel were unarchived.
    const rows = await testDb.select().from(wishlists).where(eq(wishlists.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].novelId).toBe(novel.id);

    await cleanupWishlists([user.id]);
    await deleteFixtures({ novelIds: [novel.id], userIds: [user.id] });
  });

  it("orders results by wishlist createdAt, newest first", async () => {
    const testDb = requireIntegrationDb();
    const user = await createTestUser();
    const novelOld = await createTestNovel();
    const novelMid = await createTestNovel();
    const novelNew = await createTestNovel();
    const caller = appRouter.createCaller(ctxFor(user.id));

    // Inserted directly (not through wishlists.add) with explicit, clearly
    // separated createdAt values - MySQL's default TIMESTAMP precision is
    // whole seconds, so three real adds in a tight loop could otherwise tie.
    const base = Date.now();
    await testDb.insert(wishlists).values({ userId: user.id, novelId: novelOld.id, createdAt: new Date(base) });
    await testDb.insert(wishlists).values({ userId: user.id, novelId: novelMid.id, createdAt: new Date(base + 60_000) });
    await testDb.insert(wishlists).values({ userId: user.id, novelId: novelNew.id, createdAt: new Date(base + 120_000) });

    const list = await caller.wishlists.list();
    expect(list.map((item) => item.novel.id)).toEqual([novelNew.id, novelMid.id, novelOld.id]);

    await cleanupWishlists([user.id]);
    await deleteFixtures({ novelIds: [novelOld.id, novelMid.id, novelNew.id], userIds: [user.id] });
  });

  it("wishlists.add on a novel id that doesn't exist -> NOT_FOUND, and creates no row", async () => {
    const testDb = requireIntegrationDb();
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));
    const bogusNovelId = 999_999_999;

    await expectTRPCErrorCode(caller.wishlists.add({ novelId: bogusNovelId }), "NOT_FOUND");

    const rows = await testDb.select().from(wishlists).where(eq(wishlists.userId, user.id));
    expect(rows).toHaveLength(0);

    await deleteFixtures({ userIds: [user.id] });
  });

  it("wishlists.add on an archived novel -> NOT_FOUND, and creates no row", async () => {
    const testDb = requireIntegrationDb();
    const user = await createTestUser();
    const archivedNovel = await createTestNovel({ publicationStatus: "archived" });
    const caller = appRouter.createCaller(ctxFor(user.id));

    await expectTRPCErrorCode(caller.wishlists.add({ novelId: archivedNovel.id }), "NOT_FOUND");

    const rows = await testDb.select().from(wishlists).where(eq(wishlists.userId, user.id));
    expect(rows).toHaveLength(0);

    await deleteFixtures({ novelIds: [archivedNovel.id], userIds: [user.id] });
  });

  it("adding the same novel twice -> CONFLICT on the second call", async () => {
    const user = await createTestUser();
    const novel = await createTestNovel();
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.wishlists.add({ novelId: novel.id });
    await expectTRPCErrorCode(caller.wishlists.add({ novelId: novel.id }), "CONFLICT");

    await cleanupWishlists([user.id]);
    await deleteFixtures({ novelIds: [novel.id], userIds: [user.id] });
  });

  it("removing another user's wishlist row -> FORBIDDEN, and the row survives", async () => {
    const testDb = requireIntegrationDb();
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const novel = await createTestNovel();
    const ownerCaller = appRouter.createCaller(ctxFor(owner.id));
    const strangerCaller = appRouter.createCaller(ctxFor(stranger.id));

    await ownerCaller.wishlists.add({ novelId: novel.id });
    const [ownerItem] = await ownerCaller.wishlists.list();

    await expectTRPCErrorCode(
      strangerCaller.wishlists.remove({ wishlistId: ownerItem.wishlistId }),
      "FORBIDDEN"
    );

    const rows = await testDb.select().from(wishlists).where(eq(wishlists.id, ownerItem.wishlistId));
    expect(rows).toHaveLength(1);

    await cleanupWishlists([owner.id, stranger.id]);
    await deleteFixtures({ novelIds: [novel.id], userIds: [owner.id, stranger.id] });
  });

  it("wishlists.list never calls db.getNovelById (no N+1) even with multiple wishlisted novels", async () => {
    requireIntegrationDb();
    const user = await createTestUser();
    const tag = uniqueTestTag("wl");
    const novelOne = await createTestNovel({ title: `N+1 guard 1 ${tag}` });
    const novelTwo = await createTestNovel({ title: `N+1 guard 2 ${tag}` });
    const novelThree = await createTestNovel({ title: `N+1 guard 3 ${tag}` });
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.wishlists.add({ novelId: novelOne.id });
    await caller.wishlists.add({ novelId: novelTwo.id });
    await caller.wishlists.add({ novelId: novelThree.id });

    const getNovelByIdSpy = vi.spyOn(db, "getNovelById");
    const list = await caller.wishlists.list();

    expect(list).toHaveLength(3);
    expect(getNovelByIdSpy).not.toHaveBeenCalled();
    getNovelByIdSpy.mockRestore();

    await cleanupWishlists([user.id]);
    await deleteFixtures({ novelIds: [novelOne.id, novelTwo.id, novelThree.id], userIds: [user.id] });
  });
});
