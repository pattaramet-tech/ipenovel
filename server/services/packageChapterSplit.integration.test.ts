import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { and, eq, sql } from "drizzle-orm";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import * as db from "../db";
import { getTestDb, requireTestDb } from "../test-helpers/testDb";
import { createTestOrder, createTestOrderItem, createTestUser, uniqueTestTag } from "../test-helpers/fixtures";
import {
  adminGiftEntitlements,
  episodePurchases,
  episodes as episodesTable,
  novels as novelsTable,
  orders as ordersTable,
  packageChapterMappings,
  walletAccounts,
} from "../../drizzle/schema";
import {
  PackageSplitError,
  SPLIT_MAPPING_DERIVATION,
  applyPackageSplit,
  previewPackageSplit,
  scanLegacyPackages,
} from "./packageChapterSplit.service";
import { purchaseEpisodeWithWallet } from "./episodePurchaseService";
import { canReadEpisode } from "./readerService";
import { quotePackageUpgrade } from "./packageUpgradeService";
import { sha256Hex, splitPackageContent } from "./packageChapterSplit.domain";
import * as splitServiceModule from "./packageChapterSplit.service";

/**
 * Package -> chapter split, end to end on the disposable ipenovel_test DB:
 * backfill lifecycle (preview read-only, apply, idempotent re-apply,
 * STALE_PLAN, concurrent apply, fail-closed plans, existing chapters),
 * package-owner entitlement (read via mapping, never charged twice through
 * wallet / cart / checkout), P3 credit interplay, no notifications, and the
 * ZIP "package + chapters" import mode.
 */

let testDb: ReturnType<typeof getTestDb>;

beforeAll(async () => {
  await requireTestDb();
  testDb = getTestDb();
});

afterAll(() => {
  delete process.env.PACKAGE_UPGRADE_ENABLED;
});

function userContext(user: { id: number; role: "user" | "admin" | "author" }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: `split-${user.id}`,
      email: `split-${user.id}@example.test`,
      name: "Split Test User",
      loginMethod: "test",
      role: user.role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}
const caller = (user: { id: number; role: "user" | "admin" | "author" }) => appRouter.createCaller(userContext(user));

function packContent(numbers: number[]): string {
  return numbers.map((n) => `บทที่ ${n} ชื่อบท ${n}\n\nเนื้อเรื่องบทที่ ${n} บรรทัดหนึ่ง\nบรรทัดสอง ${n}\n\n`).join("");
}

/** The EXACT stored text of a chapter as the splitter will slice it. */
function storedSlice(content: string, episodeNumber: string, chapterNumber: number): string {
  const plan = splitPackageContent({ episodeNumber, content });
  const chapter = plan.chapters.find((c) => c.chapterNumber === chapterNumber);
  if (!chapter) throw new Error(`chapter ${chapterNumber} not found in plan`);
  return content.slice(chapter.sourceStart, chapter.sourceEnd);
}

async function createNovel(): Promise<number> {
  const tag = uniqueTestTag("split");
  const result = await testDb.insert(novelsTable).values({
    title: `Split Novel ${tag}`,
    slug: `split-novel-${tag}`,
    author: "Split Test",
    publicationStatus: "published",
    storyStatus: "ongoing",
  });
  return (result as unknown as [{ insertId: number }])[0].insertId;
}

async function createEpisode(values: {
  novelId: number;
  episodeNumber: string;
  content: string | null;
  saleMode: "package" | "chapter";
  price?: string;
  isPublished?: boolean;
}): Promise<number> {
  const result = await testDb.insert(episodesTable).values({
    novelId: values.novelId,
    episodeNumber: values.episodeNumber,
    title: `EP ${values.episodeNumber}`,
    price: values.price ?? "30.00",
    isFree: false,
    isPublished: values.isPublished ?? true,
    saleMode: values.saleMode,
    content: values.content,
    contentFormat: "plain_text",
  });
  return (result as unknown as [{ insertId: number }])[0].insertId;
}

async function createPackageWorld(numbers = [1, 2, 3, 4, 5], range = "1 - 5") {
  const novelId = await createNovel();
  const content = packContent(numbers);
  const packageId = await createEpisode({ novelId, episodeNumber: range, content, saleMode: "package" });
  return { novelId, packageId, content };
}

async function novelEpisodes(novelId: number) {
  return testDb.select().from(episodesTable).where(eq(episodesTable.novelId, novelId));
}

async function chapterRows(novelId: number) {
  return (await novelEpisodes(novelId)).filter((e) => e.saleMode === "chapter");
}

async function seedOrderOwnership(userId: number, novelId: number, episodeId: number) {
  const order = await createTestOrder(userId, { subtotal: "30.00", totalAmount: "30.00" });
  await createTestOrderItem({ orderId: order.id, novelId, episodeId, unitPrice: "30.00" });
  await testDb.update(ordersTable).set({ status: "approved", paymentStatus: "approved" }).where(eq(ordersTable.id, order.id));
  await db.createPurchase(userId, novelId, episodeId, order.id);
}

async function seedLivePendingOrder(userId: number, novelId: number, episodeId: number) {
  const order = await createTestOrder(userId, { subtotal: "30.00", totalAmount: "30.00" });
  await createTestOrderItem({ orderId: order.id, novelId, episodeId, unitPrice: "30.00" });
}

async function seedGift(userId: number, novelId: number, episodeId: number) {
  await testDb.insert(adminGiftEntitlements).values({
    userId,
    novelId,
    episodeId,
    actorAdminId: userId,
    reason: "split test gift",
    idempotencyKey: `split-gift-${uniqueTestTag("g")}`,
  });
}

async function setWallet(userId: number, balance: string) {
  await db.getOrCreateWalletAccount(userId);
  await testDb.update(walletAccounts).set({ balance }).where(eq(walletAccounts.userId, userId));
}

async function walletBalance(userId: number): Promise<string> {
  return String((await db.getOrCreateWalletAccount(userId)).balance);
}

async function countRows(table: string): Promise<number> {
  try {
    const rows: any = await testDb.execute(sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``));
    const unwrapped = Array.isArray(rows?.[0]) ? rows[0] : rows;
    return Number(unwrapped?.[0]?.n ?? 0);
  } catch {
    return -1; // table not present in this schema - comparison still valid
  }
}

async function splitPackage(packageId: number, chapterPrice = "5", publish = false) {
  const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice }, publish });
  expect(preview.applicable).toBe(true);
  return applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice }, publish });
}

describe("package split backfill lifecycle", () => {
  it("preview is read-only; apply creates exactly the declared chapters + mappings and never touches the package row", async () => {
    const { novelId, packageId, content } = await createPackageWorld();
    const before = await novelEpisodes(novelId);

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.applicable).toBe(true);
    expect(preview.counts).toEqual({ create: 5, keep: 0, conflict: 0 });
    expect(preview.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await novelEpisodes(novelId)).toHaveLength(before.length); // read-only

    const result = await applyPackageSplit({
      packageEpisodeId: packageId,
      planHash: preview.planHash!,
      pricing: { chapterPrice: "5" },
    });
    expect(result.createdEpisodeIds).toHaveLength(5);

    const chapters = (await chapterRows(novelId)).sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
    expect(chapters.map((c) => c.episodeNumber)).toEqual(["1", "2", "3", "4", "5"]);
    for (const chapter of chapters) {
      expect(chapter.isPublished).toBe(false); // default: unpublished draft
      expect(String(chapter.price)).toBe("5.00");
      expect(chapter.isFree).toBe(false);
      expect(String(chapter.content).startsWith(`บทที่ ${chapter.episodeNumber}`)).toBe(true);
      expect(content.includes(String(chapter.content))).toBe(true); // exact source slice
    }

    const mappings = await testDb
      .select()
      .from(packageChapterMappings)
      .where(eq(packageChapterMappings.packageEpisodeId, packageId));
    expect(mappings).toHaveLength(5);
    expect(mappings.every((m) => m.derivation === SPLIT_MAPPING_DERIVATION)).toBe(true);

    // The package row itself is byte-identical.
    const [pkgBefore] = before.filter((e) => e.id === packageId);
    const [pkgAfter] = (await novelEpisodes(novelId)).filter((e) => e.id === packageId);
    expect(pkgAfter.episodeNumber).toBe(pkgBefore.episodeNumber);
    expect(sha256Hex(String(pkgAfter.content))).toBe(sha256Hex(String(pkgBefore.content)));
    expect(String(pkgAfter.price)).toBe(String(pkgBefore.price));
    expect(pkgAfter.saleMode).toBe("package");
    expect(pkgAfter.fileUrl).toBe(pkgBefore.fileUrl);
  });

  it("re-running the split is an idempotent no-op (all chapters kept, no duplicates)", async () => {
    const { novelId, packageId } = await createPackageWorld();
    await splitPackage(packageId);
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.counts).toEqual({ create: 0, keep: 5, conflict: 0 });
    const again = await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } });
    expect(again.createdEpisodeIds).toEqual([]);
    expect(again.keptEpisodeIds).toHaveLength(5);
    expect(again.mappingsInserted).toBe(0);
    expect(await chapterRows(novelId)).toHaveLength(5);
    const scan = await scanLegacyPackages({ novelId });
    expect(scan.find((s) => s.packageEpisodeId === packageId)?.status).toBe("already_split");
  });

  it("STALE_PLAN when the package content changes between preview and apply - nothing created", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    await testDb
      .update(episodesTable)
      .set({ content: packContent([1, 2, 3, 4, 5]).replace("บรรทัดสอง 3", "บรรทัดสอง แก้ไข") })
      .where(eq(episodesTable.id, packageId));
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await chapterRows(novelId)).toHaveLength(0);
  });

  it("STALE_PLAN when pricing/publish differ from the previewed plan", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "6" } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" }, publish: true })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await chapterRows(novelId)).toHaveLength(0);
  });

  it("concurrent applies of the same plan: exactly one creates, the other gets STALE_PLAN, no duplicates", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const input = { packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } };
    const outcomes = await Promise.allSettled([applyPackageSplit(input), applyPackageSplit(input)]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PackageSplitError);
    expect(rejected[0].reason.code).toBe("STALE_PLAN");
    expect(await chapterRows(novelId)).toHaveLength(5);
  });

  it("fail-closed: a gap in the package refuses the apply and creates nothing", async () => {
    const { novelId, packageId } = await createPackageWorld([1, 2, 4, 5], "1 - 5");
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.applicable).toBe(false);
    expect(preview.planHash).toBeNull();
    expect(preview.issues.map((i) => i.code)).toContain("MISSING_CHAPTER");
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: "0".repeat(64), pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "PLAN_NOT_APPLICABLE" });
    expect(await chapterRows(novelId)).toHaveLength(0);
    const scan = await scanLegacyPackages({ novelId });
    expect(scan[0].status).toBe("needs_attention");
  });

  it("existing chapter rows: identical content (even as '003') is kept; differing content is a conflict that blocks without overwriting", async () => {
    const { novelId, packageId, content } = await createPackageWorld();
    const preview0 = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview0.applicable).toBe(true);
    const chapter3 = content.slice(preview0.rows[2].sourceStart, preview0.rows[2].sourceEnd);
    // Same content AND same price as the requested plan -> keep (R3).
    const keptId = await createEpisode({ novelId, episodeNumber: "003", content: chapter3, saleMode: "chapter", price: "5.00" });
    const conflictId = await createEpisode({ novelId, episodeNumber: "4", content: "บทที่ 4 ต่างจากแพ็ก\n\nอื่น", saleMode: "chapter" });

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.rows.find((r) => r.chapterNumber === 3)).toMatchObject({ action: "keep", existingEpisodeId: keptId });
    expect(preview.rows.find((r) => r.chapterNumber === 4)).toMatchObject({ action: "conflict", existingEpisodeId: conflictId });
    expect(preview.applicable).toBe(false);
    expect(preview.issues.map((i) => i.code)).toContain("EXISTING_CHAPTER_CONFLICT");

    const [conflictRow] = await testDb.select().from(episodesTable).where(eq(episodesTable.id, conflictId));
    expect(conflictRow.content).toBe("บทที่ 4 ต่างจากแพ็ก\n\nอื่น"); // never overwritten

    // Resolve the conflict: delete the test-made conflicting row, re-preview, apply.
    await testDb.delete(episodesTable).where(eq(episodesTable.id, conflictId));
    const resolved = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const applied = await applyPackageSplit({ packageEpisodeId: packageId, planHash: resolved.planHash!, pricing: { chapterPrice: "5" } });
    expect(applied.keptEpisodeIds).toEqual([keptId]);
    expect(applied.createdEpisodeIds).toHaveLength(4);
    const numbers = (await chapterRows(novelId)).map((c) => Number(c.episodeNumber)).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]); // "003" kept, no "3" duplicate
  });

  it("overlapping packages are refused", async () => {
    const { novelId, packageId } = await createPackageWorld();
    await createEpisode({ novelId, episodeNumber: "4 - 8", content: packContent([4, 5, 6, 7, 8]), saleMode: "package" });
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.applicable).toBe(false);
    expect(preview.issues.map((i) => i.code)).toContain("OVERLAPPING_PACKAGE");
  });

  it("per-chapter overrides, free chapters and the price-sum warning", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const pricing = { chapterPrice: "2", overrides: { "1": "0", "5": "9.50" } };
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing, publish: true });
    expect(preview.rows.map((r) => [r.chapterNumber, r.price, r.isFree])).toEqual([
      [1, "0.00", true],
      [2, "2.00", false],
      [3, "2.00", false],
      [4, "2.00", false],
      [5, "9.50", false],
    ]);
    expect(preview.warnings.join(" ")).toContain("ต่ำกว่าราคาแพ็ก");
    await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing, publish: true });
    const chapters = await chapterRows(novelId);
    expect(chapters.every((c) => c.isPublished === true && c.publishedAt != null)).toBe(true);
    const bad = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "abc" } });
    expect(bad.issues.map((i) => i.code)).toContain("INVALID_PRICE");
  });

  it("produces no notification events, outbox rows or publication markers", async () => {
    const tables = ["notificationEvents", "notificationOutbox", "notificationPublicationMarkers"];
    const before = await Promise.all(tables.map(countRows));
    const { packageId } = await createPackageWorld();
    await splitPackage(packageId, "5", true); // even when publishing immediately
    const after = await Promise.all(tables.map(countRows));
    expect(after).toEqual(before);
  });
});

describe("package-owner entitlement and the pay guard", () => {
  it("a package owner reads the split chapters through the mapping, without them showing as purchased", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const owner = await createTestUser();
    const stranger = await createTestUser();
    await seedOrderOwnership(owner.id, novelId, packageId);

    const chapterId = result.createdEpisodeIds[1];
    expect(await canReadEpisode(owner.id, chapterId)).toBe(true);
    expect(await canReadEpisode(stranger.id, chapterId)).toBe(false);

    const listing = await caller({ id: owner.id, role: "user" }).novels.episodes({ novelId });
    const row = listing.find((e: any) => e.id === chapterId) as any;
    expect(row.coveredByOwnedPackage).toBe(true);
    expect(row.isPurchased).toBe(false);
    expect(row.canRead).toBe(true);
  });

  it("wallet purchase of a chapter the user owns via package is refused - no debit, no purchase row", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const owner = await createTestUser();
    await seedOrderOwnership(owner.id, novelId, packageId);
    await setWallet(owner.id, "100.00");

    const outcome = await purchaseEpisodeWithWallet(owner.id, result.createdEpisodeIds[0]);
    expect(outcome).toMatchObject({ success: false, error: "ALREADY_OWNED_VIA_PACKAGE" });
    expect(await walletBalance(owner.id)).toBe("100.00");
    const rows = await testDb
      .select()
      .from(episodePurchases)
      .where(and(eq(episodePurchases.userId, owner.id), eq(episodePurchases.episodeId, result.createdEpisodeIds[0])));
    expect(rows).toHaveLength(0);

    await expect(
      caller({ id: owner.id, role: "user" }).reader.purchaseEpisode({ episodeId: result.createdEpisodeIds[0] })
    ).rejects.toMatchObject({ message: "ALREADY_OWNED_VIA_PACKAGE" });
  });

  it("gift ownership and a live pending package order also block the chapter charge", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const gifted = await createTestUser();
    const pending = await createTestUser();
    await seedGift(gifted.id, novelId, packageId);
    await seedLivePendingOrder(pending.id, novelId, packageId);
    await setWallet(gifted.id, "50.00");
    await setWallet(pending.id, "50.00");

    expect(await purchaseEpisodeWithWallet(gifted.id, result.createdEpisodeIds[2])).toMatchObject({ error: "ALREADY_OWNED_VIA_PACKAGE" });
    expect(await purchaseEpisodeWithWallet(pending.id, result.createdEpisodeIds[2])).toMatchObject({ error: "ALREADY_OWNED_VIA_PACKAGE" });
    expect(await walletBalance(gifted.id)).toBe("50.00");
    expect(await walletBalance(pending.id)).toBe("50.00");
    // A pending order grants nothing to READ.
    expect(await canReadEpisode(pending.id, result.createdEpisodeIds[2])).toBe(false);
  });

  it("range coverage blocks the charge even before any mapping row exists (pay-side only)", async () => {
    const novelId = await createNovel();
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 5", content: null, saleMode: "package" });
    const chapterId = await createEpisode({ novelId, episodeNumber: "3", content: "บทที่ 3\n\nก", saleMode: "chapter", price: "5.00" });
    const owner = await createTestUser();
    await seedOrderOwnership(owner.id, novelId, packageId);
    await setWallet(owner.id, "20.00");
    expect(await purchaseEpisodeWithWallet(owner.id, chapterId)).toMatchObject({ error: "ALREADY_OWNED_VIA_PACKAGE" });
    expect(await walletBalance(owner.id)).toBe("20.00");
    expect(await canReadEpisode(owner.id, chapterId)).toBe(false); // read needs the persisted mapping
  });

  it("a non-owner buys a split chapter normally", async () => {
    const { packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const buyer = await createTestUser();
    await setWallet(buyer.id, "20.00");
    const outcome = await purchaseEpisodeWithWallet(buyer.id, result.createdEpisodeIds[0]);
    expect(outcome.success).toBe(true);
    expect(await walletBalance(buyer.id)).toBe("15.00");
    expect(await canReadEpisode(buyer.id, result.createdEpisodeIds[0])).toBe(true);
  });

  it("walletCheckout and checkout.create refuse a covered chapter inside the cart - no order, no debit", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const owner = await createTestUser();
    await seedOrderOwnership(owner.id, novelId, packageId);
    await setWallet(owner.id, "100.00");
    // cart.add refuses chapters by design; plant a legacy cart item directly.
    const cart = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart!.id, result.createdEpisodeIds[0], novelId, "5.00");
    const ordersBefore = await testDb.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.userId, owner.id));

    const userCaller = caller({ id: owner.id, role: "user" });
    await expect(userCaller.checkout.walletCheckout({})).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(userCaller.checkout.create({})).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(userCaller.cart.add({ episodeId: result.createdEpisodeIds[1] })).rejects.toBeTruthy();

    expect(await walletBalance(owner.id)).toBe("100.00");
    const ordersAfter = await testDb.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.userId, owner.id));
    expect(ordersAfter).toHaveLength(ordersBefore.length);
  });

  it("P3 upgrade credit counts a split chapter bought with real wallet money", async () => {
    process.env.PACKAGE_UPGRADE_ENABLED = "true";
    const { packageId } = await createPackageWorld();
    const result = await splitPackage(packageId, "5", true);
    const buyer = await createTestUser();
    await setWallet(buyer.id, "20.00");
    expect((await purchaseEpisodeWithWallet(buyer.id, result.createdEpisodeIds[1])).success).toBe(true);

    const quote = await quotePackageUpgrade(buyer.id, packageId);
    expect(quote.creditAmount).toBe("5.00");
    expect(quote.payableAmount).toBe("25.00");
  });
});

describe("ZIP import: package + chapters mode", () => {
  function buildZip(rows: string[][], files: Record<string, string>): string {
    const zip = new AdmZip();
    zip.addFile("manifest.csv", Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf-8"));
    for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(body, "utf-8"));
    return zip.toBuffer().toString("base64");
  }
  const header = ["episodeNumber", "episodeTitle", "price", "isFree", "isPublished", "saleMode", "contentFile", "splitChapters", "chapterPrice", "publishChapters"];

  it("imports a package, splits it, and applies chapter-row price overrides; dry run writes nothing", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const pack = packContent([1, 2, 3]);
    const chapter2 = pack.slice(pack.indexOf("บทที่ 2"), pack.indexOf("บทที่ 3"));
    const zipBase64 = buildZip(
      [
        header,
        ["1 - 3", "Pack", "30", "false", "true", "package", "contents/p.txt", "true", "5", "false"],
        ["2", "Chapter 2", "9", "false", "true", "chapter", "contents/c2.txt", "", "", ""],
      ],
      { "contents/p.txt": pack, "contents/c2.txt": chapter2 }
    );
    const adminCaller = caller({ id: admin.id, role: "admin" });

    const dry: any = await adminCaller.admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: true, packageWithChapters: true });
    expect(dry.chapterSplit.errors).toEqual([]);
    expect(dry.chapterSplit.previews[0].preview.counts.create).toBe(3);
    expect(await novelEpisodes(novelId)).toHaveLength(0);

    const real: any = await adminCaller.admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: false, packageWithChapters: true });
    expect(real.chapterSplitResults[0].applied).toBe(true);
    const chapters = (await chapterRows(novelId)).sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
    expect(chapters.map((c) => [c.episodeNumber, String(c.price), c.isPublished])).toEqual([
      ["1", "5.00", false],
      ["2", "9.00", false],
      ["3", "5.00", false],
    ]);
  });

  it("a chapter row whose content differs from the package blocks the WHOLE import (nothing written)", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const zipBase64 = buildZip(
      [
        header,
        ["1 - 3", "Pack", "30", "false", "true", "package", "contents/p.txt", "true", "5", "false"],
        ["2", "Chapter 2", "9", "false", "true", "chapter", "contents/c2.txt", "", "", ""],
      ],
      { "contents/p.txt": packContent([1, 2, 3]), "contents/c2.txt": "บทที่ 2\n\nเนื้อหาไม่ตรง" }
    );
    await expect(
      caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: false, packageWithChapters: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await novelEpisodes(novelId)).toHaveLength(0);
  });

  it("legacy mode (flag off) still rejects chapter rows exactly as before", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const zipBase64 = buildZip(
      [header, ["2", "Chapter 2", "9", "false", "true", "chapter", "contents/c2.txt", "", "", ""]],
      { "contents/c2.txt": "บทที่ 2\n\nก" }
    );
    const dry: any = await caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: true });
    expect(dry.chapterSplit).toBeUndefined();
    expect(dry.errorCount).toBe(1);
    expect(JSON.stringify(dry.rows)).toContain("saleMode = package");
  });
});

describe("R2: ZIP package + chapters import is ALL-OR-NOTHING (failure injection)", () => {
  function buildZip(rows: string[][], files: Record<string, string>): string {
    const zip = new AdmZip();
    zip.addFile("manifest.csv", Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf-8"));
    for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(body, "utf-8"));
    return zip.toBuffer().toString("base64");
  }
  const header = ["episodeNumber", "episodeTitle", "price", "isFree", "isPublished", "saleMode", "contentFile", "splitChapters", "chapterPrice", "publishChapters"];
  const twoPackZip = () =>
    buildZip(
      [
        header,
        ["1 - 3", "Pack A", "30", "false", "true", "package", "a.txt", "true", "5", "false"],
        ["4 - 6", "Pack B", "30", "false", "true", "package", "b.txt", "true", "5", "false"],
      ],
      { "a.txt": packContent([1, 2, 3]), "b.txt": packContent([4, 5, 6]) }
    );

  async function mappingCount(novelId: number) {
    return (await testDb.select().from(packageChapterMappings).where(eq(packageChapterMappings.novelId, novelId))).length;
  }

  it("happy path: both packages and all six chapters land in one transaction", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const res: any = await caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({
      novelId, zipBase64: twoPackZip(), dryRun: false, packageWithChapters: true,
    });
    expect(res.chapterSplitResults.map((r: any) => r.applied)).toEqual([true, true]);
    expect((await novelEpisodes(novelId)).filter((e) => e.saleMode === "package")).toHaveLength(2);
    expect(await chapterRows(novelId)).toHaveLength(6);
    expect(await mappingCount(novelId)).toBe(6);
  });

  it("INJECTED failure AFTER the packages were written (2nd package's split) rolls back EVERYTHING", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const real = splitServiceModule.applyPackageSplitInTx;
    let calls = 0;
    const spy = vi.spyOn(splitServiceModule, "applyPackageSplitInTx").mockImplementation(async (tx: any, input: any) => {
      calls += 1;
      if (calls === 2) throw new Error("INJECTED_AFTER_PACKAGE_WRITE");
      return real(tx, input);
    });
    try {
      await expect(
        caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({
          novelId, zipBase64: twoPackZip(), dryRun: false, packageWithChapters: true,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2); // pack A was fully split before the failure
    expect(await novelEpisodes(novelId)).toHaveLength(0); // both packages + A's 3 chapters rolled back
    expect(await mappingCount(novelId)).toBe(0);
  });

  it("INJECTED failure DURING chapter creation (3rd insert of pack A) rolls back EVERYTHING", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const real = splitServiceModule.applyPackageSplitInTx;
    let chapterInserts = 0;
    const spy = vi.spyOn(splitServiceModule, "applyPackageSplitInTx").mockImplementation(async (tx: any, input: any) => {
      const failingTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === "insert") {
            return (table: unknown) => {
              const builder = target.insert(table);
              if (table !== episodesTable) return builder;
              return new Proxy(builder, {
                get(b, p) {
                  if (p === "values") {
                    return (values: any) => {
                      chapterInserts += 1;
                      if (chapterInserts === 3) throw new Error("INJECTED_DURING_CHAPTER_CREATION");
                      return b.values(values);
                    };
                  }
                  const v = b[p];
                  return typeof v === "function" ? v.bind(b) : v;
                },
              });
            };
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return real(failingTx, input);
    });
    try {
      await expect(
        caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({
          novelId, zipBase64: twoPackZip(), dryRun: false, packageWithChapters: true,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      spy.mockRestore();
    }
    expect(chapterInserts).toBe(3); // chapters 1 and 2 were inserted before the failure
    expect(await novelEpisodes(novelId)).toHaveLength(0);
    expect(await mappingCount(novelId)).toBe(0);
  });

  it("a DB conflict on a later row (ambiguous existing match) rolls back the earlier package and its chapters", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    await createEpisode({ novelId, episodeNumber: "10 - 12", content: null, saleMode: "package" });
    await createEpisode({ novelId, episodeNumber: "010 - 12", content: null, saleMode: "package" });
    const before = (await novelEpisodes(novelId)).length;
    const zipBase64 = buildZip(
      [
        header,
        ["1 - 3", "Pack A", "30", "false", "true", "package", "a.txt", "true", "5", "false"],
        ["10 - 12", "Ambiguous", "30", "false", "true", "package", "c.txt", "false", "", ""],
      ],
      { "a.txt": packContent([1, 2, 3]), "c.txt": packContent([10, 11, 12]) }
    );
    await expect(
      caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: false, packageWithChapters: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await novelEpisodes(novelId)).toHaveLength(before); // nothing added
    expect(await mappingCount(novelId)).toBe(0);
  });

  it("a split that becomes invalid against the DB (conflicting existing chapter) aborts the whole ZIP", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    await createEpisode({ novelId, episodeNumber: "5", content: "บทที่ 5 คนละเรื่อง\n\nx", saleMode: "chapter" });
    const before = (await novelEpisodes(novelId)).length;
    await expect(
      caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({
        novelId, zipBase64: twoPackZip(), dryRun: false, packageWithChapters: true,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await novelEpisodes(novelId)).toHaveLength(before); // pack A (valid) was NOT kept either
    expect(await mappingCount(novelId)).toBe(0);
  });

  it("any parse error blocks the whole ZIP before writing (even its valid rows)", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const zipBase64 = buildZip(
      [
        header,
        ["1 - 3", "Pack A", "30", "false", "true", "package", "a.txt", "true", "5", "false"],
        ["4 - 6", "Pack B", "30", "false", "true", "package", "missing.txt", "true", "5", "false"],
      ],
      { "a.txt": packContent([1, 2, 3]) }
    );
    await expect(
      caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: false, packageWithChapters: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await novelEpisodes(novelId)).toHaveLength(0);
  });

  it("legacy mode (flag off) keeps its documented per-row behavior: valid rows import despite a bad row", async () => {
    const novelId = await createNovel();
    const admin = await createTestUser({ role: "admin" });
    const zipBase64 = buildZip(
      [
        header,
        ["1 - 3", "Pack A", "30", "false", "true", "package", "a.txt", "", "", ""],
        ["4 - 6", "Pack B", "30", "false", "true", "package", "missing.txt", "", "", ""],
      ],
      { "a.txt": packContent([1, 2, 3]) }
    );
    const res: any = await caller({ id: admin.id, role: "admin" }).admin.episodes.importPackageZip({ novelId, zipBase64, dryRun: false });
    expect(res.createdCount).toBe(1);
    expect(res.errorCount).toBe(1);
    expect(await chapterRows(novelId)).toHaveLength(0); // legacy mode never splits
  });
});

describe("R3: STALE_PLAN binding and existing-chapter price integrity", () => {
  it("keep shows the STORED price; a stored-price mismatch is a conflict that blocks and never reprices", async () => {
    const { novelId, packageId, content } = await createPackageWorld();
    const base = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const ch3 = content.slice(base.rows[2].sourceStart, base.rows[2].sourceEnd);
    const existingId = await createEpisode({ novelId, episodeNumber: "3", content: ch3, saleMode: "chapter", price: "9.00" });

    const mismatch = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const row3 = mismatch.rows.find((r) => r.chapterNumber === 3)!;
    expect(row3.action).toBe("conflict");
    expect(row3.existingPrice).toBe("9.00");
    expect(mismatch.issues.map((i) => i.code)).toContain("EXISTING_CHAPTER_PRICE_CONFLICT");
    expect(mismatch.applicable).toBe(false);
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: "0".repeat(64), pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "PLAN_NOT_APPLICABLE" });
    const [stored] = await testDb.select().from(episodesTable).where(eq(episodesTable.id, existingId));
    expect(String(stored.price)).toBe("9.00"); // never repriced
    expect(await chapterRows(novelId)).toHaveLength(1);

    // An override matching the stored price turns it into keep, displayed at the STORED price.
    const matched = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5", overrides: { "3": "9" } } });
    const kept = matched.rows.find((r) => r.chapterNumber === 3)!;
    expect(kept).toMatchObject({ action: "keep", price: "9.00", existingPrice: "9.00" });
    expect(matched.applicable).toBe(true);
  });

  it("planHash binds the package price: changing it after preview -> STALE_PLAN, nothing written", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    await testDb.update(episodesTable).set({ price: "31.00" }).where(eq(episodesTable.id, packageId));
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await chapterRows(novelId)).toHaveLength(0);
  });

  it("planHash binds pricing overrides: a different override on apply -> STALE_PLAN", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const pricing = { chapterPrice: "5", overrides: { "2": "7" } };
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing });
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5", overrides: { "2": "8" } } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await chapterRows(novelId)).toHaveLength(0);
    // The exact previewed pricing still applies.
    const ok = await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing });
    expect(ok.createdEpisodeIds).toHaveLength(5);
  });

  it("planHash binds the state of related existing chapters: publishing a kept chapter after preview -> STALE_PLAN", async () => {
    const { novelId, packageId, content } = await createPackageWorld();
    const base = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const ch1 = content.slice(base.rows[0].sourceStart, base.rows[0].sourceEnd);
    const keptId = await createEpisode({ novelId, episodeNumber: "1", content: ch1, saleMode: "chapter", price: "5.00", isPublished: false });
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.rows[0]).toMatchObject({ action: "keep", existingEpisodeId: keptId, existingIsPublished: false });
    await testDb.update(episodesTable).set({ isPublished: true }).where(eq(episodesTable.id, keptId));
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await chapterRows(novelId)).toHaveLength(1);
  });

  it("preview and apply agree: the applied result equals the previewed rows", async () => {
    const { novelId, packageId } = await createPackageWorld();
    const pricing = { chapterPrice: "3", overrides: { "1": "0" } };
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing, publish: true });
    await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing, publish: true });
    const byNumber = new Map((await chapterRows(novelId)).map((c) => [Number(c.episodeNumber), c]));
    for (const row of preview.rows) {
      const stored = byNumber.get(row.chapterNumber)!;
      expect(String(stored.price)).toBe(row.price);
      expect(stored.isFree).toBe(row.isFree);
      expect(stored.isPublished).toBe(true);
      expect(sha256Hex(String(stored.content))).toBe(row.contentSha256);
    }
  });
});

describe("R4/R1R1: stored chapter content is the EXACT source slice", () => {
  it("stores the exact slice (no trimming) and re-concatenates to the source with the preamble", async () => {
    const novelId = await createNovel();
    const content = [
      "  บทที่ 1 นำเรื่อง  \n",
      "\n",
      "\tย่อหน้าแรก มีแท็บนำ\n",
      "บรรทัดมีช่องว่างท้าย   \n",
      "\n\n\n",
      "ย่อหน้าหลังเว้นหลายบรรทัด\u00a0NBSP กลางประโยค\n",
      "\n",
      "ตอนที่ 2\r\n",
      "\r\n",
      "CRLF body  \r\n",
      "\r\n\r\n",
      "#3\n",
      "\n",
      "สุดท้าย\n",
      "   \n",
    ].join("");
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 3", content, saleMode: "package" });
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content });
    expect(plan.ok).toBe(true);
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } });

    const stored = (await chapterRows(novelId)).sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
    // DB round-trip: preamble + stored rows == the original package content.
    const preamble = content.slice(0, plan.preamble.sourceEnd);
    expect(preamble + stored.map((c) => String(c.content)).join("")).toBe(content);
    for (const [i, row] of stored.entries()) {
      expect(String(row.content)).toBe(plan.chapters[i].content); // exact slice, DB-identical
      expect(sha256Hex(String(row.content))).toBe(preview.rows[i].contentSha256); // preview hash == stored hash
      // Re-split of the STORED chapter yields exactly itself.
      const again = splitPackageContent({ episodeNumber: `${i + 1} - ${i + 1}`, content: String(row.content) });
      expect(again.ok).toBe(true);
      expect(again.chapters[0].content).toBe(String(row.content));
    }
    // Interior formatting survives verbatim.
    expect(String(stored[0].content)).toBe("  บทที่ 1 นำเรื่อง  \n\n\tย่อหน้าแรก มีแท็บนำ\nบรรทัดมีช่องว่างท้าย   \n\n\n\nย่อหน้าหลังเว้นหลายบรรทัด\u00a0NBSP กลางประโยค\n\n");
    expect(String(stored[1].content)).toBe("ตอนที่ 2\r\n\r\nCRLF body  \r\n\r\n\r\n");
    expect(String(stored[2].content)).toBe("#3\n\nสุดท้าย\n   \n");
  });

  it("BOM, NBSP-only lines and CRLF packs store byte-exact slices", async () => {
    const novelId = await createNovel();
    const content = "\ufeffบทที่ 1\r\n\r\n\u00a0\r\nตัวอักษรไทย ก้ำกึ่ง ๆ 🚀\r\n\r\nบทที่ 2\r\n\r\nจบ 👩‍👩‍👧\r\n\r\n";
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 2", content, saleMode: "package" });
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing: { chapterPrice: "5" } });
    const stored = (await chapterRows(novelId)).sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
    expect(String(stored[0].content)).toBe("\ufeffบทที่ 1\r\n\r\n\u00a0\r\nตัวอักษรไทย ก้ำกึ่ง ๆ 🚀\r\n\r\n");
    expect(String(stored[1].content)).toBe("บทที่ 2\r\n\r\nจบ 👩‍👩‍👧\r\n\r\n");
    expect(content.slice(0, 0) + stored.map((c) => String(c.content)).join("")).toBe(content);
  });

  it("R1R1-keep: an existing chapter seeded with the EXACT slice is kept; a differently-trimmed copy is a conflict and is never overwritten", async () => {
    const { novelId, packageId, content } = await createPackageWorld();
    const exact = storedSlice(content, "1 - 5", 3);
    const trimmed = exact.replace(/\s+$/, ""); // old-world artifact: missing trailing blank lines
    const exactId = await createEpisode({ novelId, episodeNumber: "2", content: storedSlice(content, "1 - 5", 2), saleMode: "chapter", price: "5.00" });
    const trimmedId = await createEpisode({ novelId, episodeNumber: "3", content: trimmed, saleMode: "chapter", price: "5.00" });

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.rows.find((r) => r.chapterNumber === 2)).toMatchObject({ action: "keep", existingEpisodeId: exactId });
    expect(preview.rows.find((r) => r.chapterNumber === 3)).toMatchObject({ action: "conflict", existingEpisodeId: trimmedId });
    expect(preview.issues.map((i) => i.code)).toContain("EXISTING_CHAPTER_CONFLICT");
    expect(preview.applicable).toBe(false);
    await expect(
      applyPackageSplit({ packageEpisodeId: packageId, planHash: "0".repeat(64), pricing: { chapterPrice: "5" } })
    ).rejects.toMatchObject({ code: "PLAN_NOT_APPLICABLE" });
    const [storedRow] = await testDb.select().from(episodesTable).where(eq(episodesTable.id, trimmedId));
    expect(String(storedRow.content)).toBe(trimmed); // untouched, buyers' rows never rewritten
  });
});

describe("R5: P3 upgrade credit and the upgrade entry point use PAID purchases only", () => {
  it("free, gifted and package-covered chapters are not paid evidence; only the wallet-bought chapter counts", async () => {
    process.env.PACKAGE_UPGRADE_ENABLED = "true";
    const { novelId, packageId } = await createPackageWorld();
    const pricing = { chapterPrice: "5", overrides: { "1": "0" } };
    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing, publish: true });
    const result = await applyPackageSplit({ packageEpisodeId: packageId, planHash: preview.planHash!, pricing, publish: true });
    const [ch1, ch2, ch3] = result.createdEpisodeIds; // ch1 free
    const reader = await createTestUser();
    await setWallet(reader.id, "50.00");
    expect((await purchaseEpisodeWithWallet(reader.id, ch2)).success).toBe(true); // paid
    await seedGift(reader.id, novelId, ch3); // gift: readable, not paid

    const listing = await caller({ id: reader.id, role: "user" }).novels.episodes({ novelId });
    const flag = (id: number) => (listing.find((e: any) => e.id === id) as any).hasPaidPurchase;
    expect(flag(ch1)).toBe(false); // free
    expect(flag(ch2)).toBe(true); // wallet purchase
    expect(flag(ch3)).toBe(false); // gift
    expect(flag(packageId)).toBe(false);

    // Server credit: only the 5.00 actually paid for ch2.
    const quote = await quotePackageUpgrade(reader.id, packageId);
    expect(quote.creditAmount).toBe("5.00");

    // A package owner has nothing to upgrade and covered chapters are not paid evidence.
    const owner = await createTestUser();
    await seedOrderOwnership(owner.id, novelId, packageId);
    const ownerListing = await caller({ id: owner.id, role: "user" }).novels.episodes({ novelId });
    expect(ownerListing.filter((e: any) => e.hasPaidPurchase === true && e.saleMode === "chapter")).toEqual([]);
    // All five split chapters are covered by the owned package (the free one
    // too - coverage is a fact; the UI only badges paid rows).
    expect(ownerListing.filter((e: any) => e.coveredByOwnedPackage === true)).toHaveLength(5);
    await expect(quotePackageUpgrade(owner.id, packageId)).rejects.toMatchObject({ code: "ALREADY_OWNED_PACKAGE" });
  });
});

describe("static safety", () => {
  it("split/backfill modules never import the notification producers and contain no destructive SQL", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["packageChapterSplit.service.ts", "packageChapterSplitImport.ts", "packageChapterSplit.domain.ts", "packageOwnershipService.ts"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(source).not.toMatch(/notifications\//);
      // Database deletes only (db/tx/handle) - Set.delete on in-memory sets is fine.
      expect(source).not.toMatch(/\b(?:db|tx|handle)\s*\.\s*delete\(|DELETE FROM|DROP TABLE|TRUNCATE/i);
      expect(source).not.toMatch(/update\(episodes\)/);
    }
  });

});
