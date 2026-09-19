import { getEditorialPublishReadModel } from "./editorialPublish.service";

export type EditorialEvidenceStatus = {
  workItemId: number;
  checkerRan: boolean;
  checker: boolean;
  approval: boolean;
  stage: boolean;
  readyToPublish: boolean;
  published: boolean;
};

export async function getEditorialEvidenceStatuses(input: {
  actorUserId: number;
  workspaceId: number;
  workItemIds: number[];
}): Promise<EditorialEvidenceStatus[]> {
  const ids = Array.from(new Set(input.workItemIds)).filter(id => Number.isInteger(id) && id > 0);
  return Promise.all(ids.map(async workItemId => {
    const state = await getEditorialPublishReadModel({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      workItemId,
    });
    const checkerRan = Boolean(state.qc?.checkerRunId);
    const checker = Boolean(state.qc?.ready && state.qc.unresolvedCount === 0 && state.qc.checkerRunId);
    const approval = Boolean(state.approvalStatus?.valid);
    const stage = Boolean(state.stageStatus?.valid && state.stages.length > 0);
    const readyToPublish = Boolean(state.requestReady);
    const published = Boolean(
      state.publishRun?.status === "published" &&
      state.publishItems.length > 0 &&
      state.publishItems.every((item: any) => item.status === "published" && Boolean(item.providerReceipt)) &&
      state.outbox.some((item: any) => item.status === "delivered") &&
      state.stageEpisodes.length === state.stages.length &&
      state.stageEpisodes.every((episode: any) => episode.isPublished === true) &&
      state.kanbanColumnKey === "published"
    );
    return { workItemId, checkerRan, checker, approval, stage, readyToPublish, published };
  }));
}
