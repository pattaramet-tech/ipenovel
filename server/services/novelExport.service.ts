/**
 * IPE-059-A — Novel export service.
 *
 * Source authority: canonical persisted/published content only —
 * `episodes.isPublished === true` and the same inline `episodes.content`
 * the web reader loads (`readerService.getReaderEpisode`). Never reads
 * Workspace Drafts, editor buffers, Checker/QC/Approval/Stage state.
 *
 * This layer owns: admin-facing novel/episode resolution, bounded
 * selection enforcement, DB-row → pure-domain mapping (sale metadata via
 * the repo's own `resolveSaleMode`), resource limits and audit logging.
 * All serialization lives in the pure `novelExport.domain` module.
 */

import * as db from "../db";
import { resolveSaleMode } from "./readerService";
import {
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_PER_ITEM_BYTES,
  MAX_EXPORT_TOTAL_BYTES,
  NovelExportError,
  NovelExportItem,
  NovelExportPackage,
  SerializedTxtExport,
  SerializedZipExport,
  buildNovelExportZip,
  normalizeExportText,
  parseExportEpisodeIdentity,
  serializeNovelExportTxt,
  sortExportItemsCanonical,
} from "./novelExport.domain";
import {
  assertNoCrossPackChapterCollisions,
  ThaiNovelExportEntry,
  ThaiNovelExportOptions,
  ThaiNovelPreviewEntry,
  buildThaiNovelExportEntries,
  buildThaiNovelExportZip,
  buildThaiNovelPreviewRows,
} from "./thaiNovelExport.domain";

export { MAX_EXPORT_ITEMS, MAX_EXPORT_PER_ITEM_BYTES, MAX_EXPORT_TOTAL_BYTES, NovelExportError };

export interface ExportSelection {
  novelId: number;
  /** Explicit bounded subset; omit/empty array is NOT broadened to the whole novel. */
  episodeIds?: number[];
}

export interface ExportSkippedItem {
  episodeId: number;
  episodeNumber: string;
  title: string;
  reason: "MISSING_CONTENT";
}

/** Bounded published-episode metadata for UI scope selectors (no content). */
export interface ExportPublishedEpisodeSummary {
  episodeId: number;
  episodeNumber: string;
  title: string;
}

export interface NovelExportPreview {
  novelId: number;
  novelTitle: string;
  mode: "whole_novel" | "explicit_subset";
  publishedEpisodeCount: number;
  exportItemCount: number;
  skippedItems: ExportSkippedItem[];
  estimatedPlaintextBytes: number;
  filenames: string[];
  limits: {
    maxItems: number;
    maxPerItemBytes: number;
    maxTotalBytes: number;
  };
}

/** DB episode row shape actually used by the export mapper. */
interface ExportableEpisodeRow {
  id: number;
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  price: string | number | null;
  isFree: boolean;
  isPublished: boolean | null;
  contentFormat: string | null;
  sortOrder: number | null;
  saleMode: string | null;
  fileUrl: string | null;
  description?: string | null;
}

function normalizePrice(price: string | number | null | undefined): string {
  if (price === null || price === undefined || price === "") return "0.00";
  return String(price);
}

function normalizeContentFormat(contentFormat: string | null | undefined): "plain_text" | "markdown" | "html" {
  return contentFormat === "markdown" || contentFormat === "html" ? contentFormat : "plain_text";
}

function mapEpisodeToExportItem(episode: ExportableEpisodeRow): NovelExportItem {
  return {
    episodeId: episode.id,
    episodeNumber: String(episode.episodeNumber ?? ""),
    episodeTitle: String(episode.title ?? ""),
    content: String(episode.content ?? ""),
    price: normalizePrice(episode.price),
    isFree: Boolean(episode.isFree),
    saleMode: resolveSaleMode(episode),
    contentFormat: normalizeContentFormat(episode.contentFormat),
    sortOrder: episode.sortOrder ?? null,
    description: episode.description ? String(episode.description) : null,
  };
}

/**
 * Resolve and validate the export selection against the DB and build the
 * pure-domain package. Enforces: single novel, published episodes only,
 * explicit-subset ownership/known-id/duplicate rules, and a documented
 * missing-content policy (whole-novel: skip + report; explicit subset:
 * fail closed).
 */
export async function buildNovelExportPackage(selection: ExportSelection): Promise<{
  pkg: NovelExportPackage;
  skippedItems: ExportSkippedItem[];
  publishedEpisodeSummaries: ExportPublishedEpisodeSummary[];
  /** IPE-064R4B: every published episode with content (subset collision
   * validation must see outside the selected subset). */
  allPublishedItems: NovelExportItem[];
}> {
  const novel = await db.getNovelById(selection.novelId, false);
  if (!novel) {
    throw new NovelExportError("EXPORT_NOVEL_NOT_FOUND", `ไม่พบนิยาย id ${selection.novelId}`, {
      novelId: selection.novelId,
    });
  }

  const allEpisodes = (await db.getEpisodesByNovelId(selection.novelId)) as ExportableEpisodeRow[];
  const publishedEpisodes = allEpisodes.filter((episode) => episode.isPublished === true);

  const byId = new Map(allEpisodes.map((episode) => [episode.id, episode]));
  let selected: ExportableEpisodeRow[];

  if (selection.episodeIds && selection.episodeIds.length > 0) {
    const requested = [...selection.episodeIds];

    const duplicates = requested.filter((id, index) => requested.indexOf(id) !== index);
    if (duplicates.length > 0) {
      throw new NovelExportError(
        "EXPORT_DUPLICATE_SELECTION",
        `ระบุ episodeId ซ้ำในคำขอเดียวกัน (${duplicates.slice(0, 5).join(", ")})`,
        { duplicateEpisodeIds: duplicates.slice(0, 5).join(",") }
      );
    }

    for (const id of requested) {
      const episode = byId.get(id);
      if (!episode) {
        throw new NovelExportError("EXPORT_UNKNOWN_EPISODE", `ไม่พบ episodeId ${id}`, { episodeId: id });
      }
      if (episode.novelId !== selection.novelId) {
        throw new NovelExportError(
          "EXPORT_EPISODE_NOT_IN_NOVEL",
          `episodeId ${id} ไม่ได้อยู่ในนิยาย id ${selection.novelId}`,
          { episodeId: id, novelId: selection.novelId }
        );
      }
    }

    // Preserve subset semantics exactly: unknown/unpublished/empty members
    // fail closed below instead of silently shrinking the subset.
    selected = requested
      .map((id) => byId.get(id)!)
      .filter((episode) => episode.isPublished === true);

    if (selected.length !== requested.length) {
      const unpublished = requested.filter((id) => byId.get(id) && byId.get(id)!.isPublished !== true);
      throw new NovelExportError(
        "EXPORT_EPISODE_MISSING_CONTENT",
        `episodeId ที่เลือกไม่ใช่ตอนที่เผยแพร่ (${unpublished.slice(0, 5).join(", ")})`,
        { episodeIds: unpublished.slice(0, 5).join(",") }
      );
    }
  } else {
    selected = publishedEpisodes;
  }

  // Missing-content policy: whole-novel exports skip-and-report legacy
  // file-only / empty rows (historical data may legitimately lack inline
  // content); explicit subsets fail closed so a requested item never
  // silently disappears from the output.
  const skippedItems: ExportSkippedItem[] = [];
  const exportable: NovelExportItem[] = [];
  for (const episode of selected) {
    if (!episode.content || !String(episode.content).trim()) {
      if (selection.episodeIds && selection.episodeIds.length > 0) {
        throw new NovelExportError(
          "EXPORT_EPISODE_MISSING_CONTENT",
          `episodeId ${episode.id} ไม่มีเนื้อหา canonical ให้ export`,
          { episodeId: episode.id }
        );
      }
      skippedItems.push({
        episodeId: episode.id,
        episodeNumber: String(episode.episodeNumber ?? ""),
        title: String(episode.title ?? ""),
        reason: "MISSING_CONTENT",
      });
      continue;
    }
    exportable.push(mapEpisodeToExportItem(episode));
  }

  // IPE-064R4B (P2): every published episode — content or not — the collision
  // identity for chapter exports is validated against the WHOLE novel, not
  // just the selected subset, so an overrunning pack cannot double-export
  // chapters of a following pack through a per-pack subset. A legacy
  // contentless row still occupies its DECLARED episodeNumber here (the
  // round-22 review): the MISSING_CONTENT skip policy keeps it out of the
  // ZIP output, but its declared identity must fence the collision check.
  const allPublishedItems = publishedEpisodes.map((episode) =>
    mapEpisodeToExportItem(episode)
  );

  return {
    pkg: {
      novelId: selection.novelId,
      novelTitle: String(novel.title ?? ""),
      items: exportable,
    },
    allPublishedItems,
    skippedItems,
    publishedEpisodeSummaries: publishedEpisodes.map((episode) => ({
      episodeId: episode.id,
      episodeNumber: String(episode.episodeNumber ?? ""),
      title: String(episode.title ?? ""),
    })),
  };
}

function logExportAudit(action: string, novelId: number, itemCount: number, byteCount: number): void {
  // Bounded audit metadata only - never exported novel text.
  console.log(`[Admin] novelExport.${action} novelId=${novelId} items=${itemCount} bytes=${byteCount}`);
}

export async function buildNovelExportPreview(selection: ExportSelection): Promise<NovelExportPreview> {
  const { pkg, skippedItems } = await buildNovelExportPackage(selection);
  const items = sortExportItemsCanonical(pkg.items);

  return {
    novelId: pkg.novelId,
    novelTitle: pkg.novelTitle,
    mode: selection.episodeIds && selection.episodeIds.length > 0 ? "explicit_subset" : "whole_novel",
    publishedEpisodeCount: items.length + skippedItems.length,
    exportItemCount: items.length,
    skippedItems,
    estimatedPlaintextBytes: items.reduce((sum, item) => sum + Buffer.byteLength(normalizeExportText(item.content), "utf8"), 0),
    filenames: items
      .map((item) => {
        const identity = parseExportEpisodeIdentity(item.episodeNumber);
        if (!identity) return null;
        return identity.kind === "single"
          ? `${String(identity.start).padStart(3, "0")}.txt`
          : `${String(identity.start).padStart(3, "0")}-${String(identity.end).padStart(3, "0")}.txt`;
      })
      .filter((name): name is string => name !== null),
    limits: {
      maxItems: MAX_EXPORT_ITEMS,
      maxPerItemBytes: MAX_EXPORT_PER_ITEM_BYTES,
      maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
    },
  };
}

export async function buildNovelTxtExport(novelId: number, episodeId: number): Promise<SerializedTxtExport & { episodeTitle: string; novelTitle: string }> {
  const { pkg } = await buildNovelExportPackage({ novelId, episodeIds: [episodeId] });
  const item = pkg.items[0];
  const serialized = serializeNovelExportTxt(item);
  logExportAudit("txt", novelId, 1, serialized.content.length);
  return { ...serialized, episodeTitle: item.episodeTitle, novelTitle: pkg.novelTitle };
}

export async function buildNovelZipExport(
  selection: ExportSelection
): Promise<SerializedZipExport & { novelTitle: string; skippedItems: ExportSkippedItem[] }> {
  const { pkg, skippedItems } = await buildNovelExportPackage(selection);
  const serialized = buildNovelExportZip(pkg);
  logExportAudit("zip", selection.novelId, serialized.itemCount, serialized.content.length);
  return {
    ...serialized,
    novelTitle: pkg.novelTitle,
    skippedItems,
  };
}

// ============ IPE-059-B: Thai-Novel upload export ============
// Same canonical published source authority and selection semantics as A;
// only the serialization target differs (flat upload-ready TXT files).

export interface ThaiNovelExportPreview {
  novelId: number;
  novelTitle: string;
  mode: "whole_novel" | "explicit_subset";
  sourceEpisodes: ExportPublishedEpisodeSummary[];
  entries: ThaiNovelPreviewEntry[];
  skippedItems: ExportSkippedItem[];
  /**
   * IPE-064R3: set when a WHOLE-novel selection expands past
   * MAX_EXPORT_ITEMS. The preview still returns sourceEpisodes so the
   * operator can pick a per-pack subset (the old behavior threw and made
   * over-500-chapter novels un-exportable); the ZIP download keeps failing
   * closed for over-limit selections.
   */
  overLimit: { itemCount: number; maxItems: number } | null;
  validationError: { code: string; message: string } | null;
  limits: {
    maxItems: number;
    maxPerItemBytes: number;
    maxTotalBytes: number;
  };
}

export async function buildThaiNovelExportPreview(
  selection: ExportSelection,
  options?: ThaiNovelExportOptions
): Promise<ThaiNovelExportPreview> {
  const { pkg, skippedItems, publishedEpisodeSummaries, allPublishedItems } = await buildNovelExportPackage(selection);
  const isWholeSelection = !selection.episodeIds || selection.episodeIds.length === 0;
  // IPE-064R4B (P2): validation scope — whole-novel requests fail closed on
  // ANY published defect (surfaced as flags so sourceEpisodes still loads);
  // explicit subsets are validated against their own selected items only,
  // so unrelated unselected defects never block a valid per-pack export.
  const selectedItemIds = isWholeSelection
    ? null
    : new Set(selection.episodeIds ?? []); !selection.episodeIds || selection.episodeIds.length === 0;
  let entries: ThaiNovelExportEntry[];
  let overLimit: { itemCount: number; maxItems: number } | null = null;
  let validationError: { code: string; message: string } | null = null;
  try {
    // IPE-064R4B (P2): the full-set collision check runs here (not just in
    // the ZIP) so the preview can SURFACE defects — and for a whole-novel
    // request it must NOT hard-fail the response, or the subset selector
    // (sourceEpisodes) never loads and the operator cannot export any
    // per-pack subset around the defect.
    assertNoCrossPackChapterCollisions(allPublishedItems, selectedItemIds);
    entries = buildThaiNovelExportEntries(pkg, options);
  } catch (error) {
    if (
      isWholeSelection &&
      error instanceof NovelExportError &&
      (error.code === "EXPORT_LIMIT_ITEMS" ||
        error.code === "EXPORT_INVALID_EPISODE_IDENTITY" ||
        error.code === "EXPORT_INVALID_SALE_METADATA" ||
        error.code === "EXPORT_LIMIT_ENTRY_BYTES" ||
        error.code === "EXPORT_LIMIT_TOTAL_BYTES")
    ) {
      overLimit =
        error.code === "EXPORT_LIMIT_ITEMS"
          ? {
              itemCount: Number(error.details?.itemCount ?? 0),
              maxItems: Number(error.details?.maxItems ?? MAX_EXPORT_ITEMS),
            }
          : null;
      validationError = { code: error.code, message: error.message };
      entries = [];
    } else {
      throw error;
    }
  }

  return {
    novelId: pkg.novelId,
    novelTitle: pkg.novelTitle,
    mode: isWholeSelection ? "whole_novel" : "explicit_subset",
    sourceEpisodes: publishedEpisodeSummaries,
    entries: overLimit ? [] : buildThaiNovelPreviewRows(entries),
    skippedItems,
    overLimit,
    validationError,
    limits: {
      maxItems: MAX_EXPORT_ITEMS,
      maxPerItemBytes: MAX_EXPORT_PER_ITEM_BYTES,
      maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
    },
  };
}

export async function buildThaiNovelZipExport(
  selection: ExportSelection,
  options?: ThaiNovelExportOptions
): Promise<ReturnType<typeof buildThaiNovelExportZip> & { novelTitle: string; skippedItems: ExportSkippedItem[] }> {
  const { pkg, skippedItems, allPublishedItems } = await buildNovelExportPackage(selection);
  assertNoCrossPackChapterCollisions(
    allPublishedItems,
    selection.episodeIds && selection.episodeIds.length > 0 ? new Set(selection.episodeIds) : null
  );
  const serialized = buildThaiNovelExportZip(pkg, options);
  logExportAudit("thainovel-zip", selection.novelId, serialized.itemCount, serialized.content.length);
  return {
    ...serialized,
    novelTitle: pkg.novelTitle,
    skippedItems,
  };
}
