import { eq } from "drizzle-orm";
import * as db from "../db";
import { episodes } from "../../drizzle/schema";
import { withCatalogNovelWrite } from "../authz/catalogAccess";
import { normalizeEpisodeRange } from "./readerService";
import { parseSplitRange, splitPackageContent, type SplitPlan } from "./packageChapterSplit.domain";
import * as splitService from "./packageChapterSplit.service";
import {
  PackageSplitError,
  previewPackageSplitForContent,
  type PreviewIssue,
  type SplitPreview,
  type SplitPricingInput,
} from "./packageChapterSplit.service";
import {
  classifyImportRow,
  type PackageImportParseResult,
  type PackageImportRow,
  type PackageImportRowError,
  type PackageImportRowResult,
} from "./packageZipImportService";

/**
 * ZIP import "package + chapters" mode.
 *
 * Package rows flagged splitChapters are split with the SAME fail-closed
 * domain as the legacy backfill. Chapter rows (saleMode=chapter) never create
 * rows on their own: each must match a chapter of a split package in the
 * same ZIP, with identical content - they only override that chapter's
 * price.
 *
 * ATOMIC UNIT = THE WHOLE ZIP (single novel). Every package upsert, every
 * chapter row and every mapping row is written inside ONE transaction
 * (withCatalogNovelWrite: actor + novel locked, authorization re-checked
 * under the lock). Any parse error, planning error, database conflict or
 * split failure aborts that transaction - nothing from the ZIP persists.
 */

export interface ZipSplitPackagePlan {
  row: number;
  episodeNumber: string;
  episodeTitle: string;
  chapterCount: number;
  pricing: SplitPricingInput;
  publish: boolean;
  ok: boolean;
}

export interface ZipSplitPlan {
  packages: ZipSplitPackagePlan[];
  errors: PackageImportRowError[];
}

export interface ZipSplitApplyResult {
  row: number;
  episodeNumber: string;
  packageEpisodeId: number | null;
  applied: boolean;
  createdEpisodeIds: number[];
  keptEpisodeIds: number[];
  message: string;
}

const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * Cross-check normalization for ZIP chapter FILES only. Chapter files are
 * never stored (the stored chapter text is always the exact slice of the
 * package file); they only prove which chapter a price override belongs to.
 * Trailing whitespace is ignored on BOTH sides because a standalone chapter
 * file naturally lacks the blank lines that separate chapters inside a pack.
 */
function crossCheckText(value: string): string {
  return value.replace(/[\s\u00a0]+$/, "");
}

function rowError(row: number, message: string, raw?: { episodeNumber?: string; episodeTitle?: string }): PackageImportRowError {
  return {
    row,
    field: "chapterSplit",
    message,
    episodeNumberRaw: raw?.episodeNumber,
    episodeTitleRaw: raw?.episodeTitle,
  } as PackageImportRowError;
}

/** Pure planning over the parsed ZIP (no database). */
export function planZipChapterSplits(parsed: PackageImportParseResult): ZipSplitPlan {
  const errors: PackageImportRowError[] = [];
  const splitRows = parsed.rows.filter((row) => row.splitChapters === true);
  const plans = new Map<number, { row: PackageImportRow; plan: SplitPlan; overrides: Record<string, string> }>();

  for (const row of splitRows) {
    const plan = splitPackageContent({ episodeNumber: row.episodeNumber, content: row.content });
    for (const issue of plan.issues) {
      errors.push(
        rowError(row.row, `แบ่งบทไม่ผ่าน: ${issue.message}`, { episodeNumber: row.episodeNumber, episodeTitle: row.episodeTitle })
      );
    }
    plans.set(row.row, { row, plan, overrides: {} });
  }

  for (const chapterRow of parsed.chapterRows ?? []) {
    const raw = { episodeNumber: chapterRow.episodeNumber, episodeTitle: chapterRow.episodeTitle };
    const normalized = normalizeEpisodeRange(chapterRow.episodeNumber);
    const number = /^\d+$/.test(normalized) ? Number(normalized) : null;
    if (number === null) {
      errors.push(rowError(chapterRow.row, `แถวรายบทต้องมีเลขบทเดียว (พบ "${chapterRow.episodeNumber}")`, raw));
      continue;
    }
    const covering = Array.from(plans.values()).filter(({ row }) => {
      const range = parseSplitRange(row.episodeNumber);
      return range !== null && number >= range.start && number <= range.end;
    });
    if (covering.length !== 1) {
      errors.push(
        rowError(
          chapterRow.row,
          covering.length === 0
            ? `ไม่พบแพ็กที่ตั้ง splitChapters ครอบบทที่ ${number} ใน ZIP นี้ (ไม่รองรับการนำเข้ารายบทเดี่ยว)`
            : `บทที่ ${number} อยู่ในหลายแพ็กของ ZIP นี้`,
          raw
        )
      );
      continue;
    }
    const target = covering[0];
    const splitChapter = target.plan.chapters.find((c) => c.chapterNumber === number);
    if (!target.plan.ok || !splitChapter) {
      errors.push(rowError(chapterRow.row, `บทที่ ${number} ไม่อยู่ในผลแบ่งบทที่ถูกต้องของแพ็ก "${target.row.episodeNumber}"`, raw));
      continue;
    }
    if (crossCheckText(chapterRow.content) !== crossCheckText(splitChapter.content)) {
      errors.push(
        rowError(chapterRow.row, `เนื้อหาไฟล์รายบทที่ ${number} ไม่ตรงกับเนื้อหาบทนี้ในไฟล์แพ็ก "${target.row.episodeNumber}"`, raw)
      );
      continue;
    }
    const price = chapterRow.isFree ? "0" : String(chapterRow.price ?? "").trim();
    if (!PRICE_RE.test(price)) {
      errors.push(rowError(chapterRow.row, `ราคาบทที่ ${number} "${chapterRow.price}" ไม่ถูกต้อง`, raw));
      continue;
    }
    target.overrides[String(number)] = price;
  }

  const packages: ZipSplitPackagePlan[] = [];
  for (const { row, plan, overrides } of Array.from(plans.values())) {
    const chapterPrice = (row.chapterPrice ?? "").trim();
    const allOverridden = plan.chapters.length > 0 && plan.chapters.every((c) => overrides[String(c.chapterNumber)] != null);
    if (!chapterPrice && !allOverridden) {
      errors.push(
        rowError(row.row, "ต้องระบุ chapterPrice (ราคารายบท) หรือกำหนดราคาให้ทุกบทผ่านแถวรายบท", {
          episodeNumber: row.episodeNumber,
          episodeTitle: row.episodeTitle,
        })
      );
    } else if (chapterPrice && !PRICE_RE.test(chapterPrice)) {
      errors.push(
        rowError(row.row, `chapterPrice "${chapterPrice}" ไม่ถูกต้อง`, { episodeNumber: row.episodeNumber, episodeTitle: row.episodeTitle })
      );
    }
    packages.push({
      row: row.row,
      episodeNumber: row.episodeNumber,
      episodeTitle: row.episodeTitle,
      chapterCount: plan.chapters.length,
      pricing: { chapterPrice: chapterPrice || "0", overrides },
      publish: row.publishChapters === true,
      ok: plan.ok,
    });
  }
  return { packages, errors };
}

/** Dry run: DB-aware split preview per split package (never writes). */
export async function previewZipChapterSplits(
  novelId: number,
  parsed: PackageImportParseResult,
  plan: ZipSplitPlan
): Promise<Array<{ row: number; preview: Omit<SplitPreview, "rows"> & { rowCount: number } }>> {
  const out: Array<{ row: number; preview: Omit<SplitPreview, "rows"> & { rowCount: number } }> = [];
  for (const pkgPlan of plan.packages) {
    const row = parsed.rows.find((r) => r.row === pkgPlan.row)!;
    const preview = await previewPackageSplitForContent({
      novelId,
      episodeNumber: row.episodeNumber,
      title: row.episodeTitle,
      price: row.price,
      content: row.content,
      contentFormat: row.contentFormat,
      pricing: pkgPlan.pricing,
      publish: pkgPlan.publish,
    });
    const { rows, ...rest } = preview;
    out.push({ row: pkgPlan.row, preview: { ...rest, rowCount: rows.length } });
  }
  return out;
}

export class ZipImportAtomicError extends Error {
  readonly row: number | null;
  readonly issues: PreviewIssue[];
  constructor(message: string, row: number | null = null, issues: PreviewIssue[] = []) {
    super(message);
    this.name = "ZipImportAtomicError";
    this.row = row;
    this.issues = issues;
  }
}

export interface AtomicZipImportResult {
  results: PackageImportRowResult[];
  createdCount: number;
  updatedCount: number;
  preservedFileUrlCount: number;
  chapterSplitResults: ZipSplitApplyResult[];
}

/**
 * Package + chapters import, all-or-nothing for the WHOLE ZIP. Callers must
 * have rejected parse errors and planning errors already; this re-validates
 * everything against the database inside the transaction and throws on the
 * first problem (the throw rolls back every write of this ZIP).
 */
export async function importPackageZipWithChapterSplitsAtomic(input: {
  novelId: number;
  parsed: PackageImportParseResult;
  plan: ZipSplitPlan;
  mode: "create_only" | "upsert";
  actorUserId: number;
}): Promise<AtomicZipImportResult> {
  if (input.parsed.errors.length > 0 || input.plan.errors.length > 0) {
    throw new ZipImportAtomicError("ZIP_HAS_ERRORS");
  }
  return withCatalogNovelWrite(input.actorUserId, input.novelId, async (tx) => {
    // Locking read of the novel's episodes: the classification below sees
    // committed state and concurrent writers of these rows wait for us.
    const existingEpisodes = await tx
      .select({ id: episodes.id, episodeNumber: episodes.episodeNumber, fileUrl: episodes.fileUrl })
      .from(episodes)
      .where(eq(episodes.novelId, input.novelId))
      .for("update");

    const results: PackageImportRowResult[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let preservedFileUrlCount = 0;
    const episodeIdByRow = new Map<number, number>();

    for (const row of input.parsed.rows) {
      const classification = classifyImportRow(existingEpisodes, row);
      if (classification.action === "error_ambiguous_match" || classification.action === "error_invalid_range") {
        throw new ZipImportAtomicError(classification.message, row.row);
      }
      if (classification.action === "update_existing") {
        const existing = classification.matchedEpisode;
        if (input.mode === "create_only") {
          throw new ZipImportAtomicError(
            `episodeNumber "${row.episodeNumber}" มีอยู่แล้วในนิยายนี้ (episodeId ${existing.id}, โหมด create only)`,
            row.row
          );
        }
        const hadFileUrl = Boolean(existing.fileUrl && String(existing.fileUrl).trim().length > 0);
        // Never include fileUrl: omitting it preserves a legacy file link.
        await db.updateEpisode(
          existing.id,
          {
            title: row.episodeTitle,
            price: row.price,
            isFree: row.isFree,
            isPublished: row.isPublished,
            saleMode: "package" as const,
            content: row.content,
            contentFormat: row.contentFormat,
            description: row.description,
            sortOrder: row.sortOrder,
          },
          tx
        );
        updatedCount += 1;
        if (hadFileUrl) preservedFileUrlCount += 1;
        episodeIdByRow.set(row.row, existing.id);
        results.push({
          row: row.row,
          episodeNumber: row.episodeNumber,
          action: "updated",
          episodeId: existing.id,
          preservedFileUrl: hadFileUrl,
          message: `${row.episodeNumber}: updated existing episodeId ${existing.id}`,
        });
        continue;
      }
      const created = await db.createEpisode(
        {
          novelId: input.novelId,
          episodeNumber: row.episodeNumber,
          title: row.episodeTitle,
          price: row.price,
          isFree: row.isFree,
          isPublished: row.isPublished,
          saleMode: "package",
          content: row.content,
          contentFormat: row.contentFormat,
          description: row.description,
          sortOrder: row.sortOrder,
        },
        tx
      );
      createdCount += 1;
      episodeIdByRow.set(row.row, created.id);
      existingEpisodes.push({ id: created.id, episodeNumber: row.episodeNumber, fileUrl: null });
      results.push({
        row: row.row,
        episodeNumber: row.episodeNumber,
        action: "created",
        episodeId: created.id,
        preservedFileUrl: false,
        message: `${row.episodeNumber}: created new episodeId ${created.id}`,
      });
    }

    const chapterSplitResults: ZipSplitApplyResult[] = [];
    for (const pkgPlan of input.plan.packages) {
      const packageEpisodeId = episodeIdByRow.get(pkgPlan.row);
      if (packageEpisodeId == null) {
        throw new ZipImportAtomicError("แพ็กที่ต้องแบ่งบทไม่ได้ถูกนำเข้า", pkgPlan.row);
      }
      try {
        // planHash null: the plan is recomputed AND validated inside this
        // very transaction - there is no preview/apply window to bind.
        const applied = await splitService.applyPackageSplitInTx(tx, {
          packageEpisodeId,
          planHash: null,
          pricing: pkgPlan.pricing,
          publish: pkgPlan.publish,
        });
        chapterSplitResults.push({
          row: pkgPlan.row,
          episodeNumber: pkgPlan.episodeNumber,
          packageEpisodeId,
          applied: true,
          createdEpisodeIds: applied.createdEpisodeIds,
          keptEpisodeIds: applied.keptEpisodeIds,
          message: `แบ่งเป็น ${applied.createdEpisodeIds.length + applied.keptEpisodeIds.length} บท (สร้างใหม่ ${applied.createdEpisodeIds.length})`,
        });
      } catch (error) {
        if (error instanceof PackageSplitError) {
          throw new ZipImportAtomicError(
            `แบ่งบทแพ็ก "${pkgPlan.episodeNumber}" ไม่ได้ (${error.code}): ${error.issues.map((i) => i.message).join("; ")}`,
            pkgPlan.row,
            error.issues
          );
        }
        throw error;
      }
    }

    return { results, createdCount, updatedCount, preservedFileUrlCount, chapterSplitResults };
  });
}
