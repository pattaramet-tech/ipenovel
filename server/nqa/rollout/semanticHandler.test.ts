import { describe, expect, it, vi } from "vitest";

import type { NqaDocumentSnapshot } from "../chapter/contracts";
import type { NqaChapterDocumentReader } from "../chapter/googleReader";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "../google/contracts";
import type { NqaGatewayHandlerContext } from "../mcp/handlers";
import type { NqaRerankerProvider } from "../semantic/alignment/contracts";
import type { NqaEmbeddingProvider } from "../semantic/contracts";
import { InMemoryNqaDualRunMonitoringStore } from "./monitoring";
import { createNqaRuntimeAlignmentPolicyResolver } from "./resolver";
import { createNqaControlledSemanticQaHandlers } from "./semanticHandler";
import { buildActivatedRolloutFixture } from "./testSupport";

const SOURCE_ID = "m18SourceDocument123";
const TRANSLATION_ID = "m18TranslationDoc123";

const spreadsheet: NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: "m18-spreadsheet-12345",
  title: "M18",
  locale: "th_TH",
  timeZone: "Asia/Bangkok",
  sheets: [
    {
      sheetId: 1,
      title: "Sheet",
      index: 0,
      rowCount: 100,
      columnCount: 26,
    },
  ],
};

function adapter() {
  const transport: NqaGoogleReadOnlyTransport = {
    getSpreadsheetMetadata: async () => spreadsheet,
    batchGetValues: async input =>
      input.ranges.map(range => ({
        range,
        majorDimension: "ROWS",
        values: [
          [
            "เรื่องทดสอบ 196 - 205",
            "https://docs.google.com/document/d/" + TRANSLATION_ID + "/edit",
            null,
            "https://example.com/source",
            null,
            null,
            null,
            null,
            null,
            "https://docs.google.com/document/d/" + SOURCE_ID + "/edit",
          ],
        ],
      })),
    getDocumentMetadata: async documentId => ({
      documentId,
      title: "Document",
      revisionId: "meta-rev",
      tabs: [],
    }),
  };

  return new NqaGoogleBulkIntakeAdapter(transport, {
    spreadsheetId: "m18-spreadsheet-12345",
    sheetName: "Sheet",
    sheetId: 1,
    columns: {
      novelTitle: "B",
      translation: "C",
      webSource: "E",
      preparedSource: "K",
    },
  });
}

function sourceSnapshot(): NqaDocumentSnapshot {
  return {
    documentId: SOURCE_ID,
    title: "English",
    revisionId: "source-rev",
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
        paragraphs: [
          {
            text: "บท 197: 196. Search and Rescue",
            startIndex: 1,
            endIndex: 31,
            tabId: "t.0",
          },
          {
            text: "source-196 " + "A".repeat(300),
            startIndex: 32,
            endIndex: 340,
            tabId: "t.0",
          },
          {
            text: "บท 198: 197. Possessing",
            startIndex: 341,
            endIndex: 365,
            tabId: "t.0",
          },
          {
            text: "source-197 " + "B".repeat(300),
            startIndex: 366,
            endIndex: 675,
            tabId: "t.0",
          },
          {
            text: "บท 206: 205. Distant Event",
            startIndex: 676,
            endIndex: 705,
            tabId: "t.0",
          },
          {
            text: "source-205 " + "C".repeat(300),
            startIndex: 706,
            endIndex: 1015,
            tabId: "t.0",
          },
        ],
      },
    ],
  };
}

function translationSnapshot(): NqaDocumentSnapshot {
  return {
    documentId: TRANSLATION_ID,
    title: "Thai",
    revisionId: "translation-rev",
    tabs: [
      {
        tabId: "t.197",
        title: "บทที่ 197 การสิงร่าง",
        index: 16,
        parentTabId: null,
        paragraphs: [
          {
            text: "บทที่ 197 การสิงร่าง",
            startIndex: 1,
            endIndex: 23,
            tabId: "t.197",
          },
          {
            text: "thai-query " + "ก".repeat(300),
            startIndex: 24,
            endIndex: 334,
            tabId: "t.197",
          },
        ],
      },
    ],
  };
}

function providers() {
  const embedding: NqaEmbeddingProvider = {
    providerId: "m18-embedding",
    modelVersion: "m18-embedding-v1",
    async embed(texts) {
      return texts.map(text => {
        if (text.includes("source-196")) return [0, 1, 0];
        if (text.includes("source-197")) return [1, 0, 0];
        if (text.includes("source-205")) return [0, 0, 1];
        if (text.includes("thai-query")) return [1, 0, 0];
        throw new Error("unexpected M18 fixture text");
      });
    },
  };
  const reranker: NqaRerankerProvider & { calls: number } = {
    providerId: "m18-reranker",
    modelVersion: "m18-reranker-v1",
    calls: 0,
    async rerank(pairs) {
      this.calls += 1;
      return pairs.map(pair => ({ pairId: pair.pairId, score: 0.95 }));
    },
  };
  return { embedding, reranker };
}

function context(row: number): NqaGatewayHandlerContext {
  return {
    principal: {
      principalId: "qa-operator",
      sessionId: "m18-session",
      permissions: ["QA_OPERATE"],
      authenticated: true,
    },
    requestId: "m18-request-" + row,
    correlationId: "m18-correlation-" + row,
    capability: "nqa.qa.run_semantic",
    target: { row, chapter: 197 },
    inputFingerprint: null,
  };
}

async function setup(targets: readonly { row: number; chapter: number }[]) {
  const activation = await buildActivatedRolloutFixture({ targets });
  const monitoringStore = new InMemoryNqaDualRunMonitoringStore();
  const { embedding, reranker } = providers();
  const reader: NqaChapterDocumentReader = {
    readDocument: vi.fn(async documentId =>
      documentId === SOURCE_ID ? sourceSnapshot() : translationSnapshot()
    ),
  };
  const handlers = createNqaControlledSemanticQaHandlers({
    semantic: {
      adapter: adapter(),
      reader,
      embeddingProvider: embedding,
      rerankerProvider: reranker,
      expectedInternalSequence: chapter => (chapter === 197 ? 198 : null),
      deterministicPolicy: {
        minChapterCharsReview: 1,
        maxChapterCharsReview: 100_000,
        minLengthRatioReview: 0.01,
        maxLengthRatioReview: 100,
        minParagraphRatioReview: 0.01,
        maxParagraphRatioReview: 100,
      },
      semanticPolicy: {
        minExpectedSimilarityPass: 0.6,
        minExpectedLeadPass: 0.02,
        minWrongSourceSimilarityFail: 0.7,
        minWrongSourceMarginFail: 0.08,
      },
    },
    resolveAlignmentPolicy: createNqaRuntimeAlignmentPolicyResolver({
      store: activation.store,
      scope: activation.scope,
    }),
    monitoringStore,
    now: () => "2026-09-24T22:05:00+07:00",
  });
  return { activation, monitoringStore, handlers, reader, reranker };
}

describe("NQA M18 controlled semantic handler", () => {
  it("runs baseline and candidate for an in-scope target and returns candidate as primary", async () => {
    const { activation, monitoringStore, handlers, reader, reranker } =
      await setup([{ row: 2, chapter: 197 }]);

    const result = (await handlers["nqa.qa.run_semantic"](
      context(2)
    )) as Record<string, any>;

    expect(result).toMatchObject({
      status: "PASS",
      semantic: {
        decision: "PASS",
        alignment: {
          policyVersion:
            activation.fixture.materializedPolicy.candidatePolicyVersion,
        },
      },
      rollout: {
        mode: "CONTROLLED_CANDIDATE",
        selectedPolicy: "CANDIDATE",
        inScope: true,
        dualRun: true,
        monitoring: { health: "HEALTHY" },
      },
    });
    expect(reranker.calls).toBe(2);
    expect(reader.readDocument).toHaveBeenCalledTimes(4);
    expect(await monitoringStore.list(activation.scope.scopeId)).toHaveLength(
      1
    );
  });

  it("keeps out-of-scope traffic on baseline with no dual-run record", async () => {
    const { activation, monitoringStore, handlers, reader, reranker } =
      await setup([{ row: 3, chapter: 197 }]);

    const result = (await handlers["nqa.qa.run_semantic"](
      context(2)
    )) as Record<string, any>;

    expect(result).toMatchObject({
      semantic: {
        alignment: { policyVersion: "nqa-alignment-v1" },
      },
      rollout: {
        mode: "BASELINE_ONLY",
        selectedPolicy: "BASELINE",
        inScope: false,
        dualRun: false,
      },
    });
    expect(reranker.calls).toBe(1);
    expect(reader.readDocument).toHaveBeenCalledTimes(2);
    expect(await monitoringStore.list(activation.scope.scopeId)).toEqual([]);
  });
});
