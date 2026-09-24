import { and, asc, eq, inArray } from "drizzle-orm";
import {
  adminGiftEntitlements,
  episodePurchases,
  episodes,
  novels,
  purchases,
  workspaceAuditEvents,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import { normalizeEditorialSaleMetadata } from "./editorialBoard.service";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import { requirePreviewPublishExecutionSafety } from "./publishExecution.runtime";

export class WorkspaceHistoricalPackRepairError extends Error {
  constructor(readonly code: "DATABASE_UNAVAILABLE" | "WORK_ITEM_NOT_FOUND" | "REPAIR_NOT_SAFE", message: string) {
    super(message);
    this.name = "WorkspaceHistoricalPackRepairError";
  }
}

function parseSpan(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start || end - start > 5000) return null;
  return { start, end };
}

function singleEpisodeNumber(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^\d+$/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function getHistoricalPackRepairPreview(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
}) {
  const db = await getDb();
  if (!db) throw new WorkspaceHistoricalPackRepairError("DATABASE_UNAVAILABLE", "Database is unavailable.");
  await requireWorkspacePlatformAdmin(db, input.actorUserId);

  const [context] = await db
    .select({
      workItem: workspaceEditorialWorkItems,
      workspaceNovel: workspaceNovels,
    })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
    .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
    .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
    .where(and(
      eq(workspaceEditorialWorkItems.id, input.workItemId),
      eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
      eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
      eq(workspaceNovels.workspaceId, input.workspaceId),
    ))
    .limit(1);

  if (!context || context.workItem.workItemType !== "new_episode") {
    throw new WorkspaceHistoricalPackRepairError("WORK_ITEM_NOT_FOUND", "Episode Pack work item was not found in this Workspace.");
  }

  const span = parseSpan(context.workItem.episodeNumber);
  if (!span) {
    return {
      workItemId: input.workItemId,
      novelId: context.workspaceNovel.novelId,
      requestedEpisodeNumber: context.workItem.episodeNumber,
      repairReady: false,
      blockers: ["WORK_ITEM_RANGE_INVALID"] as string[],
      publishedChapterEpisodeIds: [] as number[],
      existingPackageEpisodeId: null as number | null,
      entitlementCount: 0,
    };
  }

  const published = await db
    .select({
      id: episodes.id,
      episodeNumber: episodes.episodeNumber,
      saleMode: episodes.saleMode,
      price: episodes.price,
      isFree: episodes.isFree,
      title: episodes.title,
      isPublished: episodes.isPublished,
    })
    .from(episodes)
    .where(and(eq(episodes.novelId, context.workspaceNovel.novelId), eq(episodes.isPublished, true)))
    .orderBy(asc(episodes.id));

  const existingPackage = published.find(row => {
    if (row.saleMode !== "package") return false;
    const candidate = parseSpan(row.episodeNumber);
    return candidate?.start === span.start && candidate?.end === span.end;
  }) ?? null;

  const legacyChapters = published.filter(row => {
    if (row.saleMode !== "chapter") return false;
    const number = singleEpisodeNumber(row.episodeNumber);
    return number !== null && number >= span.start && number <= span.end;
  });
  const byNumber = new Map<number, typeof legacyChapters>();
  for (const row of legacyChapters) {
    const number = singleEpisodeNumber(row.episodeNumber)!;
    const bucket = byNumber.get(number) ?? [];
    bucket.push(row);
    byNumber.set(number, bucket);
  }
  const expectedNumbers = Array.from({ length: span.end - span.start + 1 }, (_, index) => span.start + index);
  const exactCoverage =
    legacyChapters.length === expectedNumbers.length &&
    expectedNumbers.every(number => byNumber.get(number)?.length === 1);

  const chapterIds = legacyChapters.map(row => row.id);
  let entitlementCount = 0;
  if (chapterIds.length) {
    const [walletRows, orderRows, giftRows] = await Promise.all([
      db.select({ id: episodePurchases.id }).from(episodePurchases).where(inArray(episodePurchases.episodeId, chapterIds)),
      db.select({ id: purchases.id }).from(purchases).where(inArray(purchases.episodeId, chapterIds)),
      db.select({ id: adminGiftEntitlements.id }).from(adminGiftEntitlements).where(inArray(adminGiftEntitlements.episodeId, chapterIds)),
    ]);
    entitlementCount = walletRows.length + orderRows.length + giftRows.length;
  }

  const numericPrice = context.workItem.price === null ? Number.NaN : Number(context.workItem.price);
  const saleMetadataValid =
    context.workItem.saleMode === "package" &&
    typeof context.workItem.isFree === "boolean" &&
    context.workItem.price !== null &&
    Number.isFinite(numericPrice) &&
    (context.workItem.isFree ? context.workItem.price === "0.00" : numericPrice > 0);

  const blockers: string[] = [];
  if (existingPackage) blockers.push("PACKAGE_ALREADY_EXISTS");
  if (!saleMetadataValid) blockers.push("SALE_METADATA_MISSING_OR_INVALID");
  if (!exactCoverage) blockers.push("LEGACY_CHAPTER_COVERAGE_MISMATCH");
  if (entitlementCount > 0) blockers.push("LEGACY_CHAPTER_ENTITLEMENTS_PRESENT");

  return {
    workItemId: input.workItemId,
    novelId: context.workspaceNovel.novelId,
    requestedEpisodeNumber: context.workItem.episodeNumber,
    expectedChapterCount: expectedNumbers.length,
    publishedChapterCount: legacyChapters.length,
    publishedChapterEpisodeIds: chapterIds,
    existingPackageEpisodeId: existingPackage?.id ?? null,
    entitlementCount,
    saleMetadata: {
      saleMode: context.workItem.saleMode,
      price: context.workItem.price,
      isFree: context.workItem.isFree,
    },
    repairReady: blockers.length === 0,
    blockers,
  };
}

function headingForLegacyChapter(episodeNumber: string, title: string, content: string) {
  const number = singleEpisodeNumber(episodeNumber);
  const body = content.trim();
  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  const headingPattern = /^(?:บทที่|ตอนที่|chapter\s*|#\s*)\s*(\d+(?:\.\d+)?)/i;
  const match = firstLine.match(headingPattern);
  if (number !== null && match && Number(match[1]) === number) return body;
  const cleanTitle = title.trim();
  const heading = number === null
    ? cleanTitle
    : `บทที่ ${number}${cleanTitle ? ` ${cleanTitle}` : ""}`;
  return `${heading}\n\n${body}`.trim();
}

export async function repairHistoricalPublishedPack(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedChapterEpisodeIds: number[];
  price: string;
  isFree: boolean;
}) {
  requirePreviewPublishExecutionSafety();
  const db = await getDb();
  if (!db) throw new WorkspaceHistoricalPackRepairError("DATABASE_UNAVAILABLE", "Database is unavailable.");
  await requireWorkspacePlatformAdmin(db, input.actorUserId);

  const preview = await getHistoricalPackRepairPreview({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workItemId: input.workItemId,
  });
  const structuralBlockers = preview.blockers.filter(blocker => blocker !== "SALE_METADATA_MISSING_OR_INVALID");
  if (structuralBlockers.length) {
    throw new WorkspaceHistoricalPackRepairError(
      "REPAIR_NOT_SAFE",
      `Historical Episode Pack repair is blocked: ${structuralBlockers.join(", ")}`
    );
  }
  const expectedIds = Array.from(new Set(input.expectedChapterEpisodeIds)).sort((a, b) => a - b);
  const previewIds = [...preview.publishedChapterEpisodeIds].sort((a, b) => a - b);
  if (
    expectedIds.length === 0 ||
    expectedIds.length !== previewIds.length ||
    expectedIds.some((id, index) => id !== previewIds[index])
  ) {
    throw new WorkspaceHistoricalPackRepairError(
      "REPAIR_NOT_SAFE",
      "Historical repair chapter IDs changed after preview; refresh the preview before retrying."
    );
  }
  const sale = normalizeEditorialSaleMetadata({
    saleMode: "package",
    price: input.isFree ? "0.00" : input.price,
    isFree: input.isFree,
  });

  return db.transaction(async (tx: any) => {
    const [context] = await tx
      .select({
        workItem: workspaceEditorialWorkItems,
        workspaceNovel: workspaceNovels,
      })
      .from(workspaceEditorialWorkItems)
      .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
      .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
      .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
      .where(and(
        eq(workspaceEditorialWorkItems.id, input.workItemId),
        eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
        eq(workspaceNovels.workspaceId, input.workspaceId),
      ))
      .limit(1)
      .for("update");
    if (!context || context.workItem.workItemType !== "new_episode") {
      throw new WorkspaceHistoricalPackRepairError("WORK_ITEM_NOT_FOUND", "Episode Pack work item was not found.");
    }
    const span = parseSpan(context.workItem.episodeNumber);
    if (!span) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Workspace Episode Pack range is invalid.");
    }

    const chapterRows = await tx
      .select({
        id: episodes.id,
        novelId: episodes.novelId,
        episodeNumber: episodes.episodeNumber,
        title: episodes.title,
        content: episodes.content,
        contentFormat: episodes.contentFormat,
        wordCount: episodes.wordCount,
        sortOrder: episodes.sortOrder,
        publishedAt: episodes.publishedAt,
        saleMode: episodes.saleMode,
        isPublished: episodes.isPublished,
      })
      .from(episodes)
      .where(and(
        eq(episodes.novelId, context.workspaceNovel.novelId),
        inArray(episodes.id, expectedIds),
      ))
      .for("update");

    const ordered = [...chapterRows].sort((a, b) =>
      (singleEpisodeNumber(a.episodeNumber) ?? Number.MAX_SAFE_INTEGER) -
      (singleEpisodeNumber(b.episodeNumber) ?? Number.MAX_SAFE_INTEGER)
    );
    const expectedNumbers = Array.from({ length: span.end - span.start + 1 }, (_, index) => span.start + index);
    const exactCoverage =
      ordered.length === expectedNumbers.length &&
      ordered.every((row, index) =>
        row.novelId === context.workspaceNovel.novelId &&
        row.saleMode === "chapter" &&
        row.isPublished === true &&
        singleEpisodeNumber(row.episodeNumber) === expectedNumbers[index]
      );
    if (!exactCoverage) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Published legacy chapter coverage changed during repair.");
    }
    if (ordered.some(row => !row.content?.trim())) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "A legacy chapter has no web-reader content; automatic package repair is unsafe.");
    }
    if (ordered.some(row => row.contentFormat && row.contentFormat !== "plain_text")) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Legacy chapter content format is not plain_text; automatic package repair is unsafe.");
    }

    const [walletRows, orderRows, giftRows] = await Promise.all([
      tx.select({ id: episodePurchases.id }).from(episodePurchases).where(inArray(episodePurchases.episodeId, expectedIds)),
      tx.select({ id: purchases.id }).from(purchases).where(inArray(purchases.episodeId, expectedIds)),
      tx.select({ id: adminGiftEntitlements.id }).from(adminGiftEntitlements).where(inArray(adminGiftEntitlements.episodeId, expectedIds)),
    ]);
    if (walletRows.length || orderRows.length || giftRows.length) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Legacy chapter entitlements appeared during repair; refusing to change publication rows.");
    }

    const packageRows = await tx.select({ id: episodes.id, episodeNumber: episodes.episodeNumber })
      .from(episodes)
      .where(and(eq(episodes.novelId, context.workspaceNovel.novelId), eq(episodes.saleMode, "package")))
      .for("update");
    const equivalentPackage = packageRows.find((row: any) => {
      const candidate = parseSpan(row.episodeNumber);
      return candidate?.start === span.start && candidate?.end === span.end;
    });
    if (equivalentPackage) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Equivalent Episode Pack already exists.");
    }

    const packageContent = ordered
      .map(row => headingForLegacyChapter(row.episodeNumber, row.title, row.content!))
      .join("\n\n");
    const wordCount = ordered.reduce((sum, row) => {
      if (typeof row.wordCount === "number" && row.wordCount >= 0) return sum + row.wordCount;
      return sum + (row.content?.trim().split(/\s+/).filter(Boolean).length ?? 0);
    }, 0);
    const sortOrders = ordered.map(row => row.sortOrder).filter((value): value is number => typeof value === "number");
    const firstPublishedAt = ordered.map(row => row.publishedAt).find(Boolean) ?? new Date();

    const insertResult = await tx.insert(episodes).values({
      novelId: context.workspaceNovel.novelId,
      episodeNumber: context.workItem.episodeNumber!.trim(),
      title: context.workItem.episodeTitle?.trim() || `แพ็กตอน ${context.workItem.episodeNumber!.trim()}`,
      content: packageContent,
      contentFormat: "plain_text",
      saleMode: "package",
      price: sale.price,
      isFree: sale.isFree,
      isPublished: true,
      publishedAt: firstPublishedAt,
      wordCount,
      sortOrder: sortOrders.length ? Math.min(...sortOrders) : null,
    });
    const packageEpisodeId = Number(insertResult?.[0]?.insertId ?? insertResult?.insertId);
    if (!Number.isInteger(packageEpisodeId) || packageEpisodeId <= 0) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Package repair insert could not be verified.");
    }

    const unpublish = await tx.update(episodes)
      .set({ isPublished: false })
      .where(and(eq(episodes.novelId, context.workspaceNovel.novelId), inArray(episodes.id, expectedIds)));
    const affected = Number(unpublish?.[0]?.affectedRows ?? unpublish?.affectedRows ?? 0);
    if (affected !== expectedIds.length) {
      throw new WorkspaceHistoricalPackRepairError("REPAIR_NOT_SAFE", "Legacy chapters changed concurrently; repair was rolled back.");
    }

    await tx.update(workspaceEditorialWorkItems).set({
      saleMode: "package",
      price: sale.price,
      isFree: sale.isFree,
    }).where(eq(workspaceEditorialWorkItems.id, input.workItemId));
    await tx.update(novels).set({ publicationStatus: "published" }).where(eq(novels.id, context.workspaceNovel.novelId));
    await tx.insert(workspaceAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "workspace_historical_pack_repaired_v1",
      entityType: "episode",
      entityId: String(packageEpisodeId),
      correlationId: `historical-pack-repair:${input.workItemId}:${packageEpisodeId}`,
      metadataJson: JSON.stringify({
        workItemId: input.workItemId,
        novelId: context.workspaceNovel.novelId,
        packageEpisodeId,
        legacyChapterEpisodeIds: expectedIds,
        episodeNumber: context.workItem.episodeNumber,
        saleMode: "package",
        price: sale.price,
        isFree: sale.isFree,
      }),
    });

    return {
      repaired: true as const,
      workItemId: input.workItemId,
      novelId: context.workspaceNovel.novelId,
      packageEpisodeId,
      unpublishedLegacyChapterCount: expectedIds.length,
      saleMode: "package" as const,
      price: sale.price,
      isFree: sale.isFree,
    };
  });
}
