import { createHash } from "node:crypto";

export const EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION =
  "workspace-editorial-foreign-checker-v2" as const;

export const EDITORIAL_FOREIGN_CHECKER_RULES = {
  foreignScript: "foreign_script",
  latinWord: "latin_word",
  longEnglish: "long_english",
} as const;

export type EditorialForeignRuleKey =
  (typeof EDITORIAL_FOREIGN_CHECKER_RULES)[keyof typeof EDITORIAL_FOREIGN_CHECKER_RULES];

export type EditorialCheckerParagraphInput = {
  sourceTabId: string;
  tabTitle: string;
  paragraphKey: string;
  paragraphOrder: number;
  paragraphFingerprint: string;
  text: string;
};

export type EditorialForeignFinding = {
  findingKey: string;
  ruleKey: EditorialForeignRuleKey;
  severity: "error";
  sourceTabId: string;
  tabTitle: string;
  paragraphKey: string;
  paragraphOrder: number;
  paragraphFingerprint: string;
  offsetEncoding: "utf16";
  startOffset: number;
  endOffset: number;
  token: string;
  normalizedToken: string;
  sentenceStartOffset: number;
  sentenceEndOffset: number;
  sentenceText: string;
  contextText: string;
  message: string;
};

const INVISIBLE_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g;
const EXTRA_ALLOWED_CHARS = new Set(["・"]);

/**
 * Ported from production Checker_Main.txt FOREIGN_WORD_RE_V9_.
 * Basic ASCII Latin is intentionally handled by a separate deterministic rule
 * so short untranslated words such as "support" can be surfaced with context.
 */
const FOREIGN_SCRIPT_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF\u1E00-\u1EFF\u0300-\u036F]+/g;

const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;
const LINK_OR_EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:https?:\/\/|www\.)\S+|\b[A-Za-z0-9-]+\.(?:com|net|org|co|io|me|jp|kr|cn|th)\b\S*/gi;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEditorialAllowedWord(value: string) {
  const cleaned = String(value || "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^[A-Za-z][A-Za-z'’-]*$/.test(cleaned)
    ? cleaned.toLocaleLowerCase("en-US")
    : cleaned;
}

export function isLikelyKaomoji(text: string) {
  const s = String(text || "").trim();
  if (!s) return false;
  const wrappedFacePatterns = [
    /^[（(][^()\n]{1,20}[)）]$/,
    /^o[（(][^()\n]{1,20}[)）]o$/i,
    /^Σ[（(][^()\n]{1,25}[)）](?:っ)?$/,
    /^Φ[（(][^()\n]{1,20}[)）]Φ$/,
    /^╮[（(][^()\n]{1,25}[)）]╭$/,
    /^[ヽヾ][^ \n]{1,25}[ノﾉ]$/,
  ];
  if (wrappedFacePatterns.some(pattern => pattern.test(s))) return true;
  const kaomojiChars = /[╥ಥＴ▽ωД><￣°ﾟ﹏ー_・；;︵^~ヽヾノﾉっゝΣΦ╮╯╰╭Oo]/;
  const faceBrackets = /[()（）<>＜＞【】]/;
  if (faceBrackets.test(s) && kaomojiChars.test(s)) return true;
  return /[╮╯╰╭]/.test(s) && /[▽ωД﹏_ー]/.test(s);
}

function buildKaomojiSkipMap(text: string) {
  const skip = new Array(String(text || "").length).fill(false);
  const patterns = [
    /[（(][^()\n]{1,20}[)）]/g,
    /o[（(][^()\n]{1,20}[)）]o/gi,
    /Σ[（(][^()\n]{1,30}[)）](?:っ)?/g,
    /Φ[（(][^()\n]{1,20}[)）]Φ/g,
    /╮[（(][^()\n]{1,30}[)）]╭/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!isLikelyKaomoji(match[0])) continue;
      for (
        let index = match.index;
        index < match.index + match[0].length;
        index++
      ) {
        skip[index] = true;
      }
    }
  }
  return skip;
}

function skipRanges(text: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = new RegExp(LINK_OR_EMAIL_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function overlapsRange(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>
) {
  return ranges.some(range => start < range.end && end > range.start);
}

function sentenceAround(text: string, start: number, end: number) {
  const terminal = new Set([".", "!", "?", "。", "！", "？", "…", "\n"]);
  let sentenceStart = 0;
  for (let index = start - 1; index >= 0; index--) {
    if (terminal.has(text[index])) {
      sentenceStart = index + 1;
      break;
    }
  }

  let sentenceEnd = text.length;
  for (let index = end; index < text.length; index++) {
    if (terminal.has(text[index])) {
      sentenceEnd = index + 1;
      break;
    }
  }

  while (sentenceStart < sentenceEnd && /\s/.test(text[sentenceStart])) {
    sentenceStart++;
  }
  while (sentenceEnd > sentenceStart && /\s/.test(text[sentenceEnd - 1])) {
    sentenceEnd--;
  }
  return {
    sentenceStartOffset: sentenceStart,
    sentenceEndOffset: sentenceEnd,
    sentenceText: text.slice(sentenceStart, sentenceEnd),
  };
}

function englishSpans(text: string) {
  const protectedRanges = skipRanges(text);
  const masked = text.split("");
  for (const range of protectedRanges) {
    for (let index = range.start; index < range.end; index++)
      masked[index] = " ";
  }
  const cleaned = masked.join("").replace(INVISIBLE_RE, " ");
  const allowed = /[\u0020-\u024F‘’“”–—…]/;
  const spans: Array<{ start: number; end: number; text: string }> = [];
  let start = -1;
  for (let index = 0; index <= cleaned.length; index++) {
    const char = index < cleaned.length ? cleaned[index] : "";
    const keep = Boolean(char) && allowed.test(char);
    if (keep && start < 0) start = index;
    if ((!keep || index === cleaned.length) && start >= 0) {
      let left = start;
      let right = index;
      while (left < right && /\s/.test(cleaned[left])) left++;
      while (right > left && /\s/.test(cleaned[right - 1])) right--;
      if (right > left)
        spans.push({ start: left, end: right, text: text.slice(left, right) });
      start = -1;
    }
  }
  return spans;
}

function isLongEnglishSpan(span: string) {
  const words = String(span || "").match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const latinCount = (String(span || "").match(/[A-Za-z]/g) || []).length;
  return (
    words.length >= 8 &&
    latinCount >= 45 &&
    String(span || "").trim().length >= 60
  );
}

function findingKey(input: {
  paragraphKey: string;
  paragraphFingerprint: string;
  ruleKey: EditorialForeignRuleKey;
  startOffset: number;
  endOffset: number;
  normalizedToken: string;
}) {
  return sha256(
    [
      EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      input.paragraphKey,
      input.paragraphFingerprint,
      input.ruleKey,
      String(input.startOffset),
      String(input.endOffset),
      input.normalizedToken,
    ].join("\0")
  );
}

function buildFinding(
  paragraph: EditorialCheckerParagraphInput,
  ruleKey: EditorialForeignRuleKey,
  startOffset: number,
  endOffset: number,
  token: string
): EditorialForeignFinding {
  const normalizedToken = normalizeEditorialAllowedWord(token);
  const sentence = sentenceAround(paragraph.text, startOffset, endOffset);
  const ruleLabel =
    ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish
      ? "พบประโยคภาษาอังกฤษยาว"
      : ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.latinWord
        ? "พบคำภาษาอังกฤษ"
        : "พบคำ/อักษรต่างประเทศ";
  return {
    findingKey: findingKey({
      paragraphKey: paragraph.paragraphKey,
      paragraphFingerprint: paragraph.paragraphFingerprint,
      ruleKey,
      startOffset,
      endOffset,
      normalizedToken,
    }),
    ruleKey,
    severity: "error",
    sourceTabId: paragraph.sourceTabId,
    tabTitle: paragraph.tabTitle,
    paragraphKey: paragraph.paragraphKey,
    paragraphOrder: paragraph.paragraphOrder,
    paragraphFingerprint: paragraph.paragraphFingerprint,
    offsetEncoding: "utf16",
    startOffset,
    endOffset,
    token,
    normalizedToken,
    sentenceStartOffset: sentence.sentenceStartOffset,
    sentenceEndOffset: sentence.sentenceEndOffset,
    sentenceText: sentence.sentenceText,
    contextText: paragraph.text,
    message: `${ruleLabel}: ${token}`,
  };
}

export function evaluateEditorialForeignParagraph(
  paragraph: EditorialCheckerParagraphInput,
  allowWords: ReadonlySet<string>
): EditorialForeignFinding[] {
  const text = String(paragraph.text || "");
  if (!text) return [];

  const findings: EditorialForeignFinding[] = [];
  const urlEmailRanges = skipRanges(text);
  const kaomojiSkipMap = buildKaomojiSkipMap(text);
  const longSpans = englishSpans(text).filter(span =>
    isLongEnglishSpan(span.text)
  );

  for (const span of longSpans) {
    findings.push(
      buildFinding(
        paragraph,
        EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish,
        span.start,
        span.end,
        span.text
      )
    );
  }

  const latin = new RegExp(LATIN_WORD_RE.source, "g");
  let latinMatch: RegExpExecArray | null;
  while ((latinMatch = latin.exec(text)) !== null) {
    const start = latinMatch.index;
    const end = start + latinMatch[0].length;
    if (overlapsRange(start, end, urlEmailRanges)) continue;
    if (kaomojiSkipMap[start]) continue;
    const latinContext = text.slice(
      Math.max(0, start - 20),
      Math.min(text.length, end + 21)
    );
    if (isLikelyKaomoji(latinContext)) continue;
    if (longSpans.some(span => start >= span.start && end <= span.end))
      continue;
    // Isolated ASCII letters are structural labels/noise in translated prose
    // (for example: room A, route X) and are intentionally non-blocking.
    if (/^[A-Za-z]$/.test(latinMatch[0])) continue;
    const normalized = normalizeEditorialAllowedWord(latinMatch[0]);
    if (allowWords.has(normalized)) continue;
    findings.push(
      buildFinding(
        paragraph,
        EDITORIAL_FOREIGN_CHECKER_RULES.latinWord,
        start,
        end,
        latinMatch[0]
      )
    );
  }

  const foreign = new RegExp(FOREIGN_SCRIPT_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = foreign.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (kaomojiSkipMap[start]) continue;
    const context = text.slice(
      Math.max(0, start - 20),
      Math.min(text.length, end + 21)
    );
    if (isLikelyKaomoji(context)) continue;
    if (token.split("").every(char => EXTRA_ALLOWED_CHARS.has(char))) continue;
    const normalized = normalizeEditorialAllowedWord(token);
    if (allowWords.has(normalized)) continue;
    findings.push(
      buildFinding(
        paragraph,
        EDITORIAL_FOREIGN_CHECKER_RULES.foreignScript,
        start,
        end,
        token
      )
    );
  }

  return findings.sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.ruleKey.localeCompare(b.ruleKey) ||
      a.findingKey.localeCompare(b.findingKey)
  );
}

export function evaluateEditorialForeignDraft(input: {
  paragraphs: readonly EditorialCheckerParagraphInput[];
  allowWords?: readonly string[];
}) {
  const allowWords = new Set(
    (input.allowWords ?? []).map(normalizeEditorialAllowedWord).filter(Boolean)
  );
  const findings = input.paragraphs
    .flatMap(paragraph =>
      evaluateEditorialForeignParagraph(paragraph, allowWords)
    )
    .sort(
      (a, b) =>
        a.sourceTabId.localeCompare(b.sourceTabId) ||
        a.paragraphOrder - b.paragraphOrder ||
        a.startOffset - b.startOffset ||
        a.findingKey.localeCompare(b.findingKey)
    );
  return {
    engineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
    status: findings.length ? ("failed" as const) : ("passed" as const),
    findings,
  };
}

export function editorialAllowListSha256(words: readonly string[]) {
  const normalized = Array.from(
    new Set(words.map(normalizeEditorialAllowedWord).filter(Boolean))
  ).sort();
  return sha256(normalized.join("\n"));
}
