import fs from "node:fs";
import { performance } from "node:perf_hooks";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../../core";
import { chunkSemanticChapter } from "../alignment/chunker";
import { runSemanticAlignment } from "../alignment/engine";
import { mergeNqaAlignmentPolicy } from "../alignment/policy";
import { LocalHttpRerankerProvider } from "../alignment/reranker";
import { LocalHttpEmbeddingProvider } from "../embedding";
import type { NqaStructureEvidenceItem } from "../structure/contracts";
import { runStructuredVerification } from "../structure/engine";
import { LocalHttpStructureVerificationProvider } from "../structure/provider";

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
  const text = normalizeFixtureTextV1(record.text);
  return {
    documentId: meta.sourceDocumentId,
    revisionId: meta.sourceRevisionId,
    tabId: "t.0",
    chapter: record.chapter,
    internalSequence: record.internalSequence,
    title: record.title,
    variant: "production_original",
    paragraphCount: text.split("\n").length,
    startIndex: record.startIndex,
    endIndex: record.endIndex,
    text,
    sha256: sha256Hex(text),
  };
}

function translationExtraction(
  meta: MetaRecord,
  record: TranslationRecord
): NqaChapterExtraction {
  const text = normalizeFixtureTextV1(record.text);
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
    paragraphCount: text.split("\n").length,
    startIndex: record.startIndex ?? 0,
    endIndex: record.endIndex ?? Math.max(1, Array.from(text).length),
    text,
    sha256: sha256Hex(text),
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: m12-smoke.ts <canonical-snapshot.jsonl>");
  }

  const records = parseJsonl(inputPath);
  const meta = records.find(
    (record): record is MetaRecord => record.type === "meta"
  );
  const sourceRecord = records.find(
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

  if (!meta || !sourceRecord || !current || !historical) {
    throw new Error("Canonical Chapter 197 records are missing.");
  }

  const embeddingProvider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
    endpoint: "http://127.0.0.1:8765/embed",
    timeoutMs: 300_000,
  });
  const rerankerProvider = new LocalHttpRerankerProvider(
    "BAAI/bge-reranker-v2-m3",
    {
      endpoint: "http://127.0.0.1:8766/rerank",
      timeoutMs: 300_000,
    }
  );
  const structureProvider = new LocalHttpStructureVerificationProvider(
    "Qwen/Qwen3-1.7B",
    {
      endpoint: "http://127.0.0.1:8767/verify-structure",
      timeoutMs: 300_000,
    }
  );
  const alignmentPolicy = mergeNqaAlignmentPolicy();
  const source = sourceExtraction(meta, sourceRecord);

  const runCase = async (
    label: string,
    record: TranslationRecord,
    pairChoice: "BEST" | "WORST"
  ) => {
    const translation = translationExtraction(meta, record);
    const alignment = await runSemanticAlignment({
      source,
      translation,
      embeddingProvider,
      rerankerProvider,
    });

    if (alignment.alignedPairs.length === 0) {
      throw new Error(label + " has no aligned pair.");
    }

    const selected = [...alignment.alignedPairs].sort((a, b) =>
      pairChoice === "BEST"
        ? b.rerankScore - a.rerankScore
        : a.rerankScore - b.rerankScore
    )[0];

    const sourceChunks = chunkSemanticChapter({
      extraction: source,
      policy: alignmentPolicy,
    });
    const translationChunks = chunkSemanticChapter({
      extraction: translation,
      policy: alignmentPolicy,
    });
    const sourceChunk = sourceChunks[selected.sourceChunkIndex];
    const translationChunk = translationChunks[selected.translationChunkIndex];

    const item: NqaStructureEvidenceItem = {
      evidenceId: label + "-canonical-pair",
      kind: "ALIGNED_PAIR",
      sourceHash: sourceChunk.sha256,
      translationHash: translationChunk.sha256,
      sourceStartIndex: sourceChunk.startIndex,
      sourceEndIndex: sourceChunk.endIndex,
      translationStartIndex: translationChunk.startIndex,
      translationEndIndex: translationChunk.endIndex,
      rerankScore: selected.rerankScore,
      sourceText: sourceChunk.text.slice(0, 500),
      translationText: translationChunk.text.slice(0, 500),
    };

    const started = performance.now();
    const structure = await runStructuredVerification({
      items: [item],
      provider: structureProvider,
    });

    return {
      label,
      pairChoice,
      alignmentDecision: alignment.decision,
      selectedPair: {
        sourceChunkIndex: selected.sourceChunkIndex,
        translationChunkIndex: selected.translationChunkIndex,
        rerankScore: selected.rerankScore,
        sourceHash: sourceChunk.sha256,
        translationHash: translationChunk.sha256,
      },
      structuredElapsedMs: Math.round((performance.now() - started) * 10) / 10,
      structure,
    };
  };

  const corrected = await runCase("current_corrected", current, "BEST");
  const bad = await runCase("historical_bad_revision_69", historical, "WORST");

  process.stdout.write(
    JSON.stringify(
      {
        sourceRevisionId: meta.sourceRevisionId,
        sourceChapter: 197,
        sourceInternalSequence: sourceRecord.internalSequence,
        corrected,
        bad,
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
