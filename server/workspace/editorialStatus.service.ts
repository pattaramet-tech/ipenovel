import { and, eq, inArray } from "drizzle-orm";
import { episodes, workspaceEditorialWorkItems, workspaceNovels } from "../../drizzle/schema";
import { getDb } from "../db";
import { getEditorialApprovalReadModel } from "./editorialApproval.service";
import { getEditorialPublishReadModel } from "./editorialPublish.service";

export type EditorialEvidenceStatus = {
  workItemId: number;
  available: boolean;
  error: string | null;
  checkerRan: boolean;
  checker: boolean;
  approval: boolean;
  stage: boolean;
  readyToPublish: boolean;
  published: boolean;
  publishedSource: "workspace_receipt" | "published_episode" | null;
};

function parseEpisodeSpan(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) return null;
  return { start, end };
}

function sameEpisodeSpan(a: string | null | undefined, b: string | null | undefined) {
  const left = parseEpisodeSpan(a);
  const right = parseEpisodeSpan(b);
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

async function loadPublishedEpisodeFallbacks(workspaceId: number, workItemIds: number[]) {
  const matches = new Map<number, number>();
  if (!workItemIds.length) return matches;
  try {
    const db = await getDb();
    if (!db) return matches;
    const contexts = await db.select({
      workItemId: workspaceEditorialWorkItems.id,
      episodeNumber: workspaceEditorialWorkItems.episodeNumber,
      novelId: workspaceNovels.novelId,
    }).from(workspaceEditorialWorkItems)
      .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
      .where(and(
        eq(workspaceNovels.workspaceId, workspaceId),
        inArray(workspaceEditorialWorkItems.id, workItemIds)
      ));
    const novelIds = Array.from(new Set(contexts.map(row => row.novelId)));
    if (!novelIds.length) return matches;
    const publishedEpisodes = await db.select({
      id: episodes.id,
      novelId: episodes.novelId,
      episodeNumber: episodes.episodeNumber,
    }).from(episodes).where(and(
      inArray(episodes.novelId, novelIds),
      eq(episodes.isPublished, true)
    ));
    for (const context of contexts) {
      const exact = publishedEpisodes.find(episode =>
        episode.novelId === context.novelId &&
        sameEpisodeSpan(episode.episodeNumber, context.episodeNumber)
      );
      if (exact) matches.set(context.workItemId, exact.id);
    }
  } catch {
    // Historical publication projection is a fallback only; durable Workspace evidence remains authoritative.
  }
  return matches;
}

export async function getEditorialEvidenceStatuses(input: {
  actorUserId: number;
  workspaceId: number;
  workItemIds: number[];
}): Promise<EditorialEvidenceStatus[]> {
  const ids = Array.from(new Set(input.workItemIds)).filter(id => Number.isInteger(id) && id > 0);
  const publishedEpisodeFallbacks = await loadPublishedEpisodeFallbacks(input.workspaceId, ids);
  const results: EditorialEvidenceStatus[] = [];
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = await Promise.all(ids.slice(offset, offset + 20).map(async workItemId => {
      try {
        const approvalState = await getEditorialApprovalReadModel({
          actorUserId: input.actorUserId,
          workspaceId: input.workspaceId,
          workItemId,
        });
        const checkerRan = Boolean(approvalState.qc?.checkerRunId);
        const checker = Boolean(approvalState.qc?.ready && approvalState.qc.unresolvedCount === 0 && approvalState.qc.checkerRunId);
        const approval = Boolean(approvalState.approvalStatus?.valid);
        const stage = Boolean(approvalState.stageStatus?.valid && (approvalState.stages ?? []).length > 0);
        let readyToPublish = false;
        let published = false;
        let publishedSource: EditorialEvidenceStatus["publishedSource"] = null;
        try {
          const state = await getEditorialPublishReadModel({
            actorUserId: input.actorUserId,
            workspaceId: input.workspaceId,
            workItemId,
          });
          readyToPublish = Boolean(state.requestReady);
          const workspacePublished = Boolean(
            state.publishRun?.status === "published" &&
            state.publishItems.length > 0 &&
            state.publishItems.every((item: any) => item.status === "published" && Boolean(item.providerReceipt)) &&
            state.outbox.some((item: any) => item.status === "delivered") &&
            state.stageEpisodes.length === state.stages.length &&
            state.stageEpisodes.every((episode: any) => episode.isPublished === true) &&
            state.kanbanColumnKey === "published"
          );
          if (workspacePublished) {
            published = true;
            publishedSource = "workspace_receipt";
          }
        } catch {
          // Publish diagnostics must not erase independently durable QC/approval/stage evidence.
        }
        if (!published && publishedEpisodeFallbacks.has(workItemId)) {
          published = true;
          publishedSource = "published_episode";
        }
        return { workItemId, available: true, error: null, checkerRan, checker, approval, stage, readyToPublish, published, publishedSource };
      } catch (error) {
        return {
          workItemId,
          available: false,
          error: error instanceof Error ? error.message : String(error),
          checkerRan: false,
          checker: false,
          approval: false,
          stage: false,
          readyToPublish: false,
          published: false,
          publishedSource: null,
        };
      }
    }));
    results.push(...batch);
  }
  return results;
}
