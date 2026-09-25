import type { NqaCapability } from "../controlPlane";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import type { NqaNovelIdAutolinkService } from "./service";

type AutolinkCapability =
  "nqa.novel_link.preview" | "nqa.novel_link.confirm_backfill";

type AutolinkHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  AutolinkCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("NQA novel-id autolink requires target.row.");
  }
  return row;
}

function requiredNovelId(context: NqaGatewayHandlerContext): number {
  const raw = context.target.novelId;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(
      "NQA novel-id backfill requires a positive numeric target.novelId."
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "NQA novel-id backfill requires a positive numeric target.novelId."
    );
  }
  return value;
}

export function createNqaNovelIdAutolinkHandlers(
  service: NqaNovelIdAutolinkService
): AutolinkHandlerMap {
  return {
    "nqa.novel_link.preview": async context => {
      return await service.previewRow(requiredRow(context));
    },
    "nqa.novel_link.confirm_backfill": async context => {
      if (!context.inputFingerprint) {
        throw new Error(
          "NQA novel-id backfill requires the preview fingerprint as inputFingerprint."
        );
      }
      return await service.confirmBackfill({
        row: requiredRow(context),
        novelId: requiredNovelId(context),
        previewFingerprint: context.inputFingerprint,
        authorizationId: context.requestId,
        authorizerId: context.principal.principalId,
      });
    },
  };
}
