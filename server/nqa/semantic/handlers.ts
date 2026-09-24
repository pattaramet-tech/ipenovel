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
import { runDeterministicQa } from "../deterministic/engine";
import type { NqaDeterministicPolicy } from "../deterministic/contracts";
import type {
  NqaAdjudicationPolicy,
  NqaJevProvider,
  NqaSmallLlmProvider,
} from "./adjudication/contracts";
import { runNqaAdjudication } from "./adjudication/engine";
import { buildAdjudicationEvidencePack } from "./adjudication/evidence";
import type {
  NqaAlignmentPolicy,
  NqaRerankerProvider,
} from "./alignment/contracts";
import { runSemanticAlignment } from "./alignment/engine";
import type {
  NqaEmbeddingProvider,
  NqaSemanticQaStageResult,
  NqaSemanticSearchPolicy,
} from "./contracts";
import { searchGlobalSourceChapters } from "./search";
import type {
  NqaStructurePolicy,
  NqaStructureVerificationProvider,
} from "./structure/contracts";
import { runStructuredVerification } from "./structure/engine";
import { buildStructureEvidenceItems } from "./structure/evidence";

type SemanticCapability = "nqa.qa.run_semantic";

type SemanticHandlerMap = Pick<
  Record<NqaCapability, NqaGatewayHandler>,
  SemanticCapability
>;

function requiredRow(context: NqaGatewayHandlerContext): number {
  const row = context.target.row;
  if (!row) {
    throw new Error("Semantic QA requires target.row.");
  }
  return row;
}

function requiredChapter(context: NqaGatewayHandlerContext): number {
  const chapter = context.target.chapter;
  if (!chapter) {
    throw new Error("Semantic QA requires target.chapter.");
  }
  return chapter;
}

function mergeReasons(
  ...reasonGroups: ReadonlyArray<readonly string[]>
): string[] {
  return Array.from(new Set(reasonGroups.flat()));
}

const M11_ADJUDICABLE_REVIEW_REASONS = new Set([
  "LOW_CONFIDENCE",
  "ALIGNMENT_UNCERTAIN",
  "MODEL_DISAGREEMENT",
  "INSUFFICIENT_EVIDENCE",
]);

function isM11AdjudicableReview(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every(reason => M11_ADJUDICABLE_REVIEW_REASONS.has(reason))
  );
}

export function createNqaSemanticQaHandlers(input: {
  adapter: NqaGoogleBulkIntakeAdapter;
  reader: NqaChapterDocumentReader;
  embeddingProvider: NqaEmbeddingProvider;
  rerankerProvider?: NqaRerankerProvider;
  jevProvider?: NqaJevProvider;
  smallLlmProvider?: NqaSmallLlmProvider;
  structureProvider?: NqaStructureVerificationProvider;
  expectedInternalSequence?: (chapter: number) => number | null | undefined;
  variantOverrides?: Record<string, TranslationVariant>;
  deterministicPolicy?: Partial<NqaDeterministicPolicy>;
  semanticPolicy?: Partial<NqaSemanticSearchPolicy>;
  alignmentPolicy?: Partial<NqaAlignmentPolicy>;
  alignmentPolicyResolver?: () => Promise<NqaAlignmentPolicy>;
  adjudicationPolicy?: Partial<NqaAdjudicationPolicy>;
  structurePolicy?: Partial<NqaStructurePolicy>;
}): SemanticHandlerMap {
  return {
    "nqa.qa.run_semantic": async context => {
      const row = await input.adapter.getRow(requiredRow(context));
      const chapter = requiredChapter(context);

      if (row.parse.status !== "PASS") {
        return {
          row: row.row,
          chapter,
          status: "CONTRACT_INVALID",
          issues: row.parse.issues,
          semantic: null,
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
        policy: input.deterministicPolicy,
      });

      if (deterministic.decision === "FAIL" || translation === null) {
        const result: NqaSemanticQaStageResult = {
          decision: deterministic.decision,
          reasonCodes: [...deterministic.reasonCodes],
          deterministic,
          globalSearch: null,
          alignment: null,
          adjudication: null,
          structure: null,
          policyVersion:
            input.semanticPolicy?.version ?? "nqa-semantic-global-v1",
        };

        return {
          row: row.row,
          chapter,
          status: result.decision,
          semantic: result,
        };
      }

      const globalSearch = await searchGlobalSourceChapters({
        sourceSnapshot,
        translation,
        expectedChapter: chapter,
        provider: input.embeddingProvider,
        rangeStart: row.parse.parsedBundle.rangeStart,
        rangeEnd: row.parse.parsedBundle.rangeEnd,
        policy: input.semanticPolicy,
      });

      const runtimeAlignmentPolicy = input.alignmentPolicyResolver
        ? await input.alignmentPolicyResolver()
        : input.alignmentPolicy;

      const alignment =
        input.rerankerProvider &&
        source !== null &&
        globalSearch.decision !== "FAIL"
          ? await runSemanticAlignment({
              source,
              translation,
              embeddingProvider: input.embeddingProvider,
              rerankerProvider: input.rerankerProvider,
              policy: runtimeAlignmentPolicy,
            })
          : null;

      const preAdjudicationDecision =
        globalSearch.decision === "FAIL" || alignment?.decision === "FAIL"
          ? "FAIL"
          : deterministic.decision === "REVIEW" ||
              globalSearch.decision === "REVIEW" ||
              alignment?.decision === "REVIEW"
            ? "REVIEW"
            : "PASS";

      const preAdjudicationReasons = mergeReasons(
        deterministic.reasonCodes,
        globalSearch.reasonCodes,
        alignment?.reasonCodes ?? []
      ) as NqaSemanticQaStageResult["reasonCodes"];

      const adjudication =
        preAdjudicationDecision === "REVIEW" &&
        source !== null &&
        isM11AdjudicableReview(preAdjudicationReasons) &&
        (input.jevProvider || input.smallLlmProvider)
          ? await runNqaAdjudication({
              evidencePack: buildAdjudicationEvidencePack({
                adjudication: {
                  upstreamDecision: preAdjudicationDecision,
                  upstreamReasonCodes: preAdjudicationReasons,
                  globalSearch,
                  alignment,
                },
                source,
                translation,
                policy: input.adjudicationPolicy,
                alignmentPolicy: runtimeAlignmentPolicy,
              }),
              jevProvider: input.jevProvider,
              smallLlmProvider: input.smallLlmProvider,
              policy: input.adjudicationPolicy,
            })
          : null;

      const preStructureDecision =
        adjudication?.decision ?? preAdjudicationDecision;
      const preStructureReasons =
        adjudication?.reasonCodes ?? preAdjudicationReasons;

      const structure =
        input.structureProvider &&
        source !== null &&
        alignment !== null &&
        (preStructureDecision === "REVIEW" ||
          (preStructureDecision === "PASS" &&
            input.structurePolicy?.runOnPass === true))
          ? await runStructuredVerification({
              items: buildStructureEvidenceItems({
                alignment,
                source,
                translation,
                policy: input.structurePolicy,
                alignmentPolicy: runtimeAlignmentPolicy,
              }),
              provider: input.structureProvider,
              policy: input.structurePolicy,
            })
          : null;

      let decision = preStructureDecision;
      let reasonCodes = preStructureReasons;

      if (structure?.decision === "FAIL") {
        decision = "FAIL";
        reasonCodes = mergeReasons(
          preStructureReasons,
          structure.reasonCodes
        ) as NqaSemanticQaStageResult["reasonCodes"];
      } else if (structure?.decision === "REVIEW") {
        if (preStructureDecision === "PASS") {
          decision = "REVIEW";
        }
        reasonCodes = mergeReasons(
          preStructureReasons,
          structure.reasonCodes
        ) as NqaSemanticQaStageResult["reasonCodes"];
      } else if (
        structure?.decision === "PASS" &&
        preStructureDecision === "REVIEW" &&
        input.structurePolicy?.allowStructuredPassUpgrade === true
      ) {
        decision = "PASS";
        reasonCodes = structure.reasonCodes;
      }

      const result: NqaSemanticQaStageResult = {
        decision,
        reasonCodes,
        deterministic,
        globalSearch,
        alignment,
        adjudication,
        structure,
        policyVersion: globalSearch.policyVersion,
      };

      return {
        row: row.row,
        chapter,
        status: result.decision,
        semantic: result,
      };
    },
  };
}
