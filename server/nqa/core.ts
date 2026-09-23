import { createHash } from "node:crypto";

import type {
  BundleIdentity,
  ContentFingerprint,
  NovelIdentity,
} from "./contracts";

export type ParsedBundleTitle = {
  canonicalTitle: string;
  rangeStart: number;
  rangeEnd: number;
  isFinished: boolean;
};

export function normalizeFixtureTextV1(
  input: string,
  options: { stripLeadingTabLabel?: boolean } = {}
): string {
  let value = input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.replace(/[ \t]+$/g, ""))
    .join("\n");

  if (options.stripLeadingTabLabel) {
    const lines = value.split("\n");
    if (/^แท็บ\s+\d+\s*$/.test(lines[0] ?? "")) {
      value = lines.slice(1).join("\n");
    }
  }

  return value.replace(/^\n+|\n+$/g, "");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function parseBundleDisplayTitle(
  input: string
): ParsedBundleTitle | null {
  const normalized = input.normalize("NFC").trim();
  const match = normalized.match(
    /^(.*?)\s+(\d+)\s*[-–—]\s*(\d+)(?:\s*(จบ|end))?\s*$/i
  );

  if (!match) {
    return null;
  }

  const rangeStart = Number(match[2]);
  const rangeEnd = Number(match[3]);
  if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)) {
    return null;
  }
  if (rangeStart <= 0 || rangeEnd < rangeStart) {
    return null;
  }

  return {
    canonicalTitle: match[1].trim(),
    rangeStart,
    rangeEnd,
    isFinished: Boolean(match[4]),
  };
}

export function normalizeIdentityTitle(input: string): string {
  return input
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([:：])\s*/g, "$1")
    .toLocaleLowerCase("th");
}

export function makeNovelCandidateIdentity(
  canonicalTitle: string
): NovelIdentity {
  const normalized = normalizeIdentityTitle(canonicalTitle);
  return {
    novelId: `novel_${sha256Hex(normalized).slice(0, 16)}`,
    canonicalTitle: canonicalTitle.normalize("NFC").trim(),
    aliases: [],
    authority: "STRUCTURED",
  };
}

export function makeBundleIdentity(input: {
  novel: NovelIdentity;
  rangeStart: number;
  rangeEnd: number;
  locator: BundleIdentity["locator"];
  translationDocumentId: string;
  sourceDocumentId: string;
}): BundleIdentity {
  if (input.rangeEnd < input.rangeStart) {
    throw new Error("rangeEnd must be greater than or equal to rangeStart");
  }

  const novelToken = input.novel.novelId.replace(/^novel_/, "");
  return {
    bundleId: `bundle_${novelToken}_${input.rangeStart}_${input.rangeEnd}`,
    novelId: input.novel.novelId,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    locator: input.locator,
    translationDocumentId: input.translationDocumentId,
    sourceDocumentId: input.sourceDocumentId,
  };
}

export function fingerprintText(input: {
  text: string;
  paragraphCount?: number | null;
  startIndex?: number | null;
  endIndex?: number | null;
  stripLeadingTabLabel?: boolean;
}): ContentFingerprint {
  const normalized = normalizeFixtureTextV1(input.text, {
    stripLeadingTabLabel: input.stripLeadingTabLabel,
  });

  return {
    normalizationVersion: "NQA_FIXTURE_V1",
    sha256: sha256Hex(normalized),
    charCount: Array.from(normalized).length,
    byteCount: Buffer.byteLength(normalized, "utf8"),
    paragraphCount: input.paragraphCount ?? null,
    startIndex: input.startIndex ?? null,
    endIndex: input.endIndex ?? null,
  };
}

export type IntakeIdempotencyInput = {
  spreadsheetId: string;
  sheetName: string;
  row: number;
  sourceDocumentId: string;
  sourceRevisionId: string;
  translationDocumentId: string;
  translationRevisionId: string;
  contractVersion: string;
};

export function buildIntakeIdempotencyKey(
  input: IntakeIdempotencyInput
): string {
  return hashCanonicalJson({
    scope: "nqa:intake:v1",
    ...input,
  });
}

export type ChapterQaIdempotencyInput = {
  novelId: string;
  bundleId: string;
  sourceChapter: number;
  sourceHash: string;
  translationHash: string;
  translationVariant: string;
  chunkerVersion: string;
  modelSetVersion: string;
  policyVersion: string;
};
export function buildChapterQaIdempotencyKey(
  input: ChapterQaIdempotencyInput
): string {
  return hashCanonicalJson({
    scope: "nqa:chapter-qa:v1",
    ...input,
  });
}

export function buildInputFingerprint(input: {
  sourceHash: string;
  translationHash: string;
  mappingHash: string;
}): string {
  return hashCanonicalJson({
    scope: "nqa:input-fingerprint:v1",
    ...input,
  });
}
