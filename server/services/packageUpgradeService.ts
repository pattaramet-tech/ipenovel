/**
 * P3-R1: Chapter-to-Package Upgrade service.
 *
 * "Own chapters individually -> upgrade to the package, paying only the
 * difference". Architecture (see the P3 discovery report):
 *
 *  - Mapping: chapter->package containment is DERIVED once from normalized
 *    episode-number ranges and then PERSISTED in packageChapterMappings.
 *    The persisted rows are the financial evidence - quotes and execution
 *    only ever read these rows, never a live re-derivation.
 *  - Credit: only provably-paid money counts.
 *      wallet_purchase - episodePurchases.pricePaid (wallet debit at
 *                        purchase time, walletTransactionId linked), voided
 *                        by a later refund transaction if one exists;
 *      approved_order  - orderItems.finalPrice on an order whose status AND
 *                        paymentStatus are both 'approved'.
 *    Free chapters, gift entitlements (never represent paid revenue) and
 *    refunded purchases contribute nothing. credit = min(sum, packagePrice)
 *    and payable = max(0, packagePrice - credit).
 *  - Checkout math: the payable price is passed to createOrderFromCart as
 *    the item price, so Cart, Wallet, QR/Slip and finalization all run the
 *    SAME server-side pricing (quoteCartPricing) as ordinary checkout.
 *  - Atomicity/idempotency: execute() claims the quote with a conditional
 *    status UPDATE inside the payment transaction (0 affected rows ->
 *    someone else won), re-validates ownership/mapping/credit against the
 *    quote snapshot (STALE_QUOTE on drift), and replays idempotently for a
 *    non-quoted receipt. Payable = 0 goes through the same wallet-order
 *    transaction minus the debit.
 *  - Episode rows and the three legacy entitlement tables are never
 *    modified; existing entitlements, order history and customer data are
 *    untouched by construction.
 */

import { randomUUID } from "crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  assertAccountMergeClassifiedMutationAllowed,
  debitWalletBalance,
  getDb,
  getPaymentByOrderId,
  lockCartForCheckout,
  updateOrder,
} from "../db";
import {
  adminGiftEntitlements,
  carts,
  cartItems,
  episodePurchases,
  episodes,
  orders,
  orderItems,
  packageChapterMappings,
  packageUpgradeCreditItems,
  packageUpgrades,
  packageUpgradeExecLocks,
  purchases,
  walletTransactions,
} from "../../drizzle/schema";
import { normalizeEpisodeRange } from "./readerService";
import { normalizeMoneyAmount, formatMoney } from "../helpers/moneyNormalizer";
import { createOrderFromCart, finalizeOrderCompletion, quoteCartPricing } from "./orderService";
import { assertSlipCheckoutAvailable } from "./checkoutMaintenanceService";
import { ApprovalService } from "./approvalService";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
// A tx from db.transaction() is NOT the db instance type (MySqlTransaction) -
// every helper accepts either handle.
type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbHandle = Db | DbTx;

export const UPGRADE_QUOTE_TTL_MINUTES = 15;
export const MAPPING_DERIVATION_EPISODE_NUMBER_RANGE = "episode_number_range";

export type PackageUpgradeMethod = "wallet" | "slip";

export class PackageUpgradeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

interface RangeBounds {
  start: number;
  end: number;
}

/**
 * Parse a package episode's normalized episodeNumber ("51 - 100") into
 * numeric bounds. A single-number episodeNumber is NOT a range package for
 * mapping purposes - such packages need an explicit (future) admin mapping
 * and fail closed here.
 */
function parsePackageRange(episodeNumber: unknown): RangeBounds | null {
  const normalized = normalizeEpisodeRange(episodeNumber);
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** A chapter maps only via its SINGLE normalized number ("12"); range-style chapter numbers never map. */
function parseSingleChapterNumber(episodeNumber: unknown): number | null {
  const normalized = normalizeEpisodeRange(episodeNumber);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function toCents(value: unknown): number {
  return Math.round(normalizeMoneyAmount(typeof value === "number" ? value : String(value ?? "0"), "money") * 100);
}

/** The 3-table entitlement existence check, inside the CALLER's transaction (unlike readerService.hasPurchasedEpisode). */
async function hasEntitlementRow(tx: any, userId: number, episodeId: number): Promise<boolean> {
  // R3-4/R4-4: LOCKING reads. This runs inside the upgrade transaction,
  // possibly concurrent with a wallet checkout of the same package - under
  // REPEATABLE READ a plain snapshot SELECT would miss a purchase committed
  // by that checkout after our transaction started, letting BOTH payment
  // paths succeed. FOR UPDATE serializes the decision on the latest state
  // (and the cart row both sides take first keeps a single lock order, so
  // this cannot cycle into a deadlock).
  const wallet = await tx
    .select({ id: episodePurchases.id })
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
    .limit(1)
    .for("update");
  if (wallet.length > 0) return true;
  const order = await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.episodeId, episodeId)))
    .limit(1)
    .for("update");
  if (order.length > 0) return true;
  const gift = await tx
    .select({ id: adminGiftEntitlements.id })
    .from(adminGiftEntitlements)
    .where(and(eq(adminGiftEntitlements.userId, userId), eq(adminGiftEntitlements.episodeId, episodeId)))
    .limit(1)
    .for("update");
  return gift.length > 0;
}

async function requireDb(tx?: DbHandle) {
  const db = tx ?? (await getDb());
  if (!db) throw new PackageUpgradeError("DATABASE_UNAVAILABLE");
  return db;
}

/**
 * P3-R2 feature flag - OFF by default; both quote and execute fail closed
 * until this is explicitly turned on per environment.
 */
export function isPackageUpgradeEnabled(): boolean {
  return process.env.PACKAGE_UPGRADE_ENABLED === "true";
}

/**
 * Fail closed when the migration has not reached this database yet: a
 * probe read on the receipt table turns ER_NO_SUCH_TABLE into a typed
 * disabled-state instead of a raw query error leaking into checkout paths.
 */
async function assertUpgradeSchemaReady(db: DbHandle): Promise<void> {
  try {
    await db.select({ id: packageUpgrades.id }).from(packageUpgrades).limit(1);
    // R8-1: the execution mutex table must exist too - execute cannot run
    // without its transactional row lock.
    await db.select({ userId: packageUpgradeExecLocks.userId }).from(packageUpgradeExecLocks).limit(1);
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_NO_SUCH_TABLE") {
      throw new PackageUpgradeError("FEATURE_SCHEMA_NOT_READY");
    }
    throw error;
  }
}

/**
 * R8-1: take the per-user execution mutex as a TRANSACTIONAL ROW LOCK
 * (FOR UPDATE NOWAIT on packageUpgradeExecLocks). This replaces the
 * connection-scoped named lock entirely:
 *  - there is NO explicit release step that can fail (commit/rollback
 *    releases the row lock itself),
 *  - there is NO connection-scoped state that could survive into a pooled
 *    connection after the transaction ends,
 *  - there is no kill-based cleanup shortcut.
 * A concurrent in-flight execution holds the row: NOWAIT fails fast with
 * ER_LOCK_NOWAIT, surfaced as UPGRADE_CART_BUSY BEFORE any order creation
 * or money movement. Any OTHER error is re-thrown (never swallowed) so the
 * transaction fails closed.
 */
async function acquirePackageUpgradeExecLock(tx: DbHandle, userId: number): Promise<void> {
  const nowaitSelect = sql`SELECT userId FROM packageUpgradeExecLocks WHERE userId = ${userId} FOR UPDATE NOWAIT`;
  // Drizzle wraps driver errors: the MySQL error code lives on the error
  // itself or on its `cause` chain - check both, never guess.
  const mysqlErrorCode = (error: unknown): string | undefined => {
    let current: any = error;
    for (let depth = 0; current != null && depth < 3; depth += 1) {
      const code = (current as { code?: string })?.code;
      if (typeof code === "string" && code.length > 0) return code;
      current = (current as { cause?: unknown })?.cause;
    }
    return undefined;
  };
  // R8R1: a refused NOWAIT acquisition is engine-specific - MySQL 8 reports
  // ER_LOCK_NOWAIT (errno 3572) while MariaDB reports ER_LOCK_WAIT_TIMEOUT
  // (errno 1205, "Lock wait timeout exceeded"). BOTH mean exactly one thing
  // here: another transaction is holding THIS user's mutex row, so the
  // acquisition fails fast as UPGRADE_CART_BUSY. This mapping is scoped to
  // the two statements in this helper (the NOWAIT select and the seeding
  // INSERT) - lock timeouts from ANY other SQL are never caught here and
  // keep propagating unchanged.
  const isNowaitLockRefused = (error: unknown): boolean => {
    const code = mysqlErrorCode(error);
    return code === "ER_LOCK_NOWAIT" || code === "ER_LOCK_WAIT_TIMEOUT";
  };
  try {
    const rows: any = await tx.execute(nowaitSelect);
    const unwrapped = Array.isArray(rows?.[0]) ? rows[0] : rows;
    if (Array.isArray(unwrapped) && unwrapped.length > 0) return; // row locked by THIS tx
  } catch (error) {
    if (isNowaitLockRefused(error)) {
      throw new PackageUpgradeError("UPGRADE_CART_BUSY");
    }
    throw error; // R8-1: fail closed - never swallow
  }
  // Row not seeded yet (receipts quoted before this table existed):
  // create it INSIDE this transaction - owning the insert owns the row
  // lock until commit/rollback. INSERT IGNORE returns affectedRows 0 when
  // a concurrent transaction committed the row first.
  // R8R2: the seeding INSERT itself can hit the lock path - waiting on a
  // concurrent UNCOMMITTED seeding insert (unique-index conflict) times
  // out with ER_LOCK_WAIT_TIMEOUT (1205, MariaDB) or the equivalent MySQL
  // refusal - so the same engine-aware mapping applies: a refused lock
  // becomes UPGRADE_CART_BUSY, any OTHER error is rethrown (never
  // swallowed) so the transaction fails closed.
  let insertResult: any;
  try {
    insertResult = await tx.execute(
      sql`INSERT IGNORE INTO packageUpgradeExecLocks (userId) VALUES (${userId})`
    );
  } catch (error) {
    if (isNowaitLockRefused(error)) {
      throw new PackageUpgradeError("UPGRADE_CART_BUSY");
    }
    throw error; // fail closed - never swallow
  }
  const info = Array.isArray(insertResult?.[0]) ? insertResult[0] : insertResult;
  if (Number(info?.affectedRows ?? 0) >= 1) return;
  // Lost the seeding race: the row exists now - take the NOWAIT lock.
  try {
    const rows: any = await tx.execute(nowaitSelect);
    const unwrapped = Array.isArray(rows?.[0]) ? rows[0] : rows;
    if (Array.isArray(unwrapped) && unwrapped.length > 0) return;
  } catch (error) {
    if (isNowaitLockRefused(error)) {
      throw new PackageUpgradeError("UPGRADE_CART_BUSY");
    }
    throw error;
  }
  // Unreachable invariant (row visible but not lockable) - fail closed.
  throw new PackageUpgradeError("UPGRADE_CART_BUSY");
}

/**
 * Mark a quoted upgrade as expired OUTSIDE any transaction that is about
 * to roll back, so the retirement survives the rollback and the reader can
 * re-quote right away. Conditional on status='quoted' (idempotent).
 */
async function retireQuoteOutsideTx(upgradeId: number): Promise<void> {
  const fresh = await getDb();
  if (!fresh) return;
  await fresh
    .update(packageUpgrades)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(packageUpgrades.id, upgradeId), eq(packageUpgrades.status, "quoted")));
}

/**
 * Derive (once) and persist the chapter->package mapping, then return the
 * persisted rows. Insert-only: existing rows are never rewritten or
 * deleted, so the evidence for past quotes/credits is immutable.
 */
export async function ensurePackageChapterMapping(
  packageEpisode: { id: number; novelId: number; episodeNumber: string },
  tx?: DbHandle
): Promise<Array<{ chapterEpisodeId: number; sortOrder: number }>> {
  const db = await requireDb(tx);
  const bounds = parsePackageRange(packageEpisode.episodeNumber);
  if (!bounds) throw new PackageUpgradeError("PACKAGE_NOT_RANGE_MAPPED");

  const novelEpisodes = await db
    .select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
    .from(episodes)
    .where(eq(episodes.novelId, packageEpisode.novelId));

  const candidates = novelEpisodes
    .filter((e) => e.id !== packageEpisode.id)
    .map((e) => ({ id: e.id, number: parseSingleChapterNumber(e.episodeNumber) }))
    .filter((e): e is { id: number; number: number } => e.number !== null)
    .filter((e) => e.number >= bounds.start && e.number <= bounds.end)
    .sort((a, b) => a.number - b.number);

  const existing = await db
    .select({ chapterEpisodeId: packageChapterMappings.chapterEpisodeId })
    .from(packageChapterMappings)
    .where(eq(packageChapterMappings.packageEpisodeId, packageEpisode.id));
  const existingIds = new Set(existing.map((row) => row.chapterEpisodeId));

  const missing = candidates.filter((c) => !existingIds.has(c.id));
  if (missing.length > 0) {
    try {
      await db.insert(packageChapterMappings).values(
        missing.map((c) => ({
          novelId: packageEpisode.novelId,
          packageEpisodeId: packageEpisode.id,
          chapterEpisodeId: c.id,
          sortOrder: c.number,
          derivation: MAPPING_DERIVATION_EPISODE_NUMBER_RANGE,
        }))
      );
    } catch (error) {
      // Concurrent derivation lost the unique-index race - the persisted
      // rows below are the truth either way (same rows, insert-only).
      if (!(error as { code?: string })?.code?.startsWith("ER_DUP") &&
        !String((error as Error)?.message ?? "").includes("Duplicate entry")) {
        throw error;
      }
    }
  }

  const persisted = await db
    .select({
      chapterEpisodeId: packageChapterMappings.chapterEpisodeId,
      sortOrder: packageChapterMappings.sortOrder,
    })
    .from(packageChapterMappings)
    .where(eq(packageChapterMappings.packageEpisodeId, packageEpisode.id));
  return persisted.sort((a, b) => a.sortOrder - b.sortOrder || a.chapterEpisodeId - b.chapterEpisodeId);
}

export interface UpgradeCreditItem {
  chapterEpisodeId: number;
  source: "wallet_purchase" | "approved_order";
  sourceRefId: number;
  pricePaidSnapshot: string;
}

/**
 * Compute the per-chapter credit from PROVABLE money records only. Reads
 * exclusively within the given (optional) transaction so execute()'s
 * revalidation is consistent with its payment writes.
 */
export async function computeUpgradeCredit(
  userId: number,
  mappingRows: Array<{ chapterEpisodeId: number; sortOrder: number }>,
  tx?: DbHandle
): Promise<{ items: UpgradeCreditItem[]; creditRaw: number }> {
  const db = await requireDb(tx);
  const chapterIds = mappingRows.map((m) => m.chapterEpisodeId);
  if (chapterIds.length === 0) return { items: [], creditRaw: 0 };

  // Source 1: wallet chapter purchases (real debit, refund-excluded).
  const walletRows = await db
    .select({
      id: episodePurchases.id,
      userId: episodePurchases.userId,
      episodeId: episodePurchases.episodeId,
      pricePaid: episodePurchases.pricePaid,
      walletTransactionId: episodePurchases.walletTransactionId,
    })
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), inArray(episodePurchases.episodeId, chapterIds)));

  const refundedPurchaseIds = new Set<number>();
  const walletPurchaseIds = walletRows.map((r) => r.id);
  if (walletPurchaseIds.length > 0) {
    // Refunds follow the same reference semantics as the debit they undo:
    // referenceId = the CHAPTER's episode id (production shape).
    const chapterRefIds = mappingRows.map((m) => m.chapterEpisodeId);
    const refundRows = await db
      .select({ referenceId: walletTransactions.referenceId })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, userId),
          eq(walletTransactions.type, "refund"),
          eq(walletTransactions.referenceType, "episode_purchase"),
          inArray(walletTransactions.referenceId, chapterRefIds)
        )
      );
    const refundedEpisodeIds = new Set(
      refundRows.map((row) => row.referenceId).filter((id): id is number => id != null)
    );
    // mark the purchase rows whose EPISODE was refunded
    for (const row of walletRows) {
      if (refundedEpisodeIds.has(row.episodeId)) refundedPurchaseIds.add(row.id);
    }
  }

  const walletCreditByChapter = new Map<number, { amount: number; sourceRefId: number }>();
  const walletPurchaseIdsWithTx = walletRows.filter((r) => r.walletTransactionId != null).map((r) => r.walletTransactionId as number);
  const walletTxById = new Map<number, { userId: number; type: string; amount: string; referenceType: string | null; referenceId: number | null }>();
  if (walletPurchaseIdsWithTx.length > 0) {
    const txRows = await db
      .select({
        id: walletTransactions.id,
        userId: walletTransactions.userId,
        type: walletTransactions.type,
        amount: walletTransactions.amount,
        referenceType: walletTransactions.referenceType,
        referenceId: walletTransactions.referenceId,
      })
      .from(walletTransactions)
      .where(inArray(walletTransactions.id, walletPurchaseIdsWithTx));
    for (const row of txRows) walletTxById.set(row.id, row);
  }
  const episodeIdByChapterId = new Map<number, number>();
  for (const m of mappingRows) episodeIdByChapterId.set(m.chapterEpisodeId, m.chapterEpisodeId);
  for (const row of walletRows) {
    const chapterEpisodeId = row.episodeId;
    if (refundedPurchaseIds.has(row.id)) continue;
    if (row.walletTransactionId == null) continue; // non-wallet provenance cannot prove real money
    // R3-1: corroboration follows the PRODUCTION ledger shape written by
    // purchaseEpisodeWithWallet: the debit references the CHAPTER's episode
    // id (referenceId = episodeId), and is tied to this purchase row via
    // episodePurchases.walletTransactionId. Same user, a DEBIT, the same
    // amount. Anything else fails closed (no credit), never guessed.
    const tx = walletTxById.get(row.walletTransactionId);
    if (!tx) continue;
    if (tx.userId !== row.userId) continue;
    if (tx.type !== "debit") continue;
    if (tx.referenceType !== "episode_purchase") continue;
    if (tx.referenceId == null || tx.referenceId !== chapterEpisodeId) continue;
    if (toCents(tx.amount) !== toCents(row.pricePaid)) continue;
    const amount = toCents(row.pricePaid) / 100;
    if (amount <= 0) continue;
    walletCreditByChapter.set(chapterEpisodeId, { amount, sourceRefId: row.id });
    void episodeIdByChapterId;
  }

  // Source 2: order-based purchases on APPROVED orders (provable net =
  // orderItems.finalPrice). MAX per chapter guards a historically weird
  // double row - still capped by the package price at the caller.
  const purchaseRows = await db
    .select({ orderId: purchases.orderId, episodeId: purchases.episodeId })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), inArray(purchases.episodeId, chapterIds)));

  const approvedOrderIds = Array.from(new Set(purchaseRows.map((r) => r.orderId)));
  const approvedOrderSet = new Set<number>();
  if (approvedOrderIds.length > 0) {
    const approved = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(inArray(orders.id, approvedOrderIds), eq(orders.status, "approved"), eq(orders.paymentStatus, "approved")));
    for (const row of approved) approvedOrderSet.add(row.id);
  }

  const orderCreditByChapter = new Map<number, { amount: number; sourceRefId: number }>();
  if (approvedOrderSet.size > 0) {
    const ownedOrderIds = purchaseRows
      .filter((r) => approvedOrderSet.has(r.orderId))
      .map((r) => r.orderId);
    const approvedOrderRows = await db
      .select({
        id: orders.id,
        subtotal: orders.subtotal,
        discountAmount: orders.discountAmount,
        pointsDiscountAmount: orders.pointsDiscountAmount,
      })
      .from(orders)
      .where(inArray(orders.id, ownedOrderIds));
    const orderById = new Map(approvedOrderRows.map((o) => [o.id, o]));
    // R4-1: order-level coupon/points discounts belong to the WHOLE order -
    // allocate them across ALL order items (not just the mapped ones), then
    // keep only the chapters that map into this package. Allocating onto
    // eligible items alone would concentrate the whole-order discount on a
    // few chapters and understate the provable credit.
    const itemRows = await db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        episodeId: orderItems.episodeId,
        finalPrice: orderItems.finalPrice,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ownedOrderIds));
    // R5-03: group items per order. Allocation is satang-exact:
    //  1. proportional FLOOR pass per item (capped at the item's own price);
    //  2. the remaining remainder is distributed ONE satang at a time, in
    //     order, to items that still have net headroom - so no item's
    //     discount ever exceeds its own price AND the whole order-level
    //     discount is placed exactly: SUM(allocated) == orderLevelDiscount,
    //     therefore SUM(net) == order.totalAmount (the provable credit can
    //     never exceed what was actually paid).
    const itemsByOrder = new Map<number, typeof itemRows>();
    for (const row of itemRows) {
      const list = itemsByOrder.get(row.orderId) ?? [];
      list.push(row);
      itemsByOrder.set(row.orderId, list);
    }
    for (const orderId of Array.from(itemsByOrder.keys())) {
      const rows = itemsByOrder.get(orderId)!;
      const order = orderById.get(orderId);
      if (!order) continue;
      const subtotalCents = toCents(order.subtotal);
      const orderLevelDiscountCents =
        toCents(order.discountAmount) + toCents(order.pointsDiscountAmount);
      const rowsInOrder = [...rows].sort((a, b) => a.id - b.id);
      const finals = rowsInOrder.map((row) => toCents(row.finalPrice));
      const nets = [...finals];
      // Per-item discount allocation (satang-exact, see R5-03): proportional
      // FLOOR capped at the item's own price, then the leftover remainder is
      // spread ONE satang at a time over items with net headroom - so
      // SUM(allocated) == orderLevelDiscount exactly, no item is over-
      // discounted, and SUM(net) == order.totalAmount.
      let allocated = finals.map((f) =>
        subtotalCents > 0
          ? Math.min(Math.floor((f * orderLevelDiscountCents) / subtotalCents), f)
          : 0
      );
      if (subtotalCents > 0 && orderLevelDiscountCents > 0) {
        let remainder = orderLevelDiscountCents - allocated.reduce((a, b) => a + b, 0);
        // Spread the remainder one satang at a time over items whose
        // allocated discount is still below their own price (deterministic
        // in-order scan; no item is ever over-discounted).
        let i = 0;
        while (remainder > 0 && i < allocated.length * 2) {
          const idx = i % allocated.length;
          if (allocated[idx] < finals[idx]) {
            allocated[idx] += 1;
            remainder -= 1;
          }
          i += 1;
        }
      }
      // Apply the allocation onto the nets: net = final - allocated (>= 0).
      for (let i = 0; i < rowsInOrder.length; i++) {
        nets[i] = Math.max(0, finals[i] - allocated[i]);
      }
      for (let i = 0; i < rowsInOrder.length; i++) {
        const row = rowsInOrder[i];
        if (nets[i] <= 0) continue;
        const amount = nets[i] / 100;
        const existing = orderCreditByChapter.get(row.episodeId);
        if (!existing || amount > existing.amount) {
          orderCreditByChapter.set(row.episodeId, { amount, sourceRefId: row.id });
        }
      }
    }
  }

  // Gift/free chapters simply have no provable money record - they never
  // enter either map, so they contribute nothing by construction.

  const items: UpgradeCreditItem[] = [];
  let creditRaw = 0;
  for (const mapping of mappingRows) {
    const chapterId = mapping.chapterEpisodeId;
    const wallet = walletCreditByChapter.get(chapterId);
    const order = orderCreditByChapter.get(chapterId);
    let item: UpgradeCreditItem | null = null;
    if (wallet && (!order || wallet.amount >= order.amount)) {
      item = {
        chapterEpisodeId: chapterId,
        source: "wallet_purchase",
        sourceRefId: wallet.sourceRefId,
        pricePaidSnapshot: formatMoney(wallet.amount, "pricePaid"),
      };
    } else if (order) {
      item = {
        chapterEpisodeId: chapterId,
        source: "approved_order",
        sourceRefId: order.sourceRefId,
        pricePaidSnapshot: formatMoney(order.amount, "orderFinalPrice"),
      };
    }
    if (item) {
      items.push(item);
      creditRaw += toCents(item.pricePaidSnapshot) / 100;
    }
  }
  return { items, creditRaw: Math.round(creditRaw * 100) / 100 };
}

export interface AppliedCreditItem extends UpgradeCreditItem {
  creditAppliedSnapshot: string;
}

/**
 * R2-02: allocate the package-price cap across the provable chapters in
 * mapping order, satang-exact. `creditApplied` per chapter is what was
 * ACTUALLY used - SUM(applied) always equals the capped credit snapshot,
 * and chapters whose provable amount falls past the cap contribute nothing
 * (they are left out of the ledger rather than recorded at a fake value).
 */
function allocateCreditApplied(
  items: UpgradeCreditItem[],
  capCents: number
): { applied: Array<AppliedCreditItem>; totalAppliedCents: number } {
  let remaining = capCents;
  const applied: Array<AppliedCreditItem> = [];
  for (const item of items) {
    if (remaining <= 0) break;
    const provableCents = toCents(item.pricePaidSnapshot);
    const used = Math.min(provableCents, remaining);
    if (used <= 0) continue;
    remaining -= used;
    applied.push({
      ...item,
      creditAppliedSnapshot: formatMoney(used / 100, "creditApplied"),
    });
  }
  const totalAppliedCents = capCents - remaining;
  return { applied, totalAppliedCents };
}

async function getPackageEpisode(tx: any, packageEpisodeId: number, options: { forUpdate?: boolean } = {}) {
  let query = tx
    .select({
      id: episodes.id,
      novelId: episodes.novelId,
      episodeNumber: episodes.episodeNumber,
      title: episodes.title,
      price: episodes.price,
      isFree: episodes.isFree,
      isPublished: episodes.isPublished,
      saleMode: episodes.saleMode,
      fileUrl: episodes.fileUrl,
    })
    .from(episodes)
    .where(eq(episodes.id, packageEpisodeId))
    .limit(1);
  if (options.forUpdate) query = query.for("update");
  const rows = await query;
  return rows[0] ?? null;
}

function resolveSaleModeSimple(episode: { saleMode?: string | null; fileUrl?: string | null; episodeNumber?: unknown }): "chapter" | "package" {
  if (episode?.saleMode === "chapter" || episode?.saleMode === "package") return episode.saleMode;
  if (episode?.fileUrl && String(episode.fileUrl).trim().length > 0) return "package";
  if (/\d+(?:\.\d+)?\s*-\s*\d+/.test(normalizeEpisodeRange(episode?.episodeNumber))) return "package";
  return "chapter";
}

function validateUpgradablePackage(pkg: {
  price: string | null;
  isFree: boolean;
  isPublished: boolean;
  saleMode?: string | null;
  fileUrl?: string | null;
  episodeNumber: string;
}): number {
  if (!pkg) throw new PackageUpgradeError("PACKAGE_NOT_FOUND");
  if (resolveSaleModeSimple(pkg) !== "package") throw new PackageUpgradeError("PACKAGE_NOT_UPGRADABLE");
  if (!pkg.isPublished) throw new PackageUpgradeError("PACKAGE_NOT_UPGRADABLE");
  if (pkg.isFree) throw new PackageUpgradeError("PACKAGE_NOT_UPGRADABLE");
  const priceRaw = String(pkg.price ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(priceRaw)) throw new PackageUpgradeError("PACKAGE_NOT_UPGRADABLE");
  const price = Number(priceRaw);
  if (!Number.isFinite(price) || price <= 0) throw new PackageUpgradeError("PACKAGE_NOT_UPGRADABLE");
  return price;
}

async function attachCouponPointsPreview(
  dto: Record<string, unknown>,
  opts: { couponCode?: string; pointsToRedeem?: string },
  tx: DbHandle,
  userId: number,
  packageEpisodeId: number,
  novelId: number,
  payableAmount: number
): Promise<Record<string, unknown>> {
  // R6-1: the preview is ALWAYS recomputed per the latest input - including
  // when an ACTIVE quote already exists - so a changed/removed/expired
  // coupon or a points adjustment is reflected before the customer
  // confirms. Server pricing (quoteCartPricing) is the single authority.
  if (!opts.couponCode && !opts.pointsToRedeem) return dto;
  const pricing = await quoteCartPricing(
    String(userId),
    [{ episodeId: packageEpisodeId, novelId, price: formatMoney(payableAmount, "upgradePayable") }],
    opts.couponCode,
    opts.pointsToRedeem,
    tx,
    userId
  );
  return {
    ...dto,
    couponDiscount: formatMoney(pricing.discountAmount, "couponDiscount"),
    pointsDiscount: formatMoney(pricing.pointsDiscountAmount, "pointsDiscount"),
    finalTotal: formatMoney(pricing.totalAmount, "finalTotal"),
  };
}

async function loadCreditItems(upgradeId: number, tx: DbHandle) {
  return tx
    .select({
      chapterEpisodeId: packageUpgradeCreditItems.chapterEpisodeId,
      source: packageUpgradeCreditItems.source,
      sourceRefId: packageUpgradeCreditItems.sourceRefId,
      pricePaidSnapshot: packageUpgradeCreditItems.pricePaidSnapshot,
      creditAppliedSnapshot: packageUpgradeCreditItems.creditApplied,
    })
    .from(packageUpgradeCreditItems)
    .where(eq(packageUpgradeCreditItems.upgradeId, upgradeId));
}

function buildQuoteDto(upgrade: {
  id: number;
  packageEpisodeId: number;
  novelId: number;
  status: string;
  packagePriceSnapshot: string;
  creditAmountSnapshot: string;
  payableAmountSnapshot: string;
  quoteExpiresAt: Date | string;
}, items: Array<{ chapterEpisodeId: number; source: string; sourceRefId: number; pricePaidSnapshot: string }>) {
  return {
    upgradeId: upgrade.id,
    packageEpisodeId: upgrade.packageEpisodeId,
    novelId: upgrade.novelId,
    status: upgrade.status,
    packagePrice: upgrade.packagePriceSnapshot,
    creditAmount: upgrade.creditAmountSnapshot,
    payableAmount: upgrade.payableAmountSnapshot,
    quoteExpiresAt: upgrade.quoteExpiresAt,
    items,
  };
}

/**
 * Create (or return the still-active) server-side upgrade quote. Writes the
 * persisted mapping and the quote receipt + per-chapter credit breakdown in
 * one transaction.
 */
export async function quotePackageUpgrade(
  userId: number,
  packageEpisodeId: number,
  opts: { ttlMinutes?: number; couponCode?: string; pointsToRedeem?: string } = {}
) {
  const db = await getDb();
  if (!db) throw new PackageUpgradeError("DATABASE_UNAVAILABLE");

  await assertUpgradeSchemaReady(db);

  return db.transaction(async (tx) => {
    // R2-03: lock the package row first - serializes quote/execute for THIS
    // package so two concurrent quotes can never both pass the active check.
    const pkg = await getPackageEpisode(tx, packageEpisodeId, { forUpdate: true });
    if (!pkg) throw new PackageUpgradeError("PACKAGE_NOT_FOUND");
    // R8-1: seed the per-user execution mutex row (idempotent). By the time
    // execute() runs, the row exists and its NOWAIT lock is guaranteed
    // fail-fast - the seeding INSERT never has to race.
    await tx.execute(sql`INSERT IGNORE INTO packageUpgradeExecLocks (userId) VALUES (${userId})`);
    const packagePrice = validateUpgradablePackage(pkg);

    if (await hasEntitlementRow(tx, userId, packageEpisodeId)) {
      throw new PackageUpgradeError("ALREADY_OWNED_PACKAGE");
    }

    // R2-03: ONE live receipt per (user, package) across BOTH phases - a
    // still-quoted receipt OR an order_created receipt whose order is still
    // pending (an unpaid slip). Returning the live one keeps the client
    // from stacking a second pending payment path.
    const receipts = await tx
      .select()
      .from(packageUpgrades)
      .where(
        and(
          eq(packageUpgrades.userId, userId),
          eq(packageUpgrades.packageEpisodeId, packageEpisodeId)
        )
      );
    let activeQuoted: (typeof receipts)[number] | null = null;
    let liveOrderReceipt: (typeof receipts)[number] | null = null;
    for (const receipt of receipts) {
      if (receipt.status === "quoted") {
        if (receipt.quoteExpiresAt.getTime() > Date.now()) {
          activeQuoted = receipt;
        }
        continue; // expired quotes are retired below
      }
      if (receipt.status === "order_created" && receipt.orderId != null) {
        const [order] = await tx
          .select({ id: orders.id, status: orders.status })
          .from(orders)
          .where(eq(orders.id, receipt.orderId))
          .limit(1);
        if (order && order.status === "pending") {
          liveOrderReceipt = receipt;
        }
      }
    }
    // Retire expired quotes (only ours; insert-only ledger keeps the rest).
    for (const receipt of receipts) {
      if (receipt.status === "quoted" && receipt.quoteExpiresAt.getTime() <= Date.now()) {
        await tx
          .update(packageUpgrades)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(packageUpgrades.id, receipt.id));
      }
    }
    if (liveOrderReceipt) {
      const [order] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, liveOrderReceipt.orderId as number))
        .limit(1);
      return {
        ...buildQuoteDto(liveOrderReceipt, await loadCreditItems(liveOrderReceipt.id, tx)),
        awaitingPayment: true as const,
        orderId: liveOrderReceipt.orderId,
        orderStatus: order?.status ?? "pending",
      };
    }
    if (activeQuoted) {
      // R6-1: an ACTIVE quote still re-computes the coupon/points preview
      // per the LATEST input (changed/removed/expired coupon, points change)
      // so the confirmation dialog never shows a stale price.
      const dto = buildQuoteDto(activeQuoted, await loadCreditItems(activeQuoted.id, tx));
      const snapshotPayable = toCents(activeQuoted.payableAmountSnapshot) / 100;
      return await attachCouponPointsPreview(
        dto,
        opts,
        tx,
        userId,
        packageEpisodeId,
        pkg.novelId,
        snapshotPayable
      );
    }

    const mappingRows = await ensurePackageChapterMapping(
      { id: pkg.id, novelId: pkg.novelId, episodeNumber: pkg.episodeNumber },
      tx
    );
    const { items } = await computeUpgradeCredit(userId, mappingRows, tx);

    // R2-02: the cap is ALLOCATED satang-exactly onto the proven chapters -
    // SUM(creditApplied) in the ledger will equal creditAmountSnapshot, and
    // chapters past the cap are simply not part of the ledger.
    const { applied, totalAppliedCents } = allocateCreditApplied(items, toCents(packagePrice));
    const creditCents = totalAppliedCents;
    const payableCents = Math.max(0, toCents(packagePrice) - creditCents);
    const creditAmount = creditCents / 100;
    const payableAmount = payableCents / 100;
    const ttlMinutes = opts.ttlMinutes ?? UPGRADE_QUOTE_TTL_MINUTES;
    const quoteExpiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    // The receipt's idempotencyKey column holds the EXECUTION key once
    // execute() runs; while still quoted it carries a trace-only key (a
    // quoted receipt has produced no money movement, so there is nothing
    // to replay - execute() binds the caller's execution key on first use).
    const idempotencyKey = `quote-${userId}-${packageEpisodeId}-${randomUUID()}`;

    let inserted: { id: number } | null = null;
    try {
      const result = (await tx
        .insert(packageUpgrades)
        .values({
          userId,
          novelId: pkg.novelId,
          packageEpisodeId,
          idempotencyKey,
          status: "quoted",
          packagePriceSnapshot: formatMoney(packagePrice, "packagePrice"),
          creditAmountSnapshot: formatMoney(creditAmount, "upgradeCredit"),
          payableAmountSnapshot: formatMoney(payableAmount, "upgradePayable"),
          quoteExpiresAt,
        }));
      inserted = { id: (result as unknown as [{ insertId: number }])[0].insertId };
    } catch (error) {
      // Concurrent duplicate trace keys are a UUID collision - refuse loudly.
      throw new PackageUpgradeError("QUOTE_KEY_CONFLICT");
    }

    if (applied.length > 0) {
      await tx.insert(packageUpgradeCreditItems).values(
        applied.map((item) => ({
          upgradeId: inserted!.id,
          userId,
          novelId: pkg.novelId,
          chapterEpisodeId: item.chapterEpisodeId,
          source: item.source,
          sourceRefId: item.sourceRefId,
          pricePaidSnapshot: item.pricePaidSnapshot,
          creditApplied: item.creditAppliedSnapshot,
        }))
      );
    }

    const dto = buildQuoteDto(
      {
        id: inserted.id,
        packageEpisodeId,
        novelId: pkg.novelId,
        status: "quoted",
        packagePriceSnapshot: formatMoney(packagePrice, "packagePrice"),
        creditAmountSnapshot: formatMoney(creditAmount, "upgradeCredit"),
        payableAmountSnapshot: formatMoney(payableAmount, "upgradePayable"),
        quoteExpiresAt,
      },
      applied.map((item: AppliedCreditItem) => ({
        chapterEpisodeId: item.chapterEpisodeId,
        source: item.source,
        sourceRefId: item.sourceRefId,
        pricePaidSnapshot: item.pricePaidSnapshot,
        creditAppliedSnapshot: item.creditAppliedSnapshot,
      }))
    );

    // R2-04: optional coupon/points preview over the POST-credit payable -
    // the exact same quoteCartPricing the checkout will run, so the
    // confirmed dialog total and the finalized order can never diverge.
    return await attachCouponPointsPreview(
      dto,
      opts,
      tx,
      userId,
      packageEpisodeId,
      pkg.novelId,
      payableAmount
    );
  });
}

export interface ExecuteUpgradeInput {
  upgradeId: number;
  method: PackageUpgradeMethod;
  idempotencyKey: string;
  /** Optional order-level coupon applied AFTER the chapter credit (R2-04). */
  couponCode?: string;
  /** Optional points redemption applied AFTER coupon (R2-04). */
  pointsToRedeem?: string;
  /**
   * R7-02: MANDATORY for every new execute - the net total the customer
   * CONFIRMED on the dialog (from the quote preview). The server recomputes
   * the authoritative price and refuses with STALE_QUOTE (no order, no
   * money movement) when this is missing or differs. The server price is
   * always authoritative; this is only a confirmation binding, never a
   * client-set price. Idempotent replays (already-processed receipts)
   * return before this binding runs.
   */
  expectedFinalTotal: string;
}

/**
 * Execute a quoted upgrade. Everything below runs in ONE transaction:
 * claim (conditional status UPDATE) -> full revalidation against the quote
 * snapshot -> order creation through the SAME createOrderFromCart pricing
 * as ordinary checkout -> (wallet: atomic debit + approve + finalize) ->
 * credit-item ledger write. Any mismatch throws and rolls the claim back.
 */
export async function executePackageUpgrade(userId: number, input: ExecuteUpgradeInput) {
  const db = await getDb();
  if (!db) throw new PackageUpgradeError("DATABASE_UNAVAILABLE");
  await assertUpgradeSchemaReady(db);

  if (!["wallet", "slip"].includes(input.method)) {
    throw new PackageUpgradeError("INVALID_METHOD");
  }
  const key = String(input.idempotencyKey ?? "").trim();
  if (key.length < 8 || key.length > 128) {
    throw new PackageUpgradeError("INVALID_IDEMPOTENCY_KEY");
  }

  // Set inside the transaction when the receipt must be retired; honored
  // by the .catch below AFTER the rollback (never inside - the retire UPDATE
  // on the same row would wait on this transaction's own FOR UPDATE lock).
  let retireAfterRollback: "QUOTE_EXPIRED" | "STALE_QUOTE" | null = null;

  const transactionResult = await db.transaction(async (tx) => {
    const [upgrade] = await tx
      .select()
      .from(packageUpgrades)
      .where(and(eq(packageUpgrades.id, input.upgradeId), eq(packageUpgrades.userId, userId)))
      .limit(1)
      .for("update");
    if (!upgrade) throw new PackageUpgradeError("UPGRADE_NOT_FOUND");

    // Idempotent replay: a non-quoted receipt means execute() already ran -
    // replay ONLY with the exact execution key that produced it. A different
    // key is a lost concurrent race (or a double-run attempt): refuse.
    if (upgrade.status === "order_created" && upgrade.idempotencyKey !== key) {
      throw new PackageUpgradeError("UPGRADE_ALREADY_PROCESSING");
    }
    if (upgrade.status !== "quoted" && upgrade.idempotencyKey !== key) {
      throw new PackageUpgradeError("IDEMPOTENCY_KEY_MISMATCH");
    }
    // A still-quoted receipt has no money movement: binding a NEW execution
    // key here is normal (fresh dialog/page load) and simply replaces the
    // trace key. (Quoted receipts replay nothing - there is nothing yet.)
    if (upgrade.status === "order_created") {
      const [order] = upgrade.orderId
        ? await tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, upgrade.orderId)).limit(1)
        : [];
      return {
        alreadyProcessed: true as const,
        upgradeId: upgrade.id,
        orderId: upgrade.orderId ?? null,
        orderStatus: order?.status ?? null,
        packagePrice: upgrade.packagePriceSnapshot,
        creditAmount: upgrade.creditAmountSnapshot,
        payableAmount: upgrade.payableAmountSnapshot,
      };
    }
    if (upgrade.status !== "quoted") throw new PackageUpgradeError("UPGRADE_NOT_USABLE");
    if (upgrade.quoteExpiresAt.getTime() <= Date.now()) {
      // Retire AFTER this transaction rolls back (retiring HERE would
      // self-deadlock on the FOR UPDATE row lock this tx already holds).
      retireAfterRollback = "QUOTE_EXPIRED";
      throw new PackageUpgradeError("QUOTE_EXPIRED");
    }

    // R8-1/R5-01: per-user execution mutex as a TRANSACTIONAL ROW LOCK
    // (FOR UPDATE NOWAIT on packageUpgradeExecLocks). A concurrent
    // in-flight execution (or an external holder of the row) fails fast
    // with UPGRADE_CART_BUSY BEFORE any order creation or money movement.
    // The lock is released by commit/rollback itself - there is no release
    // call, no connection-scoped state, and no cleanup shortcut. The body
    // below ran inside try/finally only to release the old named lock;
    // rollback/commit now does that job, so the guard is gone.
    await acquirePackageUpgradeExecLock(tx, userId);
    // R5-01: DISTINGUISH "no cart" from "cart locked" EXACTLY.
    //  1. A plain (snapshot) SELECT first: if the user has NO cart row at
    //     all, there is no cart checkout to race - proceed without sweep.
    //  2. A FOR UPDATE SKIP LOCKED on the known-to-exist row: NULL means
    //     an in-flight checkout HOLDS the cart -> FAIL CLOSED with
    //     UPGRADE_CART_BUSY before any order or money movement.
    // The sweep then removes ONLY the package episode being upgraded
    // (R5-02: every other cart item survives, and the sweep is
    // transactional - any later failure restores all rows).
    const [existingCart] = await tx
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.userId, userId))
      .limit(1);
    if (existingCart) {
      const [lockedCart] = await tx
        .select({ id: carts.id })
        .from(carts)
        .where(eq(carts.userId, userId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!lockedCart) {
        // Cart exists but is held by an in-flight checkout: fail closed
        // before creating any order or moving money. Client-safe retry.
        throw new PackageUpgradeError("UPGRADE_CART_BUSY");
      }
      const cartItemRows = await tx
        .select({ id: cartItems.id, episodeId: cartItems.episodeId })
        .from(cartItems)
        .where(eq(cartItems.cartId, lockedCart.id));
      const blocking = cartItemRows.find(
        (item: { episodeId: number }) => item.episodeId === upgrade.packageEpisodeId
      );
      if (blocking) {
        // R3-4: delete THROUGH THE SAME TX - removeFromCart() uses a fresh
        // pool connection and would self-deadlock against the FOR UPDATE
        // locks this transaction already holds.
        await tx.delete(cartItems).where(eq(cartItems.id, (blocking as { id: number }).id));
      }
    }

    // Claim: single winner. Losers of a concurrent race get 0 affected rows.
    // The execution key is BOUND here (unique column backs the replay).
    const claim = await tx
      .update(packageUpgrades)
      .set({ idempotencyKey: key, status: "order_created", updatedAt: new Date() })
      .where(and(eq(packageUpgrades.id, upgrade.id), eq(packageUpgrades.status, "quoted")));
    const claimResult = claim as unknown as [{ affectedRows: number }];
    if ((claimResult[0]?.affectedRows ?? 0) === 0) {
      throw new PackageUpgradeError("UPGRADE_ALREADY_PROCESSING");
    }
    // From here on every failure path THROWS, rolling the claim (and all
    // money writes below) back together.

    const pkg = await getPackageEpisode(tx, upgrade.packageEpisodeId, { forUpdate: true });
    if (!pkg) throw new PackageUpgradeError("PACKAGE_NOT_FOUND");
    const packagePrice = validateUpgradablePackage(pkg);
    if (packagePrice !== Number(upgrade.packagePriceSnapshot)) throw new PackageUpgradeError("STALE_QUOTE");

    // R3-4/R4-4: LOCKING entitlement reads - under REPEATABLE READ a plain
    // snapshot SELECT would miss a purchase committed by a concurrent
    // checkout, letting both payment paths succeed.
    if (await hasEntitlementRow(tx, userId, upgrade.packageEpisodeId)) {
      throw new PackageUpgradeError("ALREADY_OWNED_PACKAGE");
    }

    // R3-4/R2-02: recompute PROVABLE per-chapter credit over the PERSISTED
    // mapping (validated against live episodes), re-run the exact cap
    // allocation, and compare the whole per-chapter plan against the ledger.
    const mappingRowsRaw = await tx
      .select({
        chapterEpisodeId: packageChapterMappings.chapterEpisodeId,
        sortOrder: packageChapterMappings.sortOrder,
      })
      .from(packageChapterMappings)
      .where(eq(packageChapterMappings.packageEpisodeId, upgrade.packageEpisodeId));
    const chapterEpisodeRows = mappingRowsRaw.length
      ? await tx
          .select({ id: episodes.id, novelId: episodes.novelId })
          .from(episodes)
          .where(inArray(episodes.id, mappingRowsRaw.map((m) => m.chapterEpisodeId)))
      : [];
    const validChapterIds = new Set(
      chapterEpisodeRows.filter((e) => e.novelId === upgrade.novelId).map((e) => e.id)
    );
    const mappingRows = mappingRowsRaw
      .filter((m) => validChapterIds.has(m.chapterEpisodeId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.chapterEpisodeId - b.chapterEpisodeId);
    const { items } = await computeUpgradeCredit(userId, mappingRows, tx);
    const { applied } = allocateCreditApplied(items, toCents(packagePrice));
    const creditCents = applied.reduce((sum, item) => sum + toCents(item.creditAppliedSnapshot), 0);
    const payableCents = Math.max(0, toCents(packagePrice) - creditCents);
    if (
      creditCents !== toCents(upgrade.creditAmountSnapshot) ||
      payableCents !== toCents(upgrade.payableAmountSnapshot)
    ) {
      retireAfterRollback = "STALE_QUOTE";
      throw new PackageUpgradeError("STALE_QUOTE");
    }
    const persistedItems = await loadCreditItems(upgrade.id, tx);
    const expectedPlan = new Map(
      applied.map((item: AppliedCreditItem) => [
        item.chapterEpisodeId,
        {
          source: item.source,
          sourceRefId: item.sourceRefId,
          pricePaidCents: toCents(item.pricePaidSnapshot),
          appliedCents: toCents(item.creditAppliedSnapshot),
        },
      ])
    );
    if (
      persistedItems.length !== applied.length ||
      persistedItems.some((row) => {
        const expected = expectedPlan.get(row.chapterEpisodeId);
        return (
          !expected ||
          expected.source !== row.source ||
          expected.sourceRefId !== row.sourceRefId ||
          expected.pricePaidCents !== toCents(row.pricePaidSnapshot) ||
          expected.appliedCents !== toCents(row.creditAppliedSnapshot)
        );
      })
    ) {
      retireAfterRollback = "STALE_QUOTE";
      throw new PackageUpgradeError("STALE_QUOTE");
    }
    const payableAmount = payableCents / 100;
    const payable = formatMoney(payableAmount, "upgradePayable");

    // R6-1 PRICE BINDING: recompute the authoritative final price with the
    // SAME quoteCartPricing the order pipeline uses, and confirm the
    // customer-accepted net price BEFORE creating the order. Any change
    // (credit re-allocation, coupon expiry, points adjustment) fails
    // closed with STALE_QUOTE - no order, no debit.
    const pricing = await quoteCartPricing(
      String(userId),
      [{ episodeId: upgrade.packageEpisodeId, novelId: upgrade.novelId, price: payable }],
      input.couponCode,
      input.pointsToRedeem,
      tx,
      userId
    );
    const finalTotal = formatMoney(pricing.totalAmount, "finalTotal");
    // R7-02: the confirmation is MANDATORY - a new execute that arrives
    // without the customer-confirmed price is refused exactly like a
    // mismatched one (fail closed BEFORE any order creation or debit).
    // Missing and mismatching are indistinguishable to the client retry:
    // both retire the receipt and both resolve with a fresh re-quote.
    if (input.expectedFinalTotal == null || toCents(input.expectedFinalTotal) !== toCents(finalTotal)) {
      retireAfterRollback = "STALE_QUOTE";
      throw new PackageUpgradeError("STALE_QUOTE");
    }

    // Entitlement through the SAME order pipeline as ordinary checkout: the
    // item's price IS the post-credit payable, so Cart/Wallet/QR/Slip/
    // finalization all price off one server-side function. Optional
    // coupon/points ride the same call (R2-04: credit -> coupon -> points).
    const order = await createOrderFromCart(
      String(userId),
      [{ episodeId: upgrade.packageEpisodeId, novelId: upgrade.novelId, price: payable }],
      input.couponCode,
      input.pointsToRedeem,
        undefined,
        tx,
        userId
      );

      // R8-4: the produced order must charge EXACTLY the price the user
      // confirmed. The pre-order binding proves the INPUTS agree; this
      // post-check proves the ORDER PIPELINE's own allocation (credit,
      // coupon, points, satang spread) landed on the same net total. Any
      // drift fails the WHOLE transaction closed - rollback reverts the
      // order and any wallet movement atomically.
      if (
        toCents(formatMoney(normalizeMoneyAmount(order.totalAmount, "finalPayable"), "finalPayable")) !==
        toCents(finalTotal)
      ) {
        retireAfterRollback = "STALE_QUOTE";
        throw new PackageUpgradeError("STALE_QUOTE");
      }

      if (input.method === "slip") {
      // R3-5: binding INSIDE the service (not only at the route) so every
      // caller hits the slip gate before any slip-only order exists.
      await assertSlipCheckoutAvailable("packageUpgrade.execute.slip");
    }

    // The FINAL payable for wallet settlement is the order total (post
    // coupon/points) - the same number QR/slip would quote.
    const finalPayable = formatMoney(normalizeMoneyAmount(order.totalAmount, "finalPayable"), "finalPayable");
    const finalPayableCents = toCents(finalPayable);

    if (input.method === "wallet") {
      await assertAccountMergeClassifiedMutationAllowed(userId, tx);
      if (finalPayableCents > 0) {
        try {
          await debitWalletBalance(userId, finalPayable, "order", order.id, tx);
        } catch (error) {
          if (/insufficient wallet balance/i.test(String((error as Error)?.message ?? ""))) {
            throw new PackageUpgradeError("INSUFFICIENT_WALLET_BALANCE");
          }
          throw error;
        }
      }
      await updateOrder(order.id, { status: "approved", paymentStatus: "approved" }, tx);
      const payment = await getPaymentByOrderId(order.id, tx);
      if (payment) {
        await ApprovalService.approvePaymentWithSource(payment.id, "wallet", {}, tx);
      }
      await finalizeOrderCompletion(order.id, userId, tx);
    }
    // slip: the order stays pending + payment pending - settled through the
    // EXISTING slip upload -> approval pipeline (idempotent finalize).

    await tx
      .update(packageUpgrades)
      .set({ orderId: order.id, updatedAt: new Date() })
      .where(eq(packageUpgrades.id, upgrade.id));

    return {
      alreadyProcessed: false as const,
      upgradeId: upgrade.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: input.method === "wallet" ? "approved" : (order.status ?? "pending"),
      method: input.method,
      packagePrice: upgrade.packagePriceSnapshot,
      creditAmount: upgrade.creditAmountSnapshot,
      payableAmount: payable,
      couponDiscount: order.discountAmount,
      pointsDiscount: order.pointsDiscountAmount,
      amountPaid: finalPayable,
    };
  }).catch(async (error) => {
    if (
      retireAfterRollback &&
      error instanceof PackageUpgradeError &&
      (error.code === "QUOTE_EXPIRED" || error.code === "STALE_QUOTE")
    ) {
      await retireQuoteOutsideTx(input.upgradeId);
      throw new PackageUpgradeError(retireAfterRollback);
    }
    throw error;
  });
  return transactionResult;
}

/**
 * Cart guard: true while an upgrade for this package has a live order
 * (created but neither approved nor rejected/cancelled) - adding the same
 * package to the cart must then be refused so the user cannot pay twice
 * through parallel checkout paths.
 */
/**
 * R2-03 checkout guard: refuses when ANY of the episodes (packages) has an
 * upgrade receipt holding a live (pending) order - called by
 * checkout.create and checkout.walletCheckout under the cart lock so a
 * cart checkout can never settle a package that is simultaneously being
 * upgraded through a slip.
 */
export async function assertNoPendingUpgradeForPackages(userId: number, episodeIds: number[]): Promise<void> {
  // R3-2 isolation: when the feature is OFF (or its schema has not landed
  // yet) there can be no live upgrade, and the guard must stay a NO-OP so
  // ordinary cart/checkout/wallet flows never touch the 0068 tables.
  if (!isPackageUpgradeEnabled()) return;
  const uniqueIds = Array.from(new Set(episodeIds));
  if (uniqueIds.length === 0) return;
  const db = await requireDb();
  try {
    await db.select({ id: packageUpgrades.id }).from(packageUpgrades).limit(1);
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_NO_SUCH_TABLE") return;
    throw error;
  }
  const rows = await db
    .select({ orderId: packageUpgrades.orderId })
    .from(packageUpgrades)
    .where(
      and(
        eq(packageUpgrades.userId, userId),
        inArray(packageUpgrades.packageEpisodeId, uniqueIds),
        eq(packageUpgrades.status, "order_created")
      )
    );
  // R3-4: an order_created receipt whose orderId is still NULL is an
  // execution transaction IN FLIGHT (claim done, order not yet inserted) -
  // it counts as pending without any order lookup.
  if (rows.some((r) => r.orderId == null)) {
    throw new PackageUpgradeError("PENDING_UPGRADE_ORDER_EXISTS");
  }
  const orderIds = rows.map((r) => r.orderId).filter((id): id is number => id != null);
  if (orderIds.length === 0) return;
  const live = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.id, orderIds), eq(orders.status, "pending")));
  if (live.length > 0) throw new PackageUpgradeError("PENDING_UPGRADE_ORDER_EXISTS");
}

/**
 * R2-03 checkout guard: refuses when ANY of the episodes (packages) has an
 * upgrade receipt holding a live (pending) order - called by
 * checkout.create and checkout.walletCheckout under the cart lock so a
 * cart checkout can never settle a package that is simultaneously being
 * upgraded through a slip.
 */

export async function hasPendingUpgradeOrderForPackage(userId: number, packageEpisodeId: number): Promise<boolean> {
  // R4-2 isolation mirror of assertNoPendingUpgradeForPackages: OFF flag or
  // missing schema means no upgrade can exist - never touch the 0068 tables.
  if (!isPackageUpgradeEnabled()) return false;
  const db = await requireDb();
  try {
    await db.select({ id: packageUpgrades.id }).from(packageUpgrades).limit(1);
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_NO_SUCH_TABLE") return false;
    throw error;
  }
  const rows = await db
    .select({ orderId: packageUpgrades.orderId })
    .from(packageUpgrades)
    .where(
      and(
        eq(packageUpgrades.userId, userId),
        eq(packageUpgrades.packageEpisodeId, packageEpisodeId),
        eq(packageUpgrades.status, "order_created")
      )
    );
  const orderIds = rows.map((r) => r.orderId).filter((id): id is number => id != null);
  if (orderIds.length === 0) return false;
  const active = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.id, orderIds), eq(orders.status, "pending")));
  return active.length > 0;
}
