import { and, asc, eq } from "drizzle-orm";
import {
  episodes,
  novels,
  workspaceAuditEvents,
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialEpisodeStages,
  workspaceEditorialStructuralConfirmations,
  workspaceEditorialWorkItems,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { buildNqaPrePublishHygieneGate } from "../nqa/prepublish";
import {
  analyzeEditorialEpisodeDraftBatch,
  buildEditorialEpisodePackPlan,
  EDITORIAL_EPISODE_STAGE_CONTRACT_V3,
  editorialEpisodeReplacementTargetStateSha256,
} from "./editorialApproval.domain";
import {
  WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
  type WorkspacePublishProvider,
  type WorkspacePublishProviderRequest,
  type WorkspacePublishProviderResult,
} from "./publishExecution.domain";

export class IpeNovelWorkspacePublishProviderError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "TARGET_INVALID"
      | "TARGET_NOT_FOUND"
      | "TARGET_CHANGED"
      | "CONTENT_HYGIENE_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "IpeNovelWorkspacePublishProviderError";
  }
}

function receiptFor(request: WorkspacePublishProviderRequest) {
  if (!request.episodeId) {
    throw new IpeNovelWorkspacePublishProviderError(
      "TARGET_INVALID",
      "IpeNovel publish requires an episodeId."
    );
  }
  return `ipenovel:${request.episodeId}:${request.requestKey}`;
}

function parseReceiptMetadata(
  metadataJson: string
): WorkspacePublishProviderResult | undefined {
  try {
    const parsed = JSON.parse(metadataJson) as {
      status?: string;
      providerReceipt?: string;
    };
    if (
      parsed.status === "published" &&
      typeof parsed.providerReceipt === "string" &&
      parsed.providerReceipt.trim()
    ) {
      return {
        status: "published",
        providerReceipt: parsed.providerReceipt.trim(),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function parseEditorialStageItemKey(value: string) {
  const match = value.match(/^editorial-stage:(\d+):episode:(\d+)$/);
  if (!match) return null;
  const stageId = Number(match[1]);
  const episodeId = Number(match[2]);
  return Number.isSafeInteger(stageId) && stageId > 0 &&
    Number.isSafeInteger(episodeId) && episodeId > 0
    ? { stageId, episodeId }
    : null;
}

async function loadEditorialReplacementPlan(tx: any, stage: any) {
  const [workItem] = await tx
    .select()
    .from(workspaceEditorialWorkItems)
    .where(eq(workspaceEditorialWorkItems.id, stage.workItemId))
    .limit(1);
  if (!workItem) {
    throw new IpeNovelWorkspacePublishProviderError(
      "TARGET_CHANGED",
      "Replacement Editorial work item no longer exists."
    );
  }

  const draftTabs = await tx
    .select()
    .from(workspaceEditorialDraftTabs)
    .where(eq(workspaceEditorialDraftTabs.draftId, stage.draftId))
    .orderBy(asc(workspaceEditorialDraftTabs.tabOrder));
  const tabs = [];
  for (const tab of draftTabs) {
    const paragraphs = await tx
      .select({
        paragraphOrder: workspaceEditorialDraftParagraphs.paragraphOrder,
        text: workspaceEditorialDraftParagraphs.text,
      })
      .from(workspaceEditorialDraftParagraphs)
      .where(eq(workspaceEditorialDraftParagraphs.draftTabId, tab.id))
      .orderBy(asc(workspaceEditorialDraftParagraphs.paragraphOrder));
    tabs.push({
      sourceTabId: tab.sourceTabId,
      tabOrder: tab.tabOrder,
      title: tab.title,
      chapterNumber: tab.chapterNumber,
      chapterTitle: tab.chapterTitle,
      paragraphs,
    });
  }

  const confirmedSourceNotes = await tx
    .select({ sourceTabId: workspaceEditorialStructuralConfirmations.sourceTabId })
    .from(workspaceEditorialStructuralConfirmations)
    .where(
      and(
        eq(workspaceEditorialStructuralConfirmations.workItemId, stage.workItemId),
        eq(workspaceEditorialStructuralConfirmations.draftId, stage.draftId),
        eq(workspaceEditorialStructuralConfirmations.anomalyType, "source_note_only"),
        eq(workspaceEditorialStructuralConfirmations.status, "confirmed")
      )
    );
  const batchPlan = analyzeEditorialEpisodeDraftBatch({
    workItemType: workItem.workItemType,
    episodeNumber: workItem.episodeNumber,
    episodeTitle: workItem.episodeTitle,
    confirmedSourceNoteTabIds: confirmedSourceNotes
      .map((row: any) => row.sourceTabId)
      .filter((value: any): value is string => Boolean(value)),
    tabs,
  });
  if (!batchPlan.ready) {
    throw new IpeNovelWorkspacePublishProviderError(
      "TARGET_CHANGED",
      "Replacement Draft no longer resolves to a publishable Episode Pack."
    );
  }
  const plan = buildEditorialEpisodePackPlan(batchPlan);
  if (
    plan.episodeNumber !== stage.episodeNumber ||
    plan.title !== stage.episodeTitle ||
    plan.contentSha256.toLowerCase() !== String(stage.contentSha256).toLowerCase()
  ) {
    throw new IpeNovelWorkspacePublishProviderError(
      "TARGET_CHANGED",
      "Replacement Draft no longer matches immutable stage evidence."
    );
  }
  if (
    (stage.saleMode !== "chapter" && stage.saleMode !== "package") ||
    stage.price === null ||
    typeof stage.isFree !== "boolean"
  ) {
    throw new IpeNovelWorkspacePublishProviderError(
      "TARGET_CHANGED",
      "Replacement stage sale metadata is incomplete."
    );
  }
  return plan;
}

/**
 * Concrete adapter for the existing IpeNovel publication boundary.
 *
 * NQA content hygiene executes before any new reader-visibility mutation.
 * Safe remediation commits in the same transaction as the episode + provider receipt,
 * together with parent-novel visibility. Reconcile keeps the main-line
 * parent-visibility repair behavior for prior receipts.
 */
export function createIpeNovelWorkspacePublishProvider(): WorkspacePublishProvider {
  return {
    mode: "external",
    async reconcile(request) {
      const db = await getDb();
      if (!db) {
        throw new IpeNovelWorkspacePublishProviderError(
          "DATABASE_UNAVAILABLE",
          "IpeNovel database is unavailable."
        );
      }
      const [event] = await db
        .select()
        .from(workspaceAuditEvents)
        .where(
          and(
            eq(workspaceAuditEvents.workspaceId, request.workspaceId),
            eq(
              workspaceAuditEvents.eventType,
              WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT
            ),
            eq(workspaceAuditEvents.correlationId, request.requestKey)
          )
        )
        .limit(1);
      const reconciled = event
        ? parseReceiptMetadata(event.metadataJson)
        : undefined;

      if (reconciled && request.targetType === "novel" && request.episodeId) {
        const [episode] = await db
          .select({
            id: episodes.id,
            novelId: episodes.novelId,
            isPublished: episodes.isPublished,
          })
          .from(episodes)
          .where(eq(episodes.id, request.episodeId))
          .limit(1);
        if (
          episode?.novelId === request.targetId &&
          episode.isPublished === true
        ) {
          await db
            .update(novels)
            .set({ publicationStatus: "published" })
            .where(eq(novels.id, request.targetId));
        }
      }

      return reconciled;
    },

    async execute(request) {
      if (request.targetType !== "novel" || !request.episodeId) {
        throw new IpeNovelWorkspacePublishProviderError(
          "TARGET_INVALID",
          "IpeNovel provider accepts novel destinations with an episodeId only."
        );
      }

      const db = await getDb();
      if (!db) {
        throw new IpeNovelWorkspacePublishProviderError(
          "DATABASE_UNAVAILABLE",
          "IpeNovel database is unavailable."
        );
      }

      const providerReceipt = receiptFor(request);
      return db.transaction(async (tx: any) => {
        const [episode] = await tx
          .select()
          .from(episodes)
          .where(eq(episodes.id, request.episodeId!))
          .limit(1)
          .for("update");

        if (!episode || episode.novelId !== request.targetId) {
          throw new IpeNovelWorkspacePublishProviderError(
            "TARGET_NOT_FOUND",
            "Publish episode does not belong to the destination novel."
          );
        }

        const [existing] = await tx
          .select()
          .from(workspaceAuditEvents)
          .where(
            and(
              eq(workspaceAuditEvents.workspaceId, request.workspaceId),
              eq(
                workspaceAuditEvents.eventType,
                WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT
              ),
              eq(workspaceAuditEvents.correlationId, request.requestKey)
            )
          )
          .limit(1);
        if (existing) {
          const reconciled = parseReceiptMetadata(existing.metadataJson);
          if (reconciled) {
            await tx
              .update(novels)
              .set({ publicationStatus: "published" })
              .where(eq(novels.id, request.targetId));
            return reconciled;
          }
        }

        const editorialIdentity = parseEditorialStageItemKey(request.itemKey);
        let replacementStage: any = null;
        let replacementPlan: Awaited<ReturnType<typeof loadEditorialReplacementPlan>> | null = null;
        if (editorialIdentity && editorialIdentity.episodeId === episode.id) {
          const [stage] = await tx
            .select()
            .from(workspaceEditorialEpisodeStages)
            .where(eq(workspaceEditorialEpisodeStages.id, editorialIdentity.stageId))
            .limit(1);
          if (stage?.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V3) {
            if (
              stage.episodeId !== episode.id ||
              stage.novelId !== request.targetId ||
              String(stage.contentSha256).toLowerCase() !== request.sourceSha256.toLowerCase() ||
              episode.isPublished !== true
            ) {
              throw new IpeNovelWorkspacePublishProviderError(
                "TARGET_CHANGED",
                "Published replacement target no longer matches its Editorial stage."
              );
            }
            const targetStateSha256 = editorialEpisodeReplacementTargetStateSha256({
              novelId: episode.novelId,
              episodeNumber: episode.episodeNumber,
              title: episode.title,
              content: episode.content,
              contentFormat: episode.contentFormat,
              wordCount: episode.wordCount,
              isPublished: episode.isPublished,
              saleMode: episode.saleMode,
              price: episode.price,
              isFree: episode.isFree,
              fileUrl: episode.fileUrl,
              fileSize: episode.fileSize,
              fileMimeType: episode.fileMimeType,
            });
            if (targetStateSha256 !== stage.episodeStateSha256) {
              throw new IpeNovelWorkspacePublishProviderError(
                "TARGET_CHANGED",
                "Published replacement target changed after staging; re-run Stage before publishing."
              );
            }
            replacementStage = stage;
            replacementPlan = await loadEditorialReplacementPlan(tx, stage);
          }
        }

        const hygiene = buildNqaPrePublishHygieneGate({
          content: replacementPlan?.content ?? episode.content,
          contentFormat: replacementPlan?.contentFormat ?? episode.contentFormat,
        });
        if (hygiene.decision !== "READY_FOR_PUBLISH") {
          throw new IpeNovelWorkspacePublishProviderError(
            "CONTENT_HYGIENE_BLOCKED",
            `NQA pre-publish content hygiene blocked episode ${episode.id}: ${hygiene.residualSignals.join(", ")}`
          );
        }

        const episodeUpdate = replacementStage && replacementPlan
          ? {
              title: replacementPlan.title,
              content: hygiene.sanitizedContent,
              contentFormat: replacementPlan.contentFormat,
              wordCount: wordCount(hygiene.sanitizedContent),
              saleMode: replacementStage.saleMode,
              price: replacementStage.price,
              isFree: replacementStage.isFree,
              fileUrl: null,
              fileSize: null,
              fileMimeType: null,
              isPublished: true,
              publishedAt: episode.publishedAt ?? new Date(),
              updatedAt: new Date(),
            }
          : {
              ...(hygiene.remediationApplied
                ? {
                    content: hygiene.sanitizedContent,
                    wordCount: wordCount(hygiene.sanitizedContent),
                  }
                : {}),
              isPublished: true,
              publishedAt: episode.publishedAt ?? new Date(),
            };

        await tx
          .update(episodes)
          .set(episodeUpdate)
          .where(
            and(
              eq(episodes.id, episode.id),
              eq(episodes.novelId, request.targetId)
            )
          );

        await tx
          .update(novels)
          .set({ publicationStatus: "published" })
          .where(eq(novels.id, request.targetId));

        await tx.insert(workspaceAuditEvents).values({
          workspaceId: request.workspaceId,
          actorUserId: null,
          eventType: WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
          entityType: "episode",
          entityId: String(episode.id),
          correlationId: request.requestKey,
          metadataJson: JSON.stringify({
            contract: WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
            status: "published",
            providerReceipt,
            publishRunId: request.publishRunId,
            destinationId: request.destinationId,
            itemKey: request.itemKey,
            episodeId: episode.id,
            sourceSha256: request.sourceSha256.toLowerCase(),
            editorialReplacement: replacementStage
              ? {
                  stageId: replacementStage.id,
                  stageContract: replacementStage.stageContract,
                  preservedEpisodeId: true,
                  replacedPublishedEpisode: true,
                  previousStateSha256: replacementStage.episodeStateSha256,
                }
              : null,
            nqaPrePublishHygiene: {
              version: hygiene.version,
              decision: hygiene.decision,
              artifactFingerprint: hygiene.artifactFingerprint,
              originalSha256: hygiene.originalSha256,
              sanitizedSha256: hygiene.sanitizedSha256,
              remediationApplied: hygiene.remediationApplied,
              removedChars: hygiene.removedChars,
              removalReasons: hygiene.removalReasons,
              residualSignals: hygiene.residualSignals,
            },
          }),
        });

        return { status: "published", providerReceipt } as const;
      });
    },
  };
}
