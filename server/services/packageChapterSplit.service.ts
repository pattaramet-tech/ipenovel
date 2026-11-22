import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  adminGiftEntitlements,
  episodePurchases,
  episodes,
  packageChapterMappings,
  purchases,
} from "../../drizzle/schema";
import { normalizeEpisodeRange, resolveSaleMode } from "./readerService";
import {
  type SplitChapter,
  type SplitIssue,
  type SplitPlan,
  parseSplitRange,
  sha256Hex,
  splitPackageContent,
} from "./packageChapterSplit.domain";

/**
 * Legacy package -> chapter backfill (scan / preview / apply).
 *
 * Invariants:
 *  - The package row itself is NEVER modified or deleted: same id, content,
 *    price, fileUrl, saleMode - every existing purchase/gift/order keeps
 *    reading it exactly as before.
 *  - Chapters are ADDITIVE rows. An existing chapter row whose content AND
 *    price/free flag equal the plan is kept (idempotent re-run) and shown
 *    with its STORED price; any difference is a conflict that blocks the
 *    apply - it is never overwritten (buyers' rows are never repriced).
 *  - apply recomputes the plan inside one transaction (package row locked
 *    FOR UPDATE first) and refuses with STALE_PLAN unless it equals the
 *    previewed planHash. The hash binds the package identity, its source
 *    content and price, the pricing options, publish, and the id/state/price
 *    of every related existing chapter.
 *  - No notification is produced: chapters are inserted directly, never via
 *    the admin create-episode route that wires the publication producer.
 */

type DbHandle = any;

export const SPLIT_MAPPING_DERIVATION = "content_heading_split";
const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;

export type PackageSplitErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "PACKAGE_NOT_FOUND"
  | "NOT_A_PACKAGE"
  | "INVALID_PRICING"
  | "PLAN_NOT_APPLICABLE"
  | "STALE_PLAN";

export class PackageSplitError extends Error {
  readonly code: PackageSplitErrorCode;
  readonly issues: PreviewIssue[];
  constructor(code: PackageSplitErrorCode, issues: PreviewIssue[] = []) {
    super(code);
    this.name = "PackageSplitError";
    this.code = code;
    this.issues = issues;
  }
}

export type PreviewIssueCode =
  | SplitIssue["code"]
  | "OVERLAPPING_PACKAGE"
  | "EXISTING_CHAPTER_CONFLICT"
  | "EXISTING_CHAPTER_PRICE_CONFLICT"
  | "EXISTING_NOT_CHAPTER"
  | "AMBIGUOUS_EXISTING_CHAPTER"
  | "INVALID_PRICE";

export interface PreviewIssue {
  code: PreviewIssueCode;
  message: string;
  chapterNumber?: number;
  lineNumber?: number;
}

export interface SplitPricingInput {
  /** Default price for every chapter ("0" = free). */
  chapterPrice: string;
  /** Optional per-chapter price overrides keyed by chapter number. */
  overrides?: Record<string, string>;
}

export type SplitRowAction = "create" | "keep" | "conflict";

export interface SplitPreviewRow {
  chapterNumber: number;
  title: string;
  action: SplitRowAction;
  existingEpisodeId: number | null;
  existingHasBuyers: boolean;
  /** Stored state of the existing chapter row (null for create). */
  existingPrice: string | null;
  existingIsFree: boolean | null;
  existingIsPublished: boolean | null;
  /** create: the price that WILL be written. keep: the STORED price (unchanged). conflict: the requested price. */
  price: string;
  isFree: boolean;
  partCount: number;
  bodyCharCount: number;
  sourceStart: number;
  sourceEnd: number;
  contentSha256: string;
}

export interface SplitPreview {
  packageEpisodeId: number;
  novelId: number;
  episodeNumber: string;
  packageTitle: string;
  packagePrice: string;
  publish: boolean;
  split: Pick<SplitPlan, "ok" | "range" | "planHash" | "sourceSha256" | "sourceLength"> & {
    preambleKind: SplitPlan["preamble"]["kind"];
    chapterCount: number;
  };
  rows: SplitPreviewRow[];
  issues: PreviewIssue[];
  warnings: string[];
  counts: { create: number; keep: number; conflict: number };
  applicable: boolean;
  /** Binds preview to apply. Null unless applicable. */
  planHash: string | null;
}

export interface SplitApplyResult {
  packageEpisodeId: number;
  createdEpisodeIds: number[];
  keptEpisodeIds: number[];
  mappingsInserted: number;
  planHash: string;
}

export type ScanStatus = "no_content" | "needs_attention" | "conflict" | "splittable" | "already_split";

export interface ScanRow {
  packageEpisodeId: number;
  novelId: number;
  episodeNumber: string;
  title: string;
  status: ScanStatus;
  chapterCount: number;
  createCount: number;
  keepCount: number;
  conflictCount: number;
  issueCodes: string[];
}

async function requireHandle(tx?: DbHandle): Promise<DbHandle> {
  if (tx) return tx;
  const db = await getDb();
  if (!db) throw new PackageSplitError("DATABASE_UNAVAILABLE");
  return db;
}

function priceToCents(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function formatCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function normalizePrice(value: string): string {
  return formatCents(priceToCents(value));
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

async function loadPackage(handle: DbHandle, packageEpisodeId: number, lock: boolean) {
  const query = handle.select().from(episodes).where(eq(episodes.id, packageEpisodeId)).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new PackageSplitError("PACKAGE_NOT_FOUND");
  if (resolveSaleMode(row) !== "package") throw new PackageSplitError("NOT_A_PACKAGE");
  return row;
}

async function episodesWithBuyers(handle: DbHandle, episodeIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (episodeIds.length === 0) return out;
  const sources: Array<[any, any]> = [
    [episodePurchases, episodePurchases.episodeId],
    [purchases, purchases.episodeId],
    [adminGiftEntitlements, adminGiftEntitlements.episodeId],
  ];
  for (const [table, column] of sources) {
    const rows: Array<{ episodeId: number }> = await handle
      .select({ episodeId: column })
      .from(table)
      .where(inArray(column, episodeIds));
    rows.forEach((r) => out.add(r.episodeId));
  }
  return out;
}

interface ChapterClassification {
  chapter: SplitChapter;
  action: SplitRowAction;
  existingEpisodeId: number | null;
  existingHasBuyers: boolean;
  existing: { price: string; isFree: boolean; isPublished: boolean } | null;
}

/**
 * Classify the split against the novel's existing episodes. `prices` (the
 * requested price per chapter) is optional: scan classifies on content only;
 * preview/apply also require an existing chapter's stored price/free flag to
 * match, otherwise it is a conflict (never repriced automatically).
 */
async function classifySplit(handle: DbHandle, pkg: any, plan: SplitPlan, prices?: Map<number, string>) {
  const issues: PreviewIssue[] = plan.issues.map((i) => ({ ...i }));
  const novelEpisodes: any[] = await handle
    .select({
      id: episodes.id,
      episodeNumber: episodes.episodeNumber,
      saleMode: episodes.saleMode,
      fileUrl: episodes.fileUrl,
      content: episodes.content,
      price: episodes.price,
      isFree: episodes.isFree,
      isPublished: episodes.isPublished,
    })
    .from(episodes)
    .where(eq(episodes.novelId, pkg.novelId));
  const others = novelEpisodes.filter((e) => e.id !== pkg.id);

  // Another package covering any of these chapter numbers.
  if (plan.range) {
    for (const other of others) {
      if (resolveSaleMode(other) !== "package") continue;
      const otherRange = parseSplitRange(other.episodeNumber);
      if (otherRange && rangesOverlap(plan.range, otherRange)) {
        issues.push({
          code: "OVERLAPPING_PACKAGE",
          message: `ช่วงแพ็กซ้อนกับแพ็ก "${other.episodeNumber}" (episodeId ${other.id})`,
        });
      }
    }
  }

  const byNumber = new Map<string, any[]>();
  for (const other of others) {
    const key = normalizeEpisodeRange(other.episodeNumber);
    const bucket = byNumber.get(key) ?? [];
    bucket.push(other);
    byNumber.set(key, bucket);
  }

  const matchedIds: number[] = [];
  const pending: Array<{ chapter: SplitChapter; existing: any | null }> = [];
  for (const chapter of plan.chapters) {
    const matches = byNumber.get(String(chapter.chapterNumber)) ?? [];
    if (matches.length > 1) {
      issues.push({
        code: "AMBIGUOUS_EXISTING_CHAPTER",
        message: `มีตอนเลข ${chapter.chapterNumber} อยู่แล้วมากกว่าหนึ่งแถว (episodeId ${matches.map((m) => m.id).join(", ")})`,
        chapterNumber: chapter.chapterNumber,
      });
      continue;
    }
    const existing = matches[0] ?? null;
    if (existing && resolveSaleMode(existing) !== "chapter") {
      issues.push({
        code: "EXISTING_NOT_CHAPTER",
        message: `ตอนเลข ${chapter.chapterNumber} ที่มีอยู่ (episodeId ${existing.id}) ไม่ใช่ตอนรายบท`,
        chapterNumber: chapter.chapterNumber,
      });
      continue;
    }
    if (existing) matchedIds.push(existing.id);
    pending.push({ chapter, existing });
  }

  const withBuyers = await episodesWithBuyers(handle, matchedIds);
  const classified: ChapterClassification[] = pending.map(({ chapter, existing }) => {
    if (!existing) {
      return { chapter, action: "create", existingEpisodeId: null, existingHasBuyers: false, existing: null };
    }
    const stored = {
      price: normalizePrice(PRICE_RE.test(String(existing.price ?? "")) ? String(existing.price) : "0"),
      isFree: existing.isFree === true,
      isPublished: existing.isPublished === true,
    };
    const buyersNote = withBuyers.has(existing.id) ? " (มีผู้ซื้อแล้ว)" : "";
    // Byte-exact: an existing row is "the same chapter" only if it already
    // holds exactly the slice that would be written.
    const sameContent = String(existing.content ?? "") === chapter.content;
    if (!sameContent) {
      issues.push({
        code: "EXISTING_CHAPTER_CONFLICT",
        message: `ตอนเลข ${chapter.chapterNumber} ที่มีอยู่ (episodeId ${existing.id}) มีเนื้อหาต่างจากที่แบ่งได้ - จะไม่เขียนทับ${buyersNote}`,
        chapterNumber: chapter.chapterNumber,
      });
    }
    let samePrice = true;
    const requested = prices?.get(chapter.chapterNumber);
    if (sameContent && requested != null) {
      const requestedFree = priceToCents(requested) === 0;
      samePrice = requested === stored.price && requestedFree === stored.isFree;
      if (!samePrice) {
        issues.push({
          code: "EXISTING_CHAPTER_PRICE_CONFLICT",
          message: `ตอนเลข ${chapter.chapterNumber} ที่มีอยู่ (episodeId ${existing.id}) ราคาเดิม ${stored.isFree ? "ฟรี" : `฿${stored.price}`} ไม่ตรงกับราคาที่ขอ ${requestedFree ? "ฟรี" : `฿${requested}`} - จะไม่แก้ราคาให้อัตโนมัติ${buyersNote}`,
          chapterNumber: chapter.chapterNumber,
        });
      }
    }
    return {
      chapter,
      action: sameContent && samePrice ? "keep" : "conflict",
      existingEpisodeId: existing.id,
      existingHasBuyers: withBuyers.has(existing.id),
      existing: stored,
    };
  });
  return { issues, classified };
}

function resolvePricing(
  pricing: SplitPricingInput,
  plan: SplitPlan,
  issues: PreviewIssue[]
): Map<number, string> {
  const prices = new Map<number, string>();
  const base = String(pricing?.chapterPrice ?? "").trim();
  if (!PRICE_RE.test(base)) {
    issues.push({ code: "INVALID_PRICE", message: `ราคาต่อบท "${base}" ไม่ถูกต้อง (ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง)` });
    return prices;
  }
  const overrides = pricing.overrides ?? {};
  const chapterNumbers = new Set(plan.chapters.map((c) => c.chapterNumber));
  for (const [key, raw] of Object.entries(overrides)) {
    const number = Number(key);
    const value = String(raw ?? "").trim();
    if (!Number.isSafeInteger(number) || !chapterNumbers.has(number)) {
      issues.push({ code: "INVALID_PRICE", message: `กำหนดราคาให้บทที่ ${key} ซึ่งไม่อยู่ในแพ็กนี้`, chapterNumber: Number.isSafeInteger(number) ? number : undefined });
      continue;
    }
    if (!PRICE_RE.test(value)) {
      issues.push({ code: "INVALID_PRICE", message: `ราคาบทที่ ${key} "${value}" ไม่ถูกต้อง`, chapterNumber: number });
    }
  }
  for (const chapter of plan.chapters) {
    const override = overrides[String(chapter.chapterNumber)];
    const value = override != null && PRICE_RE.test(String(override).trim()) ? String(override).trim() : base;
    prices.set(chapter.chapterNumber, normalizePrice(value));
  }
  return prices;
}

function canonicalPricing(pricing: SplitPricingInput): { chapterPrice: string; overrides: Array<[string, string]> } {
  const base = String(pricing?.chapterPrice ?? "").trim();
  const overrides = Object.entries(pricing?.overrides ?? {})
    .map(([k, v]) => [String(Number(k)), String(v ?? "").trim()] as [string, string])
    .map(([k, v]) => [k, PRICE_RE.test(v) ? normalizePrice(v) : v] as [string, string])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return { chapterPrice: PRICE_RE.test(base) ? normalizePrice(base) : base, overrides };
}

/**
 * R3: the plan fingerprint that binds preview to apply. Any change to the
 * package identity, its source content (domain hash covers episodeNumber +
 * source sha256), the package price, the pricing options, publish, or the
 * id / state / price / buyers of ANY related existing chapter changes it.
 */
function previewHash(input: {
  pkg: { id: number; novelId: number; episodeNumber: string; price: unknown };
  domainPlanHash: string;
  pricing: SplitPricingInput;
  publish: boolean;
  rows: SplitPreviewRow[];
}): string {
  return sha256Hex(
    JSON.stringify({
      package: [input.pkg.id, input.pkg.novelId, input.pkg.episodeNumber, String(input.pkg.price ?? "")],
      domainPlanHash: input.domainPlanHash,
      pricing: canonicalPricing(input.pricing),
      publish: input.publish,
      rows: input.rows.map((r) => [
        r.chapterNumber,
        r.action,
        r.existingEpisodeId,
        r.price,
        r.isFree,
        r.existingPrice,
        r.existingIsFree,
        r.existingIsPublished,
        r.existingHasBuyers,
      ]),
    })
  );
}

async function buildPreview(
  handle: DbHandle,
  pkg: any,
  pricing: SplitPricingInput,
  publish: boolean
): Promise<SplitPreview> {
  const plan = splitPackageContent({ episodeNumber: pkg.episodeNumber, content: pkg.content });
  const pricingIssues: PreviewIssue[] = [];
  const prices = resolvePricing(pricing, plan, pricingIssues);
  const { issues, classified } = await classifySplit(handle, pkg, plan, prices.size > 0 ? prices : undefined);
  issues.push(...pricingIssues);
  const warnings: string[] = [];

  const rows: SplitPreviewRow[] = classified.map(({ chapter, action, existingEpisodeId, existingHasBuyers, existing }) => {
    // keep -> the STORED price is what stays (never show an unsaved price).
    const price = action === "keep" && existing ? existing.price : prices.get(chapter.chapterNumber) ?? "0.00";
    const isFree = action === "keep" && existing ? existing.isFree : priceToCents(price) === 0;
    return {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      action,
      existingEpisodeId,
      existingHasBuyers,
      existingPrice: existing?.price ?? null,
      existingIsFree: existing ? existing.isFree : null,
      existingIsPublished: existing ? existing.isPublished : null,
      price,
      isFree,
      partCount: chapter.partCount,
      bodyCharCount: chapter.bodyCharCount,
      sourceStart: chapter.sourceStart,
      sourceEnd: chapter.sourceEnd,
      contentSha256: chapter.contentSha256,
    };
  });

  const packagePrice = String(pkg.price ?? "0.00");
  if (rows.length > 0 && prices.size > 0) {
    const sum = rows.reduce((total, r) => total + priceToCents(r.price), 0);
    if (sum < priceToCents(normalizePrice(PRICE_RE.test(packagePrice) ? packagePrice : "0"))) {
      warnings.push(`ราคารวมรายบท (฿${formatCents(sum)}) ต่ำกว่าราคาแพ็ก (฿${packagePrice})`);
    }
  }

  const counts = {
    create: rows.filter((r) => r.action === "create").length,
    keep: rows.filter((r) => r.action === "keep").length,
    conflict: rows.filter((r) => r.action === "conflict").length,
  };
  const applicable = plan.ok && issues.length === 0 && counts.conflict === 0 && rows.length === plan.chapters.length;
  return {
    packageEpisodeId: pkg.id,
    novelId: pkg.novelId,
    episodeNumber: pkg.episodeNumber,
    packageTitle: pkg.title,
    packagePrice,
    publish,
    split: {
      ok: plan.ok,
      range: plan.range,
      planHash: plan.planHash,
      sourceSha256: plan.sourceSha256,
      sourceLength: plan.sourceLength,
      preambleKind: plan.preamble.kind,
      chapterCount: plan.chapters.length,
    },
    rows,
    issues,
    warnings,
    counts,
    applicable,
    planHash:
      applicable && plan.planHash
        ? previewHash({ pkg, domainPlanHash: plan.planHash, pricing, publish, rows })
        : null,
  };
}

/**
 * Read-only preview of splitting package CONTENT that is not (yet) stored -
 * the ZIP import dry run. The existing package row with the same normalized
 * range (if any) is treated as the package itself, exactly like the upsert.
 */
export async function previewPackageSplitForContent(input: {
  novelId: number;
  episodeNumber: string;
  title: string;
  price: string;
  content: string;
  contentFormat?: string;
  pricing: SplitPricingInput;
  publish?: boolean;
}): Promise<SplitPreview> {
  const handle = await requireHandle();
  const novelEpisodes: Array<{ id: number; episodeNumber: string }> = await handle
    .select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
    .from(episodes)
    .where(eq(episodes.novelId, input.novelId));
  const target = normalizeEpisodeRange(input.episodeNumber);
  const existing = novelEpisodes.find((e) => normalizeEpisodeRange(e.episodeNumber) === target);
  const pkg = {
    id: existing?.id ?? -1,
    novelId: input.novelId,
    episodeNumber: input.episodeNumber,
    title: input.title,
    price: input.price,
    content: input.content,
    contentFormat: input.contentFormat ?? "plain_text",
  };
  return buildPreview(handle, pkg, input.pricing, input.publish === true);
}

/** Read-only preview of splitting one package. Never writes. */
export async function previewPackageSplit(input: {
  packageEpisodeId: number;
  pricing: SplitPricingInput;
  publish?: boolean;
}): Promise<SplitPreview> {
  const handle = await requireHandle();
  const pkg = await loadPackage(handle, input.packageEpisodeId, false);
  return buildPreview(handle, pkg, input.pricing, input.publish === true);
}

/**
 * Apply a previewed split in ONE transaction. Refuses with STALE_PLAN if the
 * recomputed plan differs from `planHash`, with PLAN_NOT_APPLICABLE on any
 * issue/conflict. Re-applying an already-applied plan is a no-op apart from
 * creating any still-missing mapping rows.
 */
export async function applyPackageSplit(input: {
  packageEpisodeId: number;
  planHash: string;
  pricing: SplitPricingInput;
  publish?: boolean;
}): Promise<SplitApplyResult> {
  const db = await requireHandle();
  try {
    return await db.transaction(async (tx: DbHandle) => applyPackageSplitInTx(tx, input));
  } catch (error) {
    throw mapApplyError(error);
  }
}

function mapApplyError(error: unknown): unknown {
  if (error instanceof PackageSplitError) return error;
  // A concurrent writer created the same canonical chapter row between our
  // read and insert (unique_novel_episode) or the same mapping row: the plan
  // is stale - the caller must re-preview.
  const code = (error as any)?.code ?? (error as any)?.cause?.code;
  if (code === "ER_DUP_ENTRY") return new PackageSplitError("STALE_PLAN");
  return error;
}

/**
 * The split write path on an EXISTING transaction (the ZIP import runs it
 * inside its single all-or-nothing transaction). `planHash: null` means the
 * caller recomputed and validated the plan inside this very transaction
 * (no preview/apply window to bind); otherwise it must match.
 */
export async function applyPackageSplitInTx(
  tx: DbHandle,
  input: { packageEpisodeId: number; planHash: string | null; pricing: SplitPricingInput; publish?: boolean }
): Promise<SplitApplyResult> {
  const publish = input.publish === true;
  // FIRST statement: lock the package row - concurrent applies of the
  // same package serialize here, and every read below happens after the
  // competing transaction committed.
  const pkg = await loadPackage(tx, input.packageEpisodeId, true);
  const preview = await buildPreview(tx, pkg, input.pricing, publish);
  if (!preview.applicable || !preview.planHash) {
    throw new PackageSplitError("PLAN_NOT_APPLICABLE", preview.issues);
  }
  if (input.planHash !== null && preview.planHash !== input.planHash) {
    throw new PackageSplitError("STALE_PLAN");
  }

  const plan = splitPackageContent({ episodeNumber: pkg.episodeNumber, content: pkg.content });
  const chapterByNumber = new Map(plan.chapters.map((c) => [c.chapterNumber, c]));
  const createdEpisodeIds: number[] = [];
  const keptEpisodeIds: number[] = [];
  const mappingTargets: Array<{ chapterEpisodeId: number; sortOrder: number }> = [];
  const now = new Date();

  for (const row of preview.rows) {
    if (row.action === "keep" && row.existingEpisodeId) {
      keptEpisodeIds.push(row.existingEpisodeId);
      mappingTargets.push({ chapterEpisodeId: row.existingEpisodeId, sortOrder: row.chapterNumber });
      continue;
    }
    const chapter = chapterByNumber.get(row.chapterNumber)!;
    const result: any = await tx.insert(episodes).values({
      novelId: pkg.novelId,
      episodeNumber: String(row.chapterNumber),
      title: chapter.title,
      isFree: row.isFree,
      price: row.price,
      content: chapter.content,
      contentFormat: pkg.contentFormat || "plain_text",
      saleMode: "chapter",
      isPublished: publish,
      publishedAt: publish ? now : null,
      sortOrder: row.chapterNumber,
    });
    const insertId = Number((Array.isArray(result) ? result[0] : result)?.insertId);
    if (!Number.isSafeInteger(insertId) || insertId <= 0) throw new Error("CHAPTER_INSERT_FAILED");
    createdEpisodeIds.push(insertId);
    mappingTargets.push({ chapterEpisodeId: insertId, sortOrder: row.chapterNumber });
  }

  const existingMappings: Array<{ chapterEpisodeId: number }> = await tx
    .select({ chapterEpisodeId: packageChapterMappings.chapterEpisodeId })
    .from(packageChapterMappings)
    .where(eq(packageChapterMappings.packageEpisodeId, pkg.id));
  const mapped = new Set(existingMappings.map((m) => m.chapterEpisodeId));
  const missing = mappingTargets.filter((m) => !mapped.has(m.chapterEpisodeId));
  if (missing.length > 0) {
    await tx.insert(packageChapterMappings).values(
      missing.map((m) => ({
        novelId: pkg.novelId,
        packageEpisodeId: pkg.id,
        chapterEpisodeId: m.chapterEpisodeId,
        sortOrder: m.sortOrder,
        derivation: SPLIT_MAPPING_DERIVATION,
      }))
    );
  }

  return {
    packageEpisodeId: pkg.id,
    createdEpisodeIds,
    keptEpisodeIds,
    mappingsInserted: missing.length,
    planHash: preview.planHash,
  };
}

/** Read-only preview on an existing transaction (ZIP import validation). */
export async function previewPackageSplitInTx(
  tx: DbHandle,
  input: { packageEpisodeId: number; pricing: SplitPricingInput; publish?: boolean }
): Promise<SplitPreview> {
  const pkg = await loadPackage(tx, input.packageEpisodeId, true);
  return buildPreview(tx, pkg, input.pricing, input.publish === true);
}

/**
 * Scan range packages (optionally of one novel) and report their split
 * status. Read-only.
 */
export async function scanLegacyPackages(input: { novelId?: number; limit?: number } = {}): Promise<ScanRow[]> {
  const handle = await requireHandle();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const query = handle.select().from(episodes);
  const rows: any[] = input.novelId ? await query.where(eq(episodes.novelId, input.novelId)) : await query;
  const packages = rows
    .filter((row) => resolveSaleMode(row) === "package" && parseSplitRange(row.episodeNumber) !== null)
    .slice(0, limit);

  const out: ScanRow[] = [];
  for (const pkg of packages) {
    const hasContent = String(pkg.content ?? "").trim().length > 0;
    if (!hasContent) {
      out.push({
        packageEpisodeId: pkg.id,
        novelId: pkg.novelId,
        episodeNumber: pkg.episodeNumber,
        title: pkg.title,
        status: "no_content",
        chapterCount: 0,
        createCount: 0,
        keepCount: 0,
        conflictCount: 0,
        issueCodes: [],
      });
      continue;
    }
    const plan = splitPackageContent({ episodeNumber: pkg.episodeNumber, content: pkg.content });
    const { issues, classified } = await classifySplit(handle, pkg, plan);
    const createCount = classified.filter((c) => c.action === "create").length;
    const keepCount = classified.filter((c) => c.action === "keep").length;
    const conflictCount = classified.filter((c) => c.action === "conflict").length;
    const blocking = issues.filter((i) => i.code !== "EXISTING_CHAPTER_CONFLICT");
    let status: ScanStatus;
    if (blocking.length > 0) status = "needs_attention";
    else if (conflictCount > 0) status = "conflict";
    else if (createCount === 0) {
      const mapped: Array<{ chapterEpisodeId: number }> = await handle
        .select({ chapterEpisodeId: packageChapterMappings.chapterEpisodeId })
        .from(packageChapterMappings)
        .where(
          and(
            eq(packageChapterMappings.packageEpisodeId, pkg.id),
            inArray(
              packageChapterMappings.chapterEpisodeId,
              classified.map((c) => c.existingEpisodeId!).filter(Boolean).concat([-1])
            )
          )
        );
      status = mapped.length === keepCount ? "already_split" : "splittable";
    } else status = "splittable";
    out.push({
      packageEpisodeId: pkg.id,
      novelId: pkg.novelId,
      episodeNumber: pkg.episodeNumber,
      title: pkg.title,
      status,
      chapterCount: plan.chapters.length,
      createCount,
      keepCount,
      conflictCount,
      issueCodes: Array.from(new Set(issues.map((i) => i.code))),
    });
  }
  return out;
}
