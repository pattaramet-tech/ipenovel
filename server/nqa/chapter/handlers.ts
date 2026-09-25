import type { NqaCapability } from "../controlPlane";
import type { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import type { TranslationVariant } from "../contracts";
import { extractSourceChapter, extractTranslationChapter } from "./extractor";
import type { NqaChapterDocumentReader } from "./googleReader";
import { resolveChapter } from "./resolver";

type ChapterCapability = "nqa.chapter.resolve" | "nqa.chapter.extract";

type ChapterHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  ChapterCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("NQA chapter capability requires target.row.");
  }
  return row;
}

function requiredChapter(context: NqaGatewayHandlerContext): number {
  const chapter = context.target.chapter;
  if (!chapter) {
    throw new Error("NQA chapter capability requires target.chapter.");
  }
  return chapter;
}

export function createNqaChapterHandlers(input: {
  adapter: NqaGoogleBulkIntakeAdapter;
  reader: NqaChapterDocumentReader;
  expectedInternalSequence?: (chapter: number) => number | null | undefined;
  variantOverrides?: Record<string, TranslationVariant>;
}): ChapterHandlerMap {
  async function resolve(context: NqaGatewayHandlerContext) {
    const row = await input.adapter.getRow(requiredRow(context));
    if (row.parse.status !== "PASS") {
      return {
        row: row.row,
        chapter: requiredChapter(context),
        status: "CONTRACT_INVALID",
        issues: row.parse.issues,
        resolution: null,
      };
    }

    const chapter = requiredChapter(context);
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

    return {
      row: row.row,
      chapter,
      sourceSnapshot,
      translationSnapshot,
      resolution,
    };
  }
  return {
    "nqa.chapter.resolve": async context => {
      const result = await resolve(context);
      if (!result.resolution) return result;

      return {
        row: result.row,
        chapter: result.chapter,
        status: result.resolution.status,
        resolution: result.resolution,
      };
    },

    "nqa.chapter.extract": async context => {
      const result = await resolve(context);
      if (!result.resolution) return result;

      const resolution = result.resolution;
      if (!resolution.source || !resolution.translation) {
        return {
          row: result.row,
          chapter: result.chapter,
          status: resolution.status,
          resolution,
          extraction: null,
        };
      }

      return {
        row: result.row,
        chapter: result.chapter,
        status: resolution.status,
        resolution,
        extraction: {
          source: extractSourceChapter({
            snapshot: result.sourceSnapshot,
            boundary: resolution.source,
          }),
          translation: extractTranslationChapter({
            snapshot: result.translationSnapshot,
            boundary: resolution.translation,
          }),
        },
      };
    },
  };
}
