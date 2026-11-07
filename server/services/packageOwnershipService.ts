import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  adminGiftEntitlements,
  episodePurchases,
  episodes,
  orderItems,
  orders,
  packageChapterMappings,
  purchases,
} from "../../drizzle/schema";
import { normalizeEpisodeRange, resolveSaleMode } from "./readerService";

/**
 * Package-ownership coverage for single chapters.
 *
 * Once a package is split into chapter rows (or chapters are sold next to a
 * package), the same text is reachable through two episode IDs. Entitlement
 * rows stay per-episodeId; this module answers the two questions that keep
 * that safe:
 *
 *  - READ: does the user own a package whose PERSISTED mapping
 *    (packageChapterMappings) contains this chapter? Mapping-only - a chapter
 *    is never unlocked from a guessed range.
 *  - PAY: must a purchase of this chapter be refused because the user already
 *    owns (or has a live, still-payable order for) a package that covers it?
 *    Conservative: persisted mapping OR the package's own episode-number
 *    range, so no charge can slip through before a mapping row exists.
 *
 * Inside a transaction every entitlement read is a locking read (FOR UPDATE):
 * a plain SELECT could see a REPEATABLE READ snapshot taken before a
 * concurrent purchase committed.
 */

type DbHandle = any;

export class PackageOwnershipError extends Error {
  readonly code = "ALREADY_OWNED_VIA_PACKAGE" as const;
  readonly chapterEpisodeId: number;
  readonly packageEpisodeId: number;

  constructor(chapterEpisodeId: number, packageEpisodeId: number) {
    super("ALREADY_OWNED_VIA_PACKAGE");
    this.name = "PackageOwnershipError";
    this.chapterEpisodeId = chapterEpisodeId;
    this.packageEpisodeId = packageEpisodeId;
  }
}

export const ALREADY_OWNED_VIA_PACKAGE_MESSAGE = "บทนี้อยู่ในแพ็กที่คุณเป็นเจ้าของแล้ว อ่านได้ทันทีโดยไม่ต้องซื้อซ้ำ";

function isMissingTableError(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    if (current?.code === "ER_NO_SUCH_TABLE" || current?.errno === 1146) return true;
    current = current?.cause;
  }
  return false;
}

function singleChapterNumber(episodeNumber: unknown): number | null {
  const normalized = normalizeEpisodeRange(episodeNumber);
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function packageBounds(episodeNumber: unknown): { start: number; end: number } | null {
  const match = normalizeEpisodeRange(episodeNumber).match(/^(\d+) - (\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) return null;
  return { start, end };
}

async function requireHandle(tx?: DbHandle): Promise<DbHandle> {
  if (tx) return tx;
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

function maybeLock<T>(query: T, lock: boolean): T {
  return lock ? ((query as any).for("update") as T) : query;
}

/** Packages whose persisted mapping contains each chapter (chapterId -> packageIds). */
async function mappedPackagesByChapter(handle: DbHandle, chapterIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (chapterIds.length === 0) return out;
  try {
    const rows: Array<{ chapterEpisodeId: number; packageEpisodeId: number }> = await handle
      .select({
        chapterEpisodeId: packageChapterMappings.chapterEpisodeId,
        packageEpisodeId: packageChapterMappings.packageEpisodeId,
      })
      .from(packageChapterMappings)
      .where(inArray(packageChapterMappings.chapterEpisodeId, chapterIds));
    for (const row of rows) {
      const bucket = out.get(row.chapterEpisodeId) ?? [];
      bucket.push(row.packageEpisodeId);
      out.set(row.chapterEpisodeId, bucket);
    }
  } catch (error) {
    // 0068 not deployed yet: no mapping can exist - fall back to range only.
    if (!isMissingTableError(error)) throw error;
  }
  return out;
}

/**
 * Episode IDs (among `candidateIds`) the user holds an entitlement for:
 * wallet purchase, approved-order purchase or admin gift. With
 * `includeLiveOrders`, a package inside the user's still-pending order counts
 * too (it can still be approved, so charging again would be a double charge).
 */
async function entitledEpisodeIds(
  handle: DbHandle,
  userId: number,
  candidateIds: number[],
  options: { lock: boolean; includeLiveOrders: boolean }
): Promise<Set<number>> {
  const owned = new Set<number>();
  if (candidateIds.length === 0) return owned;

  const walletRows: Array<{ episodeId: number }> = await maybeLock(
    handle
      .select({ episodeId: episodePurchases.episodeId })
      .from(episodePurchases)
      .where(and(eq(episodePurchases.userId, userId), inArray(episodePurchases.episodeId, candidateIds))),
    options.lock
  );
  walletRows.forEach((row) => owned.add(row.episodeId));

  const orderRows: Array<{ episodeId: number }> = await maybeLock(
    handle
      .select({ episodeId: purchases.episodeId })
      .from(purchases)
      .where(and(eq(purchases.userId, userId), inArray(purchases.episodeId, candidateIds))),
    options.lock
  );
  orderRows.forEach((row) => owned.add(row.episodeId));

  const giftRows: Array<{ episodeId: number }> = await maybeLock(
    handle
      .select({ episodeId: adminGiftEntitlements.episodeId })
      .from(adminGiftEntitlements)
      .where(and(eq(adminGiftEntitlements.userId, userId), inArray(adminGiftEntitlements.episodeId, candidateIds))),
    options.lock
  );
  giftRows.forEach((row) => owned.add(row.episodeId));

  if (options.includeLiveOrders) {
    const liveRows: Array<{ episodeId: number }> = await maybeLock(
      handle
        .select({ episodeId: orderItems.episodeId })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(eq(orders.userId, userId), eq(orders.status, "pending"), inArray(orderItems.episodeId, candidateIds))
        ),
      options.lock
    );
    liveRows.forEach((row) => owned.add(row.episodeId));
  }
  return owned;
}

/**
 * PAY guard. Throws PackageOwnershipError if any of `episodeIds` is a single
 * chapter covered by a package the user owns (or has a live order for).
 * Pass the transaction to run the check as locking reads inside it.
 */
export async function assertNoChapterCoveredByOwnedPackage(
  userId: number,
  episodeIds: number[],
  tx?: DbHandle
): Promise<void> {
  const uniqueIds = Array.from(new Set(episodeIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return;
  const handle = await requireHandle(tx);
  const lock = Boolean(tx);

  const rows: Array<{ id: number; novelId: number; episodeNumber: string; saleMode: string | null; fileUrl: string | null }> =
    await handle
      .select({
        id: episodes.id,
        novelId: episodes.novelId,
        episodeNumber: episodes.episodeNumber,
        saleMode: episodes.saleMode,
        fileUrl: episodes.fileUrl,
      })
      .from(episodes)
      .where(inArray(episodes.id, uniqueIds));
  const chapters = rows.filter((row) => resolveSaleMode(row) === "chapter");
  if (chapters.length === 0) return;

  const mapped = await mappedPackagesByChapter(
    handle,
    chapters.map((c) => c.id)
  );

  // Range coverage (conservative, pay-side only): packages of the same novels.
  const novelIds = Array.from(new Set(chapters.map((c) => c.novelId)));
  const novelPackages: Array<{ id: number; novelId: number; episodeNumber: string; saleMode: string | null; fileUrl: string | null }> =
    await handle
      .select({
        id: episodes.id,
        novelId: episodes.novelId,
        episodeNumber: episodes.episodeNumber,
        saleMode: episodes.saleMode,
        fileUrl: episodes.fileUrl,
      })
      .from(episodes)
      .where(inArray(episodes.novelId, novelIds));
  const packages = novelPackages
    .filter((row) => resolveSaleMode(row) === "package")
    .map((row) => ({ id: row.id, novelId: row.novelId, bounds: packageBounds(row.episodeNumber) }));

  const coveringByChapter = new Map<number, Set<number>>();
  for (const chapter of chapters) {
    const covering = new Set<number>(mapped.get(chapter.id) ?? []);
    const number = singleChapterNumber(chapter.episodeNumber);
    if (number !== null) {
      for (const pkg of packages) {
        if (pkg.novelId !== chapter.novelId || !pkg.bounds) continue;
        if (number >= pkg.bounds.start && number <= pkg.bounds.end) covering.add(pkg.id);
      }
    }
    covering.delete(chapter.id);
    if (covering.size > 0) coveringByChapter.set(chapter.id, covering);
  }
  if (coveringByChapter.size === 0) return;

  const allPackageIds = Array.from(new Set(Array.from(coveringByChapter.values()).flatMap((set) => Array.from(set))));
  const owned = await entitledEpisodeIds(handle, userId, allPackageIds, { lock, includeLiveOrders: true });
  for (const [chapterId, covering] of Array.from(coveringByChapter.entries())) {
    for (const packageId of Array.from(covering)) {
      if (owned.has(packageId)) throw new PackageOwnershipError(chapterId, packageId);
    }
  }
}

/**
 * READ coverage: does the user own a package whose persisted mapping contains
 * this chapter? Mapping-only (never a guessed range), owned entitlements only
 * (a pending order grants nothing to read).
 */
export async function isChapterCoveredByOwnedPackage(userId: number, chapterEpisodeId: number): Promise<boolean> {
  const handle = await requireHandle();
  const mapped = await mappedPackagesByChapter(handle, [chapterEpisodeId]);
  const packageIds = (mapped.get(chapterEpisodeId) ?? []).filter((id) => id !== chapterEpisodeId);
  if (packageIds.length === 0) return false;
  const owned = await entitledEpisodeIds(handle, userId, packageIds, { lock: false, includeLiveOrders: false });
  return packageIds.some((id) => owned.has(id));
}

/**
 * Batch READ coverage for a novel listing: chapter IDs unlocked through an
 * owned package's persisted mapping.
 */
export async function getChapterIdsCoveredByOwnedPackages(userId: number, novelId: number): Promise<Set<number>> {
  const handle = await requireHandle();
  const covered = new Set<number>();
  let rows: Array<{ chapterEpisodeId: number; packageEpisodeId: number }> = [];
  try {
    rows = await handle
      .select({
        chapterEpisodeId: packageChapterMappings.chapterEpisodeId,
        packageEpisodeId: packageChapterMappings.packageEpisodeId,
      })
      .from(packageChapterMappings)
      .where(eq(packageChapterMappings.novelId, novelId));
  } catch (error) {
    if (isMissingTableError(error)) return covered;
    throw error;
  }
  if (rows.length === 0) return covered;
  const packageIds = Array.from(new Set(rows.map((row) => row.packageEpisodeId)));
  const owned = await entitledEpisodeIds(handle, userId, packageIds, { lock: false, includeLiveOrders: false });
  for (const row of rows) {
    if (owned.has(row.packageEpisodeId) && row.chapterEpisodeId !== row.packageEpisodeId) {
      covered.add(row.chapterEpisodeId);
    }
  }
  return covered;
}

/**
 * Episode IDs (among `episodeIds`) the user actually PAID for: a wallet
 * chapter purchase or an approved-order purchase. Admin gifts, free
 * episodes and package coverage are deliberately NOT payment evidence - this
 * drives the P3 upgrade entry point (the credit amount itself is always
 * computed server-side by the upgrade quote).
 */
export async function getPaidEpisodeIds(userId: number, episodeIds: number[]): Promise<Set<number>> {
  const paid = new Set<number>();
  const ids = Array.from(new Set(episodeIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (ids.length === 0) return paid;
  const handle = await requireHandle();
  const walletRows: Array<{ episodeId: number }> = await handle
    .select({ episodeId: episodePurchases.episodeId })
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), inArray(episodePurchases.episodeId, ids)));
  walletRows.forEach((row) => paid.add(row.episodeId));
  const orderRows: Array<{ episodeId: number }> = await handle
    .select({ episodeId: purchases.episodeId })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), inArray(purchases.episodeId, ids)));
  orderRows.forEach((row) => paid.add(row.episodeId));
  return paid;
}
