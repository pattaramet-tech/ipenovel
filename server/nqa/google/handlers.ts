import type { NqaCapability } from "../controlPlane";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import type { NqaGoogleBulkIntakeAdapter } from "./adapter";

type IntakeCapability =
  | "nqa.intake.get_row"
  | "nqa.intake.scan_range"
  | "nqa.intake.validate_contract"
  | "nqa.intake.get_manifest";

type IntakeHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  IntakeCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("NQA intake capability requires target.row.");
  }
  return row;
}

function scanEndRow(context: NqaGatewayHandlerContext): number {
  return context.target.rowEnd ?? requiredRow(context);
}

export function createNqaGoogleIntakeHandlers(
  adapter: NqaGoogleBulkIntakeAdapter
): IntakeHandlerMap {
  return {
    "nqa.intake.get_row": async context => {
      return await adapter.getRow(requiredRow(context));
    },

    "nqa.intake.scan_range": async context => {
      const startRow = requiredRow(context);
      return await adapter.scanRange({
        startRow,
        endRow: scanEndRow(context),
      });
    },

    "nqa.intake.validate_contract": async context => {
      const snapshot = await adapter.getRow(requiredRow(context));
      return {
        row: snapshot.row,
        parse: snapshot.parse,
      };
    },

    "nqa.intake.get_manifest": async context => {
      const snapshot = await adapter.getRow(requiredRow(context));
      return {
        row: snapshot.row,
        parse: snapshot.parse,
        documents: snapshot.documents,
      };
    },
  };
}
