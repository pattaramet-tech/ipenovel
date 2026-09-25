import fs from "node:fs";
import { performance } from "node:perf_hooks";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../../core";
import { runSemanticAlignment } from "../alignment/engine";
import { LocalHttpRerankerProvider } from "../alignment/reranker";
import { LocalHttpEmbeddingProvider } from "../embedding";

type MetaRecord = {
  type: "meta";
  sourceDocumentId: string;
  sourceRevisionId: string | null;
  translationDocumentId: string;
  translationRevisionId: string | null;
  translationTabId: string;
};

type SourceRecord = {
  type: "source";
  internalSequence: number;
  chapter: number;
  title: string;
  startIndex: number;
  endIndex: number;
  text: string;
};

type TranslationRecord = {
  type: "translation" | "translation_historical";
  chapter: number;
  tabId?: string;
  revisionId: string | null;
  revisionModifiedTime?: string | null;
  text: string;
  startIndex?: number | null;
  endIndex?: number | null;
};

type SmokeRecord = MetaRecord | SourceRecord | TranslationRecord;

function parseJsonl(path: string): SmokeRecord[] {
  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as SmokeRecord);
}

function sourceExtraction(
  meta: MetaRecord,
  record: SourceRecord
): NqaChapterExtraction {
  const normalized = normalizeFixtureTextV1(record.text);
  return {
    documentId: meta.sourceDocumentId,
    revisionId: meta.sourceRevisionId,
    tabId: "t.0",
    chapter: record.chapter,
    internalSequence: record.internalSequence,
    title: record.title,
    variant: "production_original",
    paragraphCount: normalized.split("\n").length,
    startIndex: record.startIndex,
    endIndex: record.endIndex,
    text: normalized,
    sha256: sha256Hex(normalized),
  };
}

function translationExtraction(
  meta: MetaRecord,
  record: TranslationRecord
): NqaChapterExtraction {
  const normalized = normalizeFixtureTextV1(record.text);
  return {
    documentId: meta.translationDocumentId,
    revisionId: record.revisionId,
    tabId:
      record.tabId ??
      (record.type === "translation_historical"
        ? "revision-69-export"
        : meta.translationTabId),
    chapter: record.chapter,
    internalSequence: null,
    title:
      record.type === "translation_historical"
        ? "ค้นหาและช่วยเหลือ"
        : "การสิงร่าง",
    variant:
      record.type === "translation_historical"
        ? "historical_revision"
        : "corrected_candidate",
    paragraphCount: normalized.split("\n").length,
    startIndex: record.startIndex ?? 0,
    endIndex: record.endIndex ?? Math.max(1, Array.from(normalized).length),
    text: normalized,
    sha256: sha256Hex(normalized),
  };
}

function summarized(result: Awaited<ReturnType<typeof runSemanticAlignment>>) {
  return {
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    metrics: result.metrics,
    alignedPairs: result.alignedPairs.map(pair => ({
      translationChunkIndex: pair.translationChunkIndex,
      sourceChunkIndex: pair.sourceChunkIndex,
      denseSimilarity: pair.denseSimilarity,
      rerankScore: pair.rerankScore,
      sourceHash: pair.sourceChunk.sha256,
      translationHash: pair.translationChunk.sha256,
    })),
    gaps: result.gaps,
    providerId: result.providerId,
    modelVersion: result.modelVersion,
    policyVersion: result.policyVersion,
  };
}

async function main() {
  const inputPath = process.argv[2];
  const embeddingEndpoint = process.argv[3] ?? "http://127.0.0.1:8765/embed";
  const rerankerEndpoint = process.argv[4] ?? "http://127.0.0.1:8766/rerank";

  if (!inputPath) {
    throw new Error(
      "Usage: m10-smoke.ts <snapshot.jsonl> [embeddingEndpoint] [rerankerEndpoint]"
    );
  }

  const records = parseJsonl(inputPath);
  const meta = records.find(
    (record): record is MetaRecord => record.type === "meta"
  );
  const source197 = records.find(
    (record): record is SourceRecord =>
      record.type === "source" && record.chapter === 197
  );
  const current = records.find(
    (record): record is TranslationRecord =>
      record.type === "translation" && record.chapter === 197
  );
  const historical = records.find(
    (record): record is TranslationRecord =>
      record.type === "translation_historical" && record.chapter === 197
  );

  if (!meta || !source197 || !current || !historical) {
    throw new Error("Smoke snapshot is missing canonical Chapter 197 records.");
  }

  const embeddingProvider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
    endpoint: embeddingEndpoint,
    timeoutMs: 300_000,
  });
  const rerankerProvider = new LocalHttpRerankerProvider(
    "BAAI/bge-reranker-v2-m3",
    {
      endpoint: rerankerEndpoint,
      timeoutMs: 300_000,
    }
  );

  const source = sourceExtraction(meta, source197);

  const runCase = async (label: string, record: TranslationRecord) => {
    const started = performance.now();
    const result = await runSemanticAlignment({
      source,
      translation: translationExtraction(meta, record),
      embeddingProvider,
      rerankerProvider,
    });

    return {
      label,
      translationRevisionId: record.revisionId,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      ...summarized(result),
    };
  };

  const currentResult = await runCase("current_corrected", current);
  const historicalResult = await runCase(
    "historical_bad_revision_69",
    historical
  );

  process.stdout.write(
    JSON.stringify(
      {
        sourceRevisionId: meta.sourceRevisionId,
        sourceChapter: 197,
        sourceInternalSequence: source197.internalSequence,
        current: currentResult,
        historical: historicalResult,
      },
      null,
      2
    ) + "\n"
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
