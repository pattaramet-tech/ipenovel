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
};

export async function getEditorialEvidenceStatuses(input: {
  actorUserId: number;
  workspaceId: number;
  workItemIds: number[];
}): Promise<EditorialEvidenceStatus[]> {
  const ids = Array.from(new Set(input.workItemIds)).filter(id => Number.isInteger(id) && id > 0);
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
        try {
          const state = await getEditorialPublishReadModel({
            actorUserId: input.actorUserId,
            workspaceId: input.workspaceId,
            workItemId,
          });
          readyToPublish = Boolean(state.requestReady);
          published = Boolean(
            state.publishRun?.status === "published" &&
            state.publishItems.length > 0 &&
            state.publishItems.every((item: any) => item.status === "published" && Boolean(item.providerReceipt)) &&
            state.outbox.some((item: any) => item.status === "delivered") &&
            state.stageEpisodes.length === state.stages.length &&
            state.stageEpisodes.every((episode: any) => episode.isPublished === true) &&
            state.kanbanColumnKey === "published"
          );
        } catch {
          // Publish diagnostics must not erase independently durable QC/approval/stage evidence.
        }
        return { workItemId, available: true, error: null, checkerRan, checker, approval, stage, readyToPublish, published };
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
        };
      }
    }));
    results.push(...batch);
  }
  return results;
}
