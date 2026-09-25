import { hashCanonicalJson } from "../core";
import type { NqaDocumentParagraph } from "../chapter/contracts";
import { sanitizeNqaChapterTail } from "../chapter/sanitizer";

export const NQA_PREPUBLISH_HYGIENE_VERSION =
  "nqa-prepublish-hygiene-v1" as const;

const TAIL_CHAR_LIMIT = 12_000;

export type NqaPrePublishNoiseSignal =
  | "PATREON_PROMO"
  | "WEBNOVEL_URL"
  | "WEBNOVEL_UI"
  | "AUTHOR_NOTE"
  | "ADVANCE_CHAPTER_PROMO"
  | "DISCORD_PROMO";

export type NqaPrePublishHygieneGate = {
  version: typeof NQA_PREPUBLISH_HYGIENE_VERSION;
  decision: "READY_FOR_PUBLISH" | "BLOCKED";
  contentFormat: string;
  originalSha256: string;
  sanitizedSha256: string;
  remediationApplied: boolean;
  removedChars: number;
  removalReasons: NqaPrePublishNoiseSignal[];
  residualSignals: NqaPrePublishNoiseSignal[];
  sanitizedContent: string;
  artifactFingerprint: string;
};

function normalizedTail(text: string): string {
  return text.slice(-TAIL_CHAR_LIMIT).normalize("NFC");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function detectNqaPrePublishTailNoise(
  text: string
): NqaPrePublishNoiseSignal[] {
  const tail = normalizedTail(text);
  const signals: NqaPrePublishNoiseSignal[] = [];

  if (/patreon(?:\s*\(\s*\.\s*\)\s*com|\.com|\/)/i.test(tail)) {
    signals.push("PATREON_PROMO");
  }
  if (/https?:\/\/(?:www\.)?webnovel\.com\b/i.test(tail)) {
    signals.push("WEBNOVEL_URL");
  }
  if (/https?:\/\/(?:www\.)?discord\.gg\//i.test(tail)) {
    signals.push("DISCORD_PROMO");
  }
  if (
    /\b(?:advance|advanced|early access|extra)\s+chapters?\b/i.test(tail) ||
    /อ่านล่วงหน้า.{0,120}(?:บท|ตอน)/.test(tail) ||
    /(?:บท|ตอน).{0,120}ล่วงหน้า/.test(tail)
  ) {
    signals.push("ADVANCE_CHAPTER_PROMO");
  }

  const uiHits = [
    /ความคิดเห็น(?:\s+\d+)?/,
    /(?:^|\s)โหวต(?:\s+\d+)?(?:\s|$)/,
    /\d+\s*โหวต/,
    /คุณอาจชอบ/,
    /ส่งความคิดเห็น/,
    /แสดงความคิดเห็น/,
    /\bcomments?\b/i,
    /\bvotes?\b/i,
  ].filter(pattern => pattern.test(tail)).length;
  if (uiHits >= 2) signals.push("WEBNOVEL_UI");

  const authorHits = [
    /นับจากนี้.{0,160}(?:แก้ไข|ข้อผิดพลาด)/,
    /หากพบ.{0,160}(?:ผิดพลาด|ช่องความคิดเห็น)/,
    /เป้าหมายประจำสัปดาห์/,
    /สโตนมากกว่า\s*[\d,]+/,
    /บทโบนัส/,
    /ขอบคุณมากสำหรับการสนับสนุน/,
    /\bweekly goal\b/i,
    /\bpower stones?\b/i,
    /\bbonus chapters?\b/i,
    /\bthanks?.{0,80}(?:support|reading)\b/i,
  ].filter(pattern => pattern.test(tail)).length;
  if (authorHits >= 2) signals.push("AUTHOR_NOTE");

  return unique(signals);
}

function syntheticParagraphs(text: string): {
  paragraphs: NqaDocumentParagraph[];
  starts: number[];
} {
  const lines = text.split("\n");
  const paragraphs: NqaDocumentParagraph[] = [];
  const starts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    starts.push(offset);
    paragraphs.push({
      text: line,
      startIndex: offset,
      endIndex: offset + line.length,
      tabId: "prepublish",
    });
    offset += line.length + 1;
  }

  return { paragraphs, starts };
}

function isSafeWholeLineNoiseStart(
  line: string,
  suffixSignals: readonly NqaPrePublishNoiseSignal[]
): boolean {
  const value = line.trim();
  if (!value) return true;
  if (
    /^(?:patreon(?:\s*\(\s*\.\s*\)\s*com|\.com|\/)|https?:\/\/(?:www\.)?(?:webnovel\.com|discord\.gg)\b)/i.test(
      value
    )
  ) {
    return true;
  }
  if (
    /^(?:for\s+\d+\s+)?(?:advance|advanced|early access|extra)\s+chapters?\b/i.test(
      value
    ) ||
    /^อ่านล่วงหน้า.{0,120}(?:บท|ตอน)/.test(value)
  ) {
    return true;
  }
  if (
    /^(?:ความคิดเห็น(?:\s+\d+)?|โหวต(?:\s+\d+)?|\d+\s*โหวต|คุณอาจชอบ|ส่งความคิดเห็น|แสดงความคิดเห็น|หัวข้อ|ตอน|comments?|votes?)$/i.test(
      value
    )
  ) {
    return true;
  }
  if (
    /^\d(?:\.\d{1,2})?$/.test(value) &&
    suffixSignals.includes("WEBNOVEL_UI")
  ) {
    return true;
  }
  return /^[^A-Za-z0-9ก-๙一-鿿]{3,}$/.test(value);
}

function paragraphTailCut(text: string): number | null {
  const { paragraphs, starts } = syntheticParagraphs(text);
  const sanitized = sanitizeNqaChapterTail(paragraphs);
  if (
    sanitized.cutParagraphIndex === null ||
    sanitized.removedParagraphCount === 0
  ) {
    return null;
  }

  const cut = starts[sanitized.cutParagraphIndex] ?? null;
  if (cut === null) return null;
  const suffix = text.slice(cut);
  const firstRemovedLine = paragraphs[sanitized.cutParagraphIndex]?.text ?? "";
  return isSafeWholeLineNoiseStart(
    firstRemovedLine,
    detectNqaPrePublishTailNoise(suffix)
  )
    ? cut
    : null;
}

const INLINE_AUTHOR_NOTE_PATTERNS = [
  /นับจากนี้(?:ผม|ฉัน)?.{0,200}(?:แก้ไข|ข้อผิดพลาด)/,
  /หากพบจุดไหนผิดพลาด.{0,200}ช่องความคิดเห็น/,
  /นี่คือเป้าหมายประจำสัปดาห์/,
  /\bfrom now on\b.{0,200}\b(?:mistakes?|correct|fix)\b/i,
  /\bweekly goal\b/i,
];

function inlineAuthorNoteCut(text: string): number | null {
  const tailStart = Math.max(0, text.length - TAIL_CHAR_LIMIT);
  const tail = text.slice(tailStart);
  const corroborating =
    /patreon(?:\s*\(\s*\.\s*\)\s*com|\.com|\/)/i.test(tail) ||
    /อ่านล่วงหน้า.{0,400}(?:บท|ตอน)/.test(tail) ||
    /\b(?:advance|advanced|early access|extra)\s+chapters?\b/i.test(tail);

  if (!corroborating) return null;

  let best: number | null = null;
  for (const pattern of INLINE_AUTHOR_NOTE_PATTERNS) {
    const match = pattern.exec(tail);
    if (!match || match.index === undefined) continue;
    const absolute = tailStart + match.index;
    if (best === null || absolute < best) best = absolute;
  }
  return best;
}

function inferRemovalReasons(removedText: string): NqaPrePublishNoiseSignal[] {
  return detectNqaPrePublishTailNoise(removedText);
}

function trimPublishSuffix(text: string): string {
  return text.replace(/[\t ]+$/gm, "").replace(/\s+$/, "");
}

export function buildNqaPrePublishHygieneGate(input: {
  content: string | null | undefined;
  contentFormat?: string | null;
}): NqaPrePublishHygieneGate {
  const original = String(input.content ?? "");
  const contentFormat = (input.contentFormat ?? "plain_text").toLowerCase();
  const originalSha256 = hashCanonicalJson({
    scope: "nqa:prepublish-content:v1",
    content: original,
  });

  if (!original.trim()) {
    const base = {
      version: NQA_PREPUBLISH_HYGIENE_VERSION,
      decision: "READY_FOR_PUBLISH" as const,
      contentFormat,
      originalSha256,
      sanitizedSha256: originalSha256,
      remediationApplied: false,
      removedChars: 0,
      removalReasons: [] as NqaPrePublishNoiseSignal[],
      residualSignals: [] as NqaPrePublishNoiseSignal[],
      sanitizedContent: original,
    };
    return {
      ...base,
      artifactFingerprint: hashCanonicalJson({
        scope: "nqa:prepublish-hygiene-gate:v1",
        ...base,
      }),
    };
  }

  const originalSignals = detectNqaPrePublishTailNoise(original);
  const autoRemediationSupported =
    contentFormat === "plain_text" || contentFormat === "markdown";

  let sanitized = original;
  let removalReasons: NqaPrePublishNoiseSignal[] = [];

  if (autoRemediationSupported && originalSignals.length > 0) {
    const inlineCut = inlineAuthorNoteCut(original);
    const blockCut = paragraphTailCut(original);
    const cut =
      inlineCut !== null && inlineCut > 0
        ? inlineCut
        : blockCut !== null && blockCut > 0
          ? blockCut
          : null;
    if (cut !== null) {
      const removed = original.slice(cut);
      removalReasons = inferRemovalReasons(removed);
      sanitized = trimPublishSuffix(original.slice(0, cut));
    }
  }

  const residualSignals = detectNqaPrePublishTailNoise(sanitized);
  const remediationApplied = sanitized !== original;
  const removedChars = remediationApplied
    ? original.length - sanitized.length
    : 0;
  const sanitizedSha256 = hashCanonicalJson({
    scope: "nqa:prepublish-content:v1",
    content: sanitized,
  });
  const decision: NqaPrePublishHygieneGate["decision"] =
    residualSignals.length === 0 ? "READY_FOR_PUBLISH" : "BLOCKED";

  const base = {
    version: NQA_PREPUBLISH_HYGIENE_VERSION,
    decision,
    contentFormat,
    originalSha256,
    sanitizedSha256,
    remediationApplied,
    removedChars,
    removalReasons: unique(removalReasons),
    residualSignals,
    sanitizedContent: sanitized,
  };

  return {
    ...base,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:prepublish-hygiene-gate:v1",
      ...base,
    }),
  };
}
