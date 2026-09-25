import type { NqaCapability } from "../controlPlane";
import type { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import type { NqaNovelIdentityResolver } from "./resolver";

type IdentityCapability = "nqa.novel.resolve_identity";

type IdentityHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  IdentityCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("NQA identity resolution requires target.row.");
  }
  return row;
}

export function createNqaIdentityHandlers(input: {
  adapter: NqaGoogleBulkIntakeAdapter;
  resolver: NqaNovelIdentityResolver;
}): IdentityHandlerMap {
  return {
    "nqa.novel.resolve_identity": async context => {
      const snapshot = await input.adapter.getRow(requiredRow(context));

      if (snapshot.parse.status !== "PASS") {
        return {
          row: snapshot.row,
          status: "CONTRACT_INVALID",
          issues: snapshot.parse.issues,
          resolution: null,
        };
      }
      const resolution = input.resolver.resolve({
        canonicalTitle: snapshot.parse.parsedBundle.canonicalTitle,
        contract: snapshot.parse.contract,
      });

      return {
        row: snapshot.row,
        status:
          resolution.status === "REVIEW"
            ? "IDENTITY_REVIEW"
            : "IDENTITY_RESOLVED",
        resolution,
      };
    },
  };
}
