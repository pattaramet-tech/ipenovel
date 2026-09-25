import fs from "node:fs";
import { performance } from "node:perf_hooks";

import type {
  NqaChapterExtraction,
  NqaDocumentParagraph,
  NqaDocumentSnapshot,
} from "../../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../../core";
import { LocalHttpEmbeddingProvider } from "../embedding";
import { searchGlobalSourceChapters } from "../search";

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

function sourceSnapshot(
  meta: MetaRecord,
  sources: SourceRecord[]
): NqaDocumentSnapshot {
  const paragraphs: NqaDocumentParagraph[] = [];

  for (const source of [...sources].sort((a, b) => a.chapter - b.chapter)) {
    const lines = source.text.split(/\r?\n/);
    const heading = lines[0]?.trim() ?? "";
    const body = lines.slice(1).join("\n").trim();
    const headingEnd = source.startIndex + heading.length + 1;

    paragraphs.push({
      text: heading,
      startIndex: source.startIndex,
      endIndex: headingEnd,
      tabId: "t.0",
    });
    paragraphs.push({
      text: body,
      startIndex: headingEnd,
      endIndex: Math.max(headingEnd, source.endIndex),
      tabId: "t.0",
    });
  }

  return {
    documentId: meta.sourceDocumentId,
    title: "Canonical source smoke snapshot",
    revisionId: meta.sourceRevisionId,
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
        paragraphs,
      },
    ],
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

async function runOne(input: {
  label: string;
  snapshot: NqaDocumentSnapshot;
  translation: NqaChapterExtraction;
  provider: LocalHttpEmbeddingProvider;
}) {
  const started = performance.now();
  const result = await searchGlobalSourceChapters({
    sourceSnapshot: input.snapshot,
    translation: input.translation,
    expectedChapter: 197,
    provider: input.provider,
    rangeStart: 182,
    rangeEnd: 230,
  });
  const elapsedMs = performance.now() - started;

  return {
    label: input.label,
    translationRevisionId: input.translation.revisionId,
    translationVariant: input.translation.variant,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    expectedRank: result.expectedRank,
    expectedSimilarity: result.expectedSimilarity,
    expectedLeadOverAlternate: result.expectedLeadOverAlternate,
    marginOverExpected: result.marginOverExpected,
    bestCandidate: result.bestCandidate,
    bestAlternate: result.bestAlternate,
    top5: result.candidates.slice(0, 5),
    providerId: result.providerId,
    modelVersion: result.modelVersion,
    policyVersion: result.policyVersion,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
  };
}

async function main() {
  const inputPath = process.argv[2];
  const endpoint = process.argv[3] ?? "http://127.0.0.1:8765/embed";

  if (!inputPath) {
    throw new Error("Usage: m09a-smoke.ts <snapshot.jsonl> [endpoint]");
  }

  const records = parseJsonl(inputPath);
  const meta = records.find(
    (record): record is MetaRecord => record.type === "meta"
  );
  const sources = records.filter(
    (record): record is SourceRecord => record.type === "source"
  );
  const current = records.find(
    (record): record is TranslationRecord => record.type === "translation"
  );
  const historical = records.find(
    (record): record is TranslationRecord =>
      record.type === "translation_historical"
  );

  if (!meta || !current || !historical) {
    throw new Error(
      "Smoke snapshot is missing meta/current/historical records."
    );
  }
  if (sources.length !== 49) {
    throw new Error("Expected 49 source chapters in canonical smoke snapshot.");
  }

  const snapshot = sourceSnapshot(meta, sources);
  const provider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
    endpoint,
    timeoutMs: 300_000,
  });

  const currentResult = await runOne({
    label: "current_corrected",
    snapshot,
    translation: translationExtraction(meta, current),
    provider,
  });
  const historicalResult = await runOne({
    label: "historical_bad_revision_69",
    snapshot,
    translation: translationExtraction(meta, historical),
    provider,
  });

  process.stdout.write(
    JSON.stringify(
      {
        sourceRevisionId: meta.sourceRevisionId,
        sourceChapterCount: sources.length,
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
