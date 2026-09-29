import { createHash } from "node:crypto";

export const EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION =
  "workspace-editorial-foreign-checker-v8" as const;

export const EDITORIAL_FOREIGN_CHECKER_RULES = {
  foreignScript: "foreign_script",
  latinWord: "latin_word",
  longEnglish: "long_english",
  sourceJunk: "source_junk",
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
 * Basic ASCII Latin tokens are non-blocking; long ASCII spans are evaluated
 * separately so untranslated sentences and leaked machine payloads still fail QC.
 */
const FOREIGN_SCRIPT_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF\u1E00-\u1EFF\u0300-\u036F\u0900-\u097F\uA8E0-\uA8FF\u1CD0-\u1CFF]+/g;

const SOURCE_JUNK_ANCHOR_PATTERNS = [
  /ความคิดของ(?:ผู้สร้าง|ผู้เขียน)/i,
  /ความคิดเห็น(?:ของ)?(?:ผู้สร้าง|ผู้เขียน)/i,
  /หมายเหตุ(?:จาก)?(?:ผู้สร้าง|ผู้เขียน|ผู้แปล)/i,
  /ขอบคุณ(?:มาก)?สำหรับ[^\n]*(?:พาวเวอร์สโตน|power\s*stones?)/i,
  /(?:พาวเวอร์สโตน|power\s*stones?)[^\n]*(?:สิบอันดับแรก|top\s*10|อันดับ)/i,
  /หากคุณอยากอ่านตอนถัดไปก่อนใคร/i,
  /อ่านตอนถัดไปก่อนใคร[^\n]*(?:สนับสนุน|support|patreon)/i,
  /(?:สนับสนุนผม|สนับสนุนผู้เขียน|ช่องทางติดตามผู้เขียน)/i,
  /\b(?:patreon|ko-fi|buymeacoffee)\b/i,
  /(?:author(?:'s)?\s*(?:thoughts?|notes?)|creator(?:'s)?\s*(?:thoughts?|notes?))/i,
] as const;

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
    ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
      ? "พบข้อความขยะ/ข้อความท้ายต้นฉบับ"
      : ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish
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
  const kaomojiSkipMap = buildKaomojiSkipMap(text);
  // Product rule: ordinary isolated A-Z/a-z words, names and acronyms are
  // intentionally non-blocking. Long ASCII spans remain blocking because they
  // represent untranslated English sentences or leaked machine/control payloads.
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

const INLINE_PARENTHETICAL_AUTHOR_NOTE_RE =
  /[（(][^()（）\n]*หมายเหตุ(?:จาก)?(?:ผู้สร้าง|ผู้เขียน|ผู้แปล)[^()（）\n]*[)）]/i;

function isInlineParentheticalAuthorNote(text: string) {
  const value = String(text || "").trim();
  if (!value) return false;
  const match = value.match(INLINE_PARENTHETICAL_AUTHOR_NOTE_RE);
  if (!match) return false;
  return value.replace(match[0], "").trim().length > 0;
}

function hasSourceJunkAnchor(text: string) {
  const value = String(text || "").trim();
  if (!value || isInlineParentheticalAuthorNote(value)) return false;
  return SOURCE_JUNK_ANCHOR_PATTERNS.some(pattern => pattern.test(value));
}

const SOURCE_JUNK_END_MARKER_RE =
  /^(?:จบตอน|จบบท|จบตอนที่\s*\d+|end(?:\s+of)?\s+(?:chapter|part))\s*[.!…]*$/i;

const SOURCE_JUNK_SECTION_HEADING_PATTERNS = [
  /^(?:ความคิด|ความคิดเห็น)ของ(?:ผู้สร้าง|ผู้เขียน)\s*[:：-]?\s*$/i,
  /^หมายเหตุ(?:จาก)?(?:ผู้สร้าง|ผู้เขียน|ผู้แปล)\s*[:：-]?\s*$/i,
  /^(?:author(?:'s)?\s*(?:thoughts?|notes?)|creator(?:'s)?\s*(?:thoughts?|notes?))\s*[:：-]?\s*$/i,
] as const;

const SOURCE_JUNK_SUPPORTER_SIGNAL_RE =
  /(?:พาวเวอร์สโตน|power\s*stones?|สิบอันดับแรก|top\s*10|ผู้สนับสนุน|supporters?)/i;

// Note-content prose markers: reader-directed wording that keeps a trailing
// author-note/junk section open. Anything without these (or other junk signals)
// is treated as resumed narrative and closes the section immediately.
const SOURCE_JUNK_NOTE_PROSE_PATTERNS = [
  /^(?:ฉัน|ผม|เรา|ผู้เขียน|คนเขียน)[^\n]{0,100}(?:เขียน|แต่ง|แปล)[^\n]{0,80}(?:ตอน|บท|ฉาก|เรื่อง|นิยาย)(?:นี้|หน้า|ถัดไป)?/i,
  /(?:ตอน|บท|ฉาก|เรื่อง|นิยาย)(?:นี้|หน้า|ถัดไป)?[^\n]{0,80}(?:เขียน|แต่ง|แปล)[^\n]{0,60}(?:ยาก|นาน|เสร็จ|ช้า)/i,
  /หวังว่า[^\n]{0,100}(?:ทุกคน|ทุกท่าน|ผู้อ่าน|นักอ่าน)[^\n]{0,100}(?:ชอบ|สนุก|ติดตาม|อ่าน)/i,
  /(?:ขอบคุณ|ขอบใจ|ฝาก|ขอ(?:โทษ|อภัย))[^\n]{0,120}(?:ทุกคน|ทุกท่าน|ผู้อ่าน|นักอ่าน|ติดตาม|สนับสนุน|อ่าน|ลงช้า)/i,
  /(?:พบกันใหม่|เจอกัน(?:ตอน)?หน้า)/i,
  /(?:ป่วย|ไม่สบาย)[^\n]{0,100}(?:ลง|ตอน|อัปเดต|อัพเดต|อัพเดท|ขออภัย|ขอโทษ)/i,
] as const;

function isQuoteWrappedNarrativeLine(text: string) {
  const value = String(text || "").trim();
  return (
    value.length >= 2 &&
    /^["“”‘’「『]/.test(value) &&
    /["”’」』]$/.test(value)
  );
}

const SOURCE_JUNK_CONTINUATION_PATTERNS = [
  /^(?:\.{2,}|…+)$/,
  /^[\s\-_=—–*#~·•]{3,}$/,
  /^\d{1,3}\s*[.)\]:-]\s*\S.{0,100}$/,
  /^(?:โดยเฉพาะ)?(?:สิบอันดับแรก|top\s*10)[^\n]*(?:พาวเวอร์สโตน|power\s*stones?)/i,
  /^ขอบคุณ(?:มาก)?(?:ทุกคน)?(?:สำหรับ|ที่)(?:การ)?(?:ติดตาม|อ่าน|สนับสนุน)/i,
] as const;

function isSourceJunkEndMarker(text: string) {
  return SOURCE_JUNK_END_MARKER_RE.test(String(text || "").trim());
}

function isSourceJunkSectionHeading(text: string) {
  const value = String(text || "").trim();
  return SOURCE_JUNK_SECTION_HEADING_PATTERNS.some(pattern => pattern.test(value));
}

function isSourceJunkNarrativeResume(
  text: string,
  supporterListContext: boolean
) {
  const value = String(text || "").trim();
  if (!value) return false;
  // Quote-wrapped dialogue is unambiguous narrative even when it contains
  // note-ish polite particles.
  if (isQuoteWrappedNarrativeLine(value)) return true;
  return !isTrailingSectionContent(value, supporterListContext);
}

/**
 * A short line that is almost entirely a supporter-list signal (Supporters /
 * ผู้สนับสนุน / Power Stones / top-10) is a list heading. Narrative that merely
 * mentions these words leaves a long remainder and is not a list heading.
 */
function isSupporterListHeadingLine(text: string) {
  const value = String(text || "").trim();
  if (!value || value.length > 60) return false;
  if (!isSourceJunkSupporterSignal(value)) return false;
  const remainder = value
    .replace(new RegExp(SOURCE_JUNK_SUPPORTER_SIGNAL_RE.source, "gi"), "")
    .replace(/[\s:：\-–—•·|,.]+/g, "");
  return remainder.length <= 8;
}

function isTrailingSectionContent(
  text: string,
  supporterListContext: boolean
) {
  const value = String(text || "").trim();
  return (
    isSourceJunkEndMarker(value) ||
    isSourceJunkContinuation(value) ||
    isSupporterListHeadingLine(value) ||
    (supporterListContext && isPlainSupporterHandle(value)) ||
    SOURCE_JUNK_NOTE_PROSE_PATTERNS.some(pattern => pattern.test(value))
  );
}

/**
 * Semantic, bounded trailing-section detection. A section heading opens a
 * trailing author-note/junk section of any length; the section stays open only
 * while every non-empty paragraph still reads as note/junk content and closes
 * immediately once narrative resumes (or at an end marker). Unlike the old
 * fixed <=6-paragraph + end-marker heuristic, genuine long trailing notes are
 * still detected while mid-chapter headings followed by story prose never
 * swallow the narrative that follows.
 */
function sourceJunkTrailingSectionEndIndex(
  ordered: readonly EditorialCheckerParagraphInput[],
  anchorIndex: number
) {
  if (!isSourceJunkSectionHeading(ordered[anchorIndex]?.text || "")) return null;

  let sectionEnd: number | null = null;
  let supporterListContext = isSourceJunkSupporterSignal(
    ordered[anchorIndex]?.text || ""
  );
  for (let index = anchorIndex + 1; index < ordered.length; index++) {
    const text = String(ordered[index].text || "").trim();
    if (!text) continue;
    if (isSourceJunkEndMarker(text)) {
      sectionEnd = index;
      break;
    }
    if (isSupporterListHeadingLine(text)) supporterListContext = true;
    if (isSourceJunkNarrativeResume(text, supporterListContext)) break;
    sectionEnd = index;
  }
  return sectionEnd;
}

function isSourceJunkSupporterSignal(text: string) {
  return SOURCE_JUNK_SUPPORTER_SIGNAL_RE.test(String(text || "").trim());
}

function isPlainSupporterHandle(text: string) {
  const value = String(text || "").trim();
  return (
    value.length >= 2 &&
    value.length <= 40 &&
    /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)
  );
}

function isSourceJunkContinuation(text: string) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (hasSourceJunkAnchor(value) || isSourceJunkEndMarker(value)) return true;
  if (SOURCE_JUNK_CONTINUATION_PATTERNS.some(pattern => pattern.test(value))) {
    return true;
  }
  if (new RegExp(LINK_OR_EMAIL_RE.source, "i").test(value)) return true;

  // Repeated or digit-bearing account-like tokens are strong enough to be
  // continuation evidence on their own. Plain alphabetic handles are only
  // accepted while an explicit supporter-list signal is active in the block.
  if (/^([A-Za-z0-9_.-]{2,})(?:\s+\1)+$/i.test(value)) return true;
  if (
    value.length <= 80 &&
    !/[\u0E00-\u0E7F]/.test(value) &&
    /^[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*$/.test(value)
  ) {
    return true;
  }
  return false;
}

function evaluateEditorialSourceJunkBlocks(
  paragraphs: readonly EditorialCheckerParagraphInput[]
): EditorialForeignFinding[] {
  const grouped = new Map<string, EditorialCheckerParagraphInput[]>();
  for (const paragraph of paragraphs) {
    const bucket = grouped.get(paragraph.sourceTabId) ?? [];
    bucket.push(paragraph);
    grouped.set(paragraph.sourceTabId, bucket);
  }

  const findings: EditorialForeignFinding[] = [];
  for (const rows of Array.from(grouped.values())) {
    const ordered = [...rows].sort(
      (a, b) => a.paragraphOrder - b.paragraphOrder
    );

    for (let index = 0; index < ordered.length; index++) {
      if (!hasSourceJunkAnchor(ordered[index].text)) continue;

      const trailingSectionEnd = sourceJunkTrailingSectionEndIndex(
        ordered,
        index
      );
      if (trailingSectionEnd !== null) {
        for (let cursor = index; cursor <= trailingSectionEnd; cursor++) {
          const paragraph = ordered[cursor];
          const token = String(paragraph.text || "").trim();
          if (!token) continue;
          const startOffset = paragraph.text.indexOf(token);
          findings.push(
            buildFinding(
              paragraph,
              EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk,
              Math.max(0, startOffset),
              Math.max(0, startOffset) + token.length,
              token
            )
          );
        }
        index = trailingSectionEnd;
        continue;
      }

      let supporterListContext = isSourceJunkSupporterSignal(
        ordered[index].text
      );
      for (let cursor = index; cursor < ordered.length; cursor++) {
        const paragraph = ordered[cursor];
        const token = String(paragraph.text || "").trim();

        if (cursor > index) {
          const nestedTrailingSectionEnd = sourceJunkTrailingSectionEndIndex(
            ordered,
            cursor
          );
          if (nestedTrailingSectionEnd !== null) {
            for (
              let tailCursor = cursor;
              tailCursor <= nestedTrailingSectionEnd;
              tailCursor++
            ) {
              const tailParagraph = ordered[tailCursor];
              const tailToken = String(tailParagraph.text || "").trim();
              if (!tailToken) continue;
              const tailStartOffset = tailParagraph.text.indexOf(tailToken);
              findings.push(
                buildFinding(
                  tailParagraph,
                  EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk,
                  Math.max(0, tailStartOffset),
                  Math.max(0, tailStartOffset) + tailToken.length,
                  tailToken
                )
              );
            }
            index = nestedTrailingSectionEnd;
            break;
          }
        }

        const isAnchor = cursor === index || hasSourceJunkAnchor(token);
        // A supporter-list signal (Supporters / ผู้สนับสนุน / Power Stones /
        // top-10) must open supporter context BEFORE boundary evaluation so
        // the signal line itself and the plain handles that follow it (e.g.
        // Unown, Oboro) stay inside the junk block in supporter-list context.
        if (isSourceJunkSupporterSignal(token)) supporterListContext = true;
        const isSupporterHandle =
          supporterListContext && isPlainSupporterHandle(token);
        if (
          !isAnchor &&
          !isSourceJunkContinuation(token) &&
          !isSupporterHandle &&
          !isSupporterListHeadingLine(token)
        ) {
          // A normal narrative paragraph is an explicit block boundary. Do not
          // inherit source_junk into the rest of the chapter merely because an
          // author note appeared earlier in the tab.
          index = cursor - 1;
          break;
        }
        if (!token) continue;
        const startOffset = paragraph.text.indexOf(token);
        findings.push(
          buildFinding(
            paragraph,
            EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk,
            Math.max(0, startOffset),
            Math.max(0, startOffset) + token.length,
            token
          )
        );
        if (cursor === ordered.length - 1) index = cursor;
      }
    }
  }
  return findings;
}

export function evaluateEditorialForeignDraft(input: {
  paragraphs: readonly EditorialCheckerParagraphInput[];
  allowWords?: readonly string[];
}) {
  const allowWords = new Set(
    (input.allowWords ?? []).map(normalizeEditorialAllowedWord).filter(Boolean)
  );
  const findings = [
    ...input.paragraphs.flatMap(paragraph =>
      evaluateEditorialForeignParagraph(paragraph, allowWords)
    ),
    ...evaluateEditorialSourceJunkBlocks(input.paragraphs),
  ].sort(
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

export type EditorialCheckerStaleReason =
  | "DRAFT_CHANGED"
  | "ENGINE_CHANGED"
  | "ALLOW_LIST_CHANGED";

export function getEditorialCheckerStaleReason(input: {
  currentDraftId: number | null | undefined;
  runDraftId: number;
  runEngineVersion: string;
  currentEngineVersion: string;
  runAllowListSha256: string;
  currentAllowListSha256: string;
}): EditorialCheckerStaleReason | null {
  if (!input.currentDraftId || input.runDraftId !== input.currentDraftId) {
    return "DRAFT_CHANGED";
  }
  if (input.runEngineVersion !== input.currentEngineVersion) {
    return "ENGINE_CHANGED";
  }
  if (input.runAllowListSha256 !== input.currentAllowListSha256) {
    return "ALLOW_LIST_CHANGED";
  }
  return null;
}
