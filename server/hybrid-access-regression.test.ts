import { describe, it, expect, beforeEach } from "vitest";
import * as dbHelpers from "./db";
import { getDb } from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { computeContentFlags, resolveSaleMode, normalizeEpisodeRange } from "./services/readerService";

/**
 * Phase 1 hybrid-access regression suite.
 *
 * Purpose: lock in the entitlement contract described in the hybrid package
 * incident report - a customer who bought a legacy Docs/PDF episode must
 * always be able to open it, a customer who bought a plaintext package must
 * always be able to read it on the web, and nobody who hasn't purchased may
 * ever receive `content` or `fileUrl` from any endpoint. These tests exist
 * so a future change to readerService/routers can't silently regress any of
 * that without a red test.
 *
 * Two tiers, by design:
 * 1. Pure logic tests (computeContentFlags/resolveSaleMode/normalizeEpisodeRange)
 *    run unconditionally - no DB required, so they always provide real signal.
 * 2. End-to-end tests exercise the actual tRPC procedures (novels.episodes,
 *    reader.getEpisode, reader.getProgress/saveProgress) via appRouter.createCaller,
 *    following the existing repo convention (see server/tests/download.test.ts)
 *    of guarding on `if (!db) return` so they no-op cleanly in environments
 *    without a live DATABASE_URL, but run for real wherever one is configured.
 */

function makeUserContext(userId: number, role: "user" | "admin" = "user"): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `hybrid-test-${userId}`,
      email: `hybrid-test-${userId}@example.com`,
      name: "Hybrid Test User",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("Hybrid Access - pure flag logic (always runs, no DB required)", () => {
  describe("computeContentFlags", () => {
    it("Case A - legacy fileUrl only: hasLegacyFile true, hasContent false", () => {
      expect(computeContentFlags({ content: null, fileUrl: "https://docs.google.com/document/d/abc" })).toEqual({
        hasContent: false,
        hasLegacyFile: true,
      });
    });

    it("Case B - plaintext content only: hasContent true, hasLegacyFile false", () => {
      expect(computeContentFlags({ content: "เนื้อเรื่องบทที่ 1", fileUrl: "" })).toEqual({
        hasContent: true,
        hasLegacyFile: false,
      });
    });

    it("Case C - hybrid content + fileUrl: both true", () => {
      expect(
        computeContentFlags({ content: "เนื้อเรื่องบทที่ 1", fileUrl: "https://docs.google.com/document/d/abc" })
      ).toEqual({ hasContent: true, hasLegacyFile: true });
    });

    it("Case D-equivalent - neither content nor fileUrl: both false", () => {
      expect(computeContentFlags({ content: "", fileUrl: "" })).toEqual({ hasContent: false, hasLegacyFile: false });
      expect(computeContentFlags({ content: null, fileUrl: null })).toEqual({ hasContent: false, hasLegacyFile: false });
    });

    it("treats whitespace-only content/fileUrl as absent", () => {
      expect(computeContentFlags({ content: "   \n  ", fileUrl: "   " })).toEqual({
        hasContent: false,
        hasLegacyFile: false,
      });
    });
  });

  describe("resolveSaleMode legacy fallback", () => {
    it("explicit saleMode column wins over everything else", () => {
      expect(resolveSaleMode({ saleMode: "chapter", fileUrl: "http://x", episodeNumber: "51 - 100" })).toBe("chapter");
      expect(resolveSaleMode({ saleMode: "package", fileUrl: "", episodeNumber: "12" })).toBe("package");
    });

    it("fileUrl present with no explicit saleMode resolves to package", () => {
      expect(resolveSaleMode({ fileUrl: "http://x", episodeNumber: "12" })).toBe("package");
    });

    it("range-style episodeNumber with no fileUrl resolves to package", () => {
      expect(resolveSaleMode({ episodeNumber: "436 - 508" })).toBe("package");
    });

    it("single episodeNumber, no fileUrl resolves to chapter", () => {
      expect(resolveSaleMode({ episodeNumber: "12" })).toBe("chapter");
    });
  });

  describe("normalizeEpisodeRange - import matching identity", () => {
    it.each([
      ["51-100", "51 - 100"],
      ["51 - 100", "51 - 100"],
      ["051-100", "51 - 100"],
      ["#051 - 100", "51 - 100"],
      ["บทที่ 51 - 100", "51 - 100"],
      ["  51   -   100  ", "51 - 100"],
    ])("normalizes %s to canonical %s", (input, expected) => {
      expect(normalizeEpisodeRange(input)).toBe(expected);
    });

    it("normalizes single-number episodes without a dash", () => {
      expect(normalizeEpisodeRange("001")).toBe("1");
      expect(normalizeEpisodeRange("#7")).toBe("7");
    });
  });
});

describe("Hybrid Access - end-to-end (Cases A-E, requires a live DATABASE_URL)", () => {
  let novelId: number;
  let buyerUserId: number;
  let strangerUserId: number;

  let legacyFileOnlyEpisodeId: number; // Case A
  let plaintextOnlyEpisodeId: number; // Case B
  let hybridEpisodeId: number; // Case C
  let unpurchasedHybridEpisodeId: number; // Case D

  const legacyFileUrl = "https://docs.google.com/document/d/hybrid-test-doc/edit";
  const plaintextContent = "บทที่ 1\n\nเนื้อเรื่องทดสอบสำหรับ hybrid access regression suite";

  beforeEach(async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();

    await dbHelpers.upsertUser({
      openId: `hybrid-buyer-${ts}`,
      name: "Hybrid Buyer",
      email: `hybrid-buyer-${ts}@example.com`,
      role: "user",
    });
    const buyer = await dbHelpers.getUserByOpenId(`hybrid-buyer-${ts}`);
    if (!buyer) throw new Error("buyer not created");
    buyerUserId = buyer.id;

    await dbHelpers.upsertUser({
      openId: `hybrid-stranger-${ts}`,
      name: "Hybrid Stranger",
      email: `hybrid-stranger-${ts}@example.com`,
      role: "user",
    });
    const stranger = await dbHelpers.getUserByOpenId(`hybrid-stranger-${ts}`);
    if (!stranger) throw new Error("stranger not created");
    strangerUserId = stranger.id;

    const novel: any = await dbHelpers.createNovel({
      title: `Hybrid Access Test Novel ${ts}`,
      author: "Test Author",
      description: "Test",
    });
    novelId = novel.id;

    const legacyEp = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: `${ts}-A`,
      title: "Legacy file only",
      price: "99.00",
      saleMode: "package",
      fileUrl: legacyFileUrl,
    });
    legacyFileOnlyEpisodeId = legacyEp.id;

    const plaintextEp = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: `${ts}-B`,
      title: "Plaintext only",
      price: "99.00",
      saleMode: "package",
      content: plaintextContent,
    });
    plaintextOnlyEpisodeId = plaintextEp.id;

    const hybridEp = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: `${ts}-C`,
      title: "Hybrid file + content",
      price: "99.00",
      saleMode: "package",
      fileUrl: legacyFileUrl,
      content: plaintextContent,
    });
    hybridEpisodeId = hybridEp.id;

    const unpurchasedEp = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: `${ts}-D`,
      title: "Unpurchased hybrid",
      price: "99.00",
      saleMode: "package",
      fileUrl: legacyFileUrl,
      content: plaintextContent,
    });
    unpurchasedHybridEpisodeId = unpurchasedEp.id;

    // Buyer purchases episodes A, B, C (order-based / legacy purchase path)
    // but never purchases D - D exists purely to prove unpurchased users
    // never receive content/fileUrl regardless of what the episode has.
    const { generateOrderNumber } = await import("./services/orderService");
    for (const episodeId of [legacyFileOnlyEpisodeId, plaintextOnlyEpisodeId, hybridEpisodeId]) {
      const order: any = await dbHelpers.createOrder({
        orderNumber: generateOrderNumber(),
        userId: buyerUserId,
        subtotal: "99.00",
        totalAmount: "99.00",
      });
      await dbHelpers.createPurchase(buyerUserId, novelId, episodeId, order.id);
    }
  });

  it("Case A: legacy fileUrl only - buyer sees hasLegacyFile + fileUrl, no content required", async () => {
    const db = await getDb();
    if (!db) return;

    const caller = appRouter.createCaller(makeUserContext(buyerUserId));

    const list = await caller.novels.episodes({ novelId });
    const listEp: any = list.find((e: any) => e.id === legacyFileOnlyEpisodeId);
    expect(listEp).toBeTruthy();
    expect(listEp.hasLegacyFile).toBe(true);
    expect(listEp.hasContent).toBe(false);
    expect(listEp.canRead).toBe(true);
    expect(listEp.hasPurchased).toBe(true);
    expect(listEp.isPurchased).toBe(true);
    expect(listEp.fileUrl).toBe(legacyFileUrl);
    expect(listEp.content).toBeUndefined();

    const detail: any = await caller.reader.getEpisode({ episodeId: legacyFileOnlyEpisodeId });
    expect(detail.canRead).toBe(true);
    expect(detail.episode.hasLegacyFile).toBe(true);
    expect(detail.episode.hasContent).toBe(false);
    expect(detail.episode.fileUrl).toBe(legacyFileUrl);
    // No web content exists for this episode - frontend falls back to the
    // "open legacy file" button, it must never see a truthy `content`.
    expect(detail.content).toBeFalsy();
  });

  it("Case B: plaintext content only - buyer sees hasContent + content, no fileUrl", async () => {
    const db = await getDb();
    if (!db) return;

    const caller = appRouter.createCaller(makeUserContext(buyerUserId));

    const list = await caller.novels.episodes({ novelId });
    const listEp: any = list.find((e: any) => e.id === plaintextOnlyEpisodeId);
    expect(listEp.hasContent).toBe(true);
    expect(listEp.hasLegacyFile).toBe(false);
    expect(listEp.canRead).toBe(true);
    expect(listEp.fileUrl).toBeFalsy();

    const detail: any = await caller.reader.getEpisode({ episodeId: plaintextOnlyEpisodeId });
    expect(detail.canRead).toBe(true);
    expect(detail.episode.hasContent).toBe(true);
    expect(detail.episode.hasLegacyFile).toBe(false);
    expect(detail.content).toBe(plaintextContent);
    expect(detail.episode.fileUrl).toBeFalsy();
  });

  it("Case C: hybrid fileUrl + content - buyer sees both, gets content and fileUrl", async () => {
    const db = await getDb();
    if (!db) return;

    const caller = appRouter.createCaller(makeUserContext(buyerUserId));

    const list = await caller.novels.episodes({ novelId });
    const listEp: any = list.find((e: any) => e.id === hybridEpisodeId);
    expect(listEp.hasContent).toBe(true);
    expect(listEp.hasLegacyFile).toBe(true);
    expect(listEp.canRead).toBe(true);
    expect(listEp.fileUrl).toBe(legacyFileUrl);

    const detail: any = await caller.reader.getEpisode({ episodeId: hybridEpisodeId });
    expect(detail.canRead).toBe(true);
    expect(detail.episode.hasContent).toBe(true);
    expect(detail.episode.hasLegacyFile).toBe(true);
    expect(detail.content).toBe(plaintextContent);
    expect(detail.episode.fileUrl).toBe(legacyFileUrl);
  });

  it("Case D: unpurchased user never receives content or fileUrl for any hybrid episode", async () => {
    const db = await getDb();
    if (!db) return;

    const caller = appRouter.createCaller(makeUserContext(strangerUserId));

    const list = await caller.novels.episodes({ novelId });
    for (const episodeId of [legacyFileOnlyEpisodeId, plaintextOnlyEpisodeId, hybridEpisodeId, unpurchasedHybridEpisodeId]) {
      const listEp: any = list.find((e: any) => e.id === episodeId);
      expect(listEp).toBeTruthy();
      expect(listEp.canRead).toBe(false);
      expect(listEp.hasPurchased).toBe(false);
      expect(listEp.isPurchased).toBe(false);
      // fileUrl must be null regardless of whether hasLegacyFile metadata is
      // true - metadata may describe the episode, but the raw URL itself
      // must never leak to someone who hasn't purchased it.
      expect(listEp.fileUrl).toBeFalsy();
      expect(listEp.content).toBeUndefined();

      const detail: any = await caller.reader.getEpisode({ episodeId });
      expect(detail.canRead).toBe(false);
      expect(detail.content).toBeFalsy();
      expect(detail.episode.fileUrl).toBeFalsy();
    }
  });

  it("Case E: reading progress is denied without access, allowed with access", async () => {
    const db = await getDb();
    if (!db) return;

    const strangerCaller = appRouter.createCaller(makeUserContext(strangerUserId));

    const progress = await strangerCaller.reader.getProgress({ episodeId: hybridEpisodeId });
    expect(progress).toBeNull();

    await expect(
      strangerCaller.reader.saveProgress({ episodeId: hybridEpisodeId, progressPercent: 50 })
    ).rejects.toThrow();

    const buyerCaller = appRouter.createCaller(makeUserContext(buyerUserId));
    const saveResult = await buyerCaller.reader.saveProgress({ episodeId: hybridEpisodeId, progressPercent: 42 });
    expect(saveResult.success).toBe(true);

    const buyerProgress = await buyerCaller.reader.getProgress({ episodeId: hybridEpisodeId });
    expect(buyerProgress?.progressPercent).toBe(42);
  });
});

describe("Hybrid Access - Case E boundary (always runs, no fixtures required)", () => {
  it("getProgress/saveProgress deny access to a non-existent episode for any user", async () => {
    const caller = appRouter.createCaller(makeUserContext(987654321));

    const progress = await caller.reader.getProgress({ episodeId: 987654321 });
    expect(progress).toBeNull();

    await expect(
      caller.reader.saveProgress({ episodeId: 987654321, progressPercent: 10 })
    ).rejects.toThrow();
  });

  it("reader.getEpisode returns NOT_FOUND for a non-existent episode rather than leaking anything", async () => {
    const caller = appRouter.createCaller(makeUserContext(987654321));
    await expect(caller.reader.getEpisode({ episodeId: 987654321 })).rejects.toThrow();
  });
});
