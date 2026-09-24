import { describe, expect, it, vi } from "vitest";

import type { NqaDocumentSnapshot } from "../chapter/contracts";
import type { NqaChapterDocumentReader } from "../chapter/googleReader";
import type { NqaDeterministicPolicy } from "../deterministic/contracts";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "../google/contracts";
import { InMemoryNqaGatewayAuditSink } from "../mcp/audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import type {
  NqaJevProvider,
  NqaSmallLlmProvider,
} from "./adjudication/contracts";
import type { NqaRerankerProvider } from "./alignment/contracts";
import type { NqaEmbeddingProvider } from "./contracts";
import { createNqaSemanticQaHandlers } from "./handlers";

const SOURCE_ID = "sourceDocument12345";
const TRANSLATION_ID = "translationDoc12345";

const spreadsheet: NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: "spreadsheet-12345",
  title: "Test",
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

function adapter(valid = true) {
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
            valid
              ? "https://docs.google.com/document/d/" + SOURCE_ID + "/edit"
              : "bad-source-reference",
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
    spreadsheetId: "spreadsheet-12345",
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

function translationSnapshot(include197 = true): NqaDocumentSnapshot {
  return {
    documentId: TRANSLATION_ID,
    title: "Thai",
    revisionId: "translation-rev",
    tabs: include197
      ? [
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
        ]
      : [],
  };
}
function embeddingProvider(
  queryVector: number[]
): NqaEmbeddingProvider & { calls: number } {
  return {
    providerId: "fixture-embedding",
    modelVersion: "fixture-v1",
    calls: 0,
    async embed(texts: string[]) {
      this.calls += 1;
      return texts.map((text, index) => {
        if (index === 0) return queryVector;
        if (text.includes("source-196")) return [0, 1, 0];
        if (text.includes("source-197")) return [1, 0, 0];
        if (text.includes("source-205")) return [0, 0, 1];
        throw new Error("unexpected embedding fixture text");
      });
    },
  };
}

function makeGateway(input?: {
  provider?: NqaEmbeddingProvider;
  rerankerProvider?: NqaRerankerProvider;
  jevProvider?: NqaJevProvider;
  smallLlmProvider?: NqaSmallLlmProvider;
  deterministicPolicy?: Partial<NqaDeterministicPolicy>;
  includeTranslation?: boolean;
  validContract?: boolean;
}) {
  const reader: NqaChapterDocumentReader = {
    readDocument: vi.fn(async documentId =>
      documentId === SOURCE_ID
        ? sourceSnapshot()
        : translationSnapshot(input?.includeTranslation ?? true)
    ),
  };
  const provider = input?.provider ?? embeddingProvider([1, 0, 0]);

  const handlers = createNqaSemanticQaHandlers({
    adapter: adapter(input?.validContract ?? true),
    reader,
    embeddingProvider: provider,
    rerankerProvider: input?.rerankerProvider,
    jevProvider: input?.jevProvider,
    smallLlmProvider: input?.smallLlmProvider,
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
  });

  const auditSink = new InMemoryNqaGatewayAuditSink();
  return {
    gateway: new NqaMcpGateway({
      handlers: new NqaGatewayHandlerRegistry(handlers),
      idempotencyStore: new InMemoryNqaIdempotencyStore(),
      auditSink,
      now: () => "2026-09-24T09:30:00+07:00",
    }),
    reader,
    provider,
    rerankerProvider: input?.rerankerProvider,
    auditSink,
  };
}
const qaPrincipal = {
  principalId: "qa-operator",
  sessionId: "session-semantic",
  permissions: ["QA_OPERATE" as const],
  authenticated: true,
};

function request(key?: string) {
  return {
    requestId: "req-semantic-1",
    correlationId: "corr-semantic-1",
    actorId: "ignored",
    capability: "nqa.qa.run_semantic",
    target: { row: 2, chapter: 197 },
    idempotencyKey: key,
    requestedAt: "2026-09-24T09:30:00+07:00",
  };
}

describe("NQA semantic QA MCP handler", () => {
  it("requires idempotency before reading documents or embeddings", async () => {
    const { gateway, reader, provider } = makeGateway();

    const result = await gateway.dispatch({
      request: request(),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
    });
    expect(reader.readDocument).not.toHaveBeenCalled();
    expect((provider as { calls?: number }).calls ?? 0).toBe(0);
  });

  it("passes when deterministic gate passes and expected source ranks first", async () => {
    const { gateway } = makeGateway({
      provider: embeddingProvider([1, 0, 0]),
    });

    const result = await gateway.dispatch({
      request: request("a".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "PASS",
        semantic: {
          decision: "PASS",
          deterministic: { decision: "PASS" },
          globalSearch: {
            decision: "PASS",
            expectedRank: 1,
            bestCandidate: { chapter: 197 },
          },
        },
      },
    });
  });

  it("fails a strong distant wrong-source match", async () => {
    const { gateway } = makeGateway({
      provider: embeddingProvider([0, 0, 1]),
    });

    const result = await gateway.dispatch({
      request: request("b".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "FAIL",
        semantic: {
          decision: "FAIL",
          reasonCodes: expect.arrayContaining([
            "WRONG_CHAPTER",
            "SOURCE_DRIFT",
          ]),
          globalSearch: {
            bestCandidate: { chapter: 205 },
          },
        },
      },
    });
  });
  it("does not call embeddings when deterministic gate hard-fails", async () => {
    const provider = embeddingProvider([1, 0, 0]);
    const { gateway } = makeGateway({
      provider,
      includeTranslation: false,
    });

    const result = await gateway.dispatch({
      request: request("c".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "FAIL",
        semantic: {
          decision: "FAIL",
          globalSearch: null,
        },
      },
    });
    expect(provider.calls).toBe(0);
  });

  it("reuses completed semantic QA without re-running embeddings", async () => {
    const provider = embeddingProvider([1, 0, 0]);
    const { gateway, reader, auditSink } = makeGateway({
      provider,
    });
    const repeated = request("d".repeat(64));

    const first = await gateway.dispatch({
      request: repeated,
      principal: qaPrincipal,
    });
    const second = await gateway.dispatch({
      request: repeated,
      principal: qaPrincipal,
    });

    expect(first.status).toBe("OK");
    expect(second.status).toBe("REUSED");
    expect(provider.calls).toBe(1);
    expect(reader.readDocument).toHaveBeenCalledTimes(2);
    expect(
      auditSink.records.some(record => record.event === "IDEMPOTENCY_REUSED")
    ).toBe(true);
  });

  it("rejects READ-only principals", async () => {
    const { gateway } = makeGateway();

    const result = await gateway.dispatch({
      request: request("e".repeat(64)),
      principal: {
        principalId: "reader",
        sessionId: "session-read",
        permissions: ["READ"],
        authenticated: true,
      },
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "MISSING_PERMISSION" },
    });
  });

  it("returns contract invalid without reading model inputs", async () => {
    const provider = embeddingProvider([1, 0, 0]);
    const { gateway, reader } = makeGateway({
      provider,
      validContract: false,
    });

    const result = await gateway.dispatch({
      request: request("f".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "CONTRACT_INVALID",
        semantic: null,
      },
    });
    expect(reader.readDocument).not.toHaveBeenCalled();
    expect(provider.calls).toBe(0);
  });

  it("runs M10 alignment when a reranker provider is configured", async () => {
    const provider: NqaEmbeddingProvider & { calls: number } = {
      providerId: "fixture-embedding",
      modelVersion: "fixture-m10",
      calls: 0,
      async embed(texts: string[]) {
        this.calls += 1;
        return texts.map(text => {
          if (text.includes("source-196")) return [0, 1, 0];
          if (text.includes("source-197")) return [1, 0, 0];
          if (text.includes("source-205")) return [0, 0, 1];
          if (text.includes("thai-query")) return [1, 0, 0];
          throw new Error("unexpected M10 fixture text");
        });
      },
    };
    const reranker: NqaRerankerProvider & { calls: number } = {
      providerId: "fixture-reranker",
      modelVersion: "fixture-reranker-v1",
      calls: 0,
      async rerank(pairs) {
        this.calls += 1;
        return pairs.map(pair => ({
          pairId: pair.pairId,
          score: 0.95,
        }));
      },
    };
    const { gateway } = makeGateway({
      provider,
      rerankerProvider: reranker,
    });

    const result = await gateway.dispatch({
      request: request("1".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "PASS",
        semantic: {
          decision: "PASS",
          globalSearch: { decision: "PASS" },
          alignment: {
            decision: "PASS",
            metrics: {
              alignedPairCount: 1,
              sourceCoverage: 1,
              translationCoverage: 1,
            },
          },
        },
      },
    });
    expect(reranker.calls).toBe(1);
  });

  it("runs M11 adjudication only for upstream REVIEW evidence", async () => {
    const provider: NqaEmbeddingProvider = {
      providerId: "fixture-embedding",
      modelVersion: "fixture-m11",
      async embed(texts: string[]) {
        return texts.map(text => {
          if (text.includes("source-196")) return [0, 1, 0];
          if (text.includes("source-197")) return [1, 0, 0];
          if (text.includes("source-205")) return [0, 0, 1];
          if (text.includes("thai-query")) return [1, 0, 0];
          throw new Error("unexpected M11 fixture text");
        });
      },
    };
    const reranker: NqaRerankerProvider = {
      providerId: "fixture-reranker",
      modelVersion: "fixture-reranker-m11",
      async rerank(pairs) {
        return pairs.map(pair => ({
          pairId: pair.pairId,
          score: 0.6,
        }));
      },
    };
    let adjudicationCalls = 0;
    const smallLlm: NqaSmallLlmProvider = {
      providerId: "fixture-small-llm",
      modelVersion: "fixture-small-llm-v1",
      async adjudicate(evidence) {
        adjudicationCalls += 1;
        expect(evidence.upstreamDecision).toBe("REVIEW");
        expect(evidence.snippets.length).toBeGreaterThan(0);
        expect(evidence.snippets[0].sourceText).toContain("source-197");
        expect(evidence.snippets[0].translationText).toContain("thai-query");
        return {
          decision: "PASS",
          reasonCodes: [],
          confidence: 0.95,
          boundedRationale: "The bounded pair is semantically consistent.",
          modelVersion: "fixture-small-llm-v1",
        };
      },
    };
    const { gateway } = makeGateway({
      provider,
      rerankerProvider: reranker,
      smallLlmProvider: smallLlm,
    });

    const result = await gateway.dispatch({
      request: request("2".repeat(64)),
      principal: qaPrincipal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "PASS",
        semantic: {
          decision: "PASS",
          alignment: {
            decision: "REVIEW",
            reasonCodes: ["ALIGNMENT_UNCERTAIN"],
          },
          adjudication: {
            decision: "PASS",
            route: "LOCAL_LLM",
            localLlm: {
              confidence: 0.95,
            },
          },
        },
      },
    });
    expect(adjudicationCalls).toBe(1);
  });
});
