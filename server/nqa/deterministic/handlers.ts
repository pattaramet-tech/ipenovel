import type { NqaCapability } from "../controlPlane";
import type { TranslationVariant } from "../contracts";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import {
  extractSourceChapter,
  extractTranslationChapter,
} from "../chapter/extractor";
import type { NqaChapterDocumentReader } from "../chapter/googleReader";
import { resolveChapter } from "../chapter/resolver";
import type { NqaDeterministicPolicy } from "./contracts";
import { runDeterministicQa } from "./engine";

type DeterministicCapability = "nqa.qa.run_deterministic";

type DeterministicHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  DeterministicCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("Deterministic QA requires target.row.");
  }
  return row;
}

function requiredChapter(context: NqaGatewayHandlerContext): number {
  const chapter = context.target.chapter;
  if (!chapter) {
    throw new Error("Deterministic QA requires target.chapter.");
  }
  return chapter;
}

export function createNqaDeterministicQaHandlers(input: {
  adapter: NqaGoogleBulkIntakeAdapter;
  reader: NqaChapterDocumentReader;
  expectedInternalSequence?: (chapter: number) => number | null | undefined;
  variantOverrides?: Record<string, TranslationVariant>;
  policy?: Partial<NqaDeterministicPolicy>;
}): DeterministicHandlerMap {
  return {
    "nqa.qa.run_deterministic": async context => {
      const row = await input.adapter.getRow(requiredRow(context));
      const chapter = requiredChapter(context);

      if (row.parse.status !== "PASS") {
        return {
          row: row.row,
          chapter,
          status: "CONTRACT_INVALID",
          issues: row.parse.issues,
          deterministic: null,
        };
      }

      const [sourceSnapshot, translationSnapshot] = await Promise.all([
        input.reader.readDocument(
          row.parse.contract.preparedSourceRef.documentId
        ),
        input.reader.readDocument(row.parse.contract.translationRef.documentId),
      ]);

      const resolution = resolveChapter({
        sourceSnapshot,
        translationSnapshot,
        chapter,
        expectedInternalSequence:
          input.expectedInternalSequence?.(chapter) ?? null,
        variantOverrides: input.variantOverrides,
      });

      const source =
        resolution.source === null
          ? null
          : extractSourceChapter({
              snapshot: sourceSnapshot,
              boundary: resolution.source,
            });
      const translation =
        resolution.translation === null
          ? null
          : extractTranslationChapter({
              snapshot: translationSnapshot,
              boundary: resolution.translation,
            });

      const deterministic = runDeterministicQa({
        resolution,
        source,
        translation,
        policy: input.policy,
      });

      return {
        row: row.row,
        chapter,
        status: deterministic.decision,
        deterministic,
      };
    },
  };
}
