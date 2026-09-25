import type { NqaDocumentParagraph } from "./contracts";

const TAIL_SCAN_LIMIT = 24;

function normalized(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function isTailUiLine(text: string): boolean {
  return /^(?:comments?|ความคิดเห็น(?:\s+\d+)?|votes?|โหวต(?:\s+\d+)?|\d+\s*(?:votes?|โหวต)|(?:ส่ง|แสดง)ความคิดเห็น|หัวข้อ)$/i.test(
    normalized(text)
  );
}

function isWebNovelRecommendationAnchor(text: string): boolean {
  return /^(?:คุณอาจชอบ|you may also like|recommended(?: for you)?)$/i.test(
    normalized(text)
  );
}

function isWebNovelFooterPrefix(text: string): boolean {
  const value = normalized(text);
  return (
    /^[0-5](?:\.\d{1,2})?$/.test(value) ||
    /^(?:\d+\s*(?:votes?|โหวต)|votes?|โหวต(?:\s+\d+)?)$/i.test(value)
  );
}

function isPromoAnchor(text: string): boolean {
  const value = normalized(text);
  return (
    /patreon(?:\s*\(\s*\.\s*\)\s*com|\.com|\/|\b)/i.test(value) ||
    /https?:\/\/(?:www\.)?webnovel\.com\b/i.test(value) ||
    /\b(?:advance|advanced|early access|extra)\s+chapters?\b/i.test(value) ||
    /\bchapters?\b.{0,80}\b(?:ahead|advance|advanced|early)\b/i.test(value) ||
    /อ่านล่วงหน้า.{0,80}(?:บท|ตอน)/.test(value) ||
    /(?:บท|ตอน).{0,80}ล่วงหน้า/.test(value)
  );
}

function isSoftLeadIn(text: string): boolean {
  const value = normalized(text);
  return (
    /^(?:thanks?|thank you)\s+for\s+reading[!.\s]*$/i.test(value) ||
    /^ขอบคุณที่อ่าน(?:ค่ะ|ครับ)?[!.\s]*$/.test(value) ||
    /^(?:[-_*~=•·.]{3,}|…+)$/.test(value)
  );
}

export type NqaChapterTailSanitization = {
  paragraphs: NqaDocumentParagraph[];
  removedParagraphCount: number;
  cutParagraphIndex: number | null;
};

export function sanitizeNqaChapterTail(
  paragraphs: readonly NqaDocumentParagraph[]
): NqaChapterTailSanitization {
  if (paragraphs.length <= 1) {
    return {
      paragraphs: [...paragraphs],
      removedParagraphCount: 0,
      cutParagraphIndex: null,
    };
  }

  const scanStart = Math.max(1, paragraphs.length - TAIL_SCAN_LIMIT);
  let anchor = -1;
  let webNovelFooter = false;

  for (let index = scanStart; index < paragraphs.length; index += 1) {
    if (isPromoAnchor(paragraphs[index].text)) {
      anchor = index;
      break;
    }

    if (isWebNovelRecommendationAnchor(paragraphs[index].text)) {
      const hasUiEvidence = paragraphs
        .slice(index + 1)
        .some(paragraph => isTailUiLine(paragraph.text));
      if (hasUiEvidence) {
        anchor = index;
        webNovelFooter = true;
        break;
      }
    }
  }

  if (anchor < 0) {
    const uiIndexes: number[] = [];
    for (let index = scanStart; index < paragraphs.length; index += 1) {
      if (isTailUiLine(paragraphs[index].text)) uiIndexes.push(index);
    }
    if (uiIndexes.length >= 2) anchor = uiIndexes[0];
  }

  if (anchor < 0) {
    return {
      paragraphs: [...paragraphs],
      removedParagraphCount: 0,
      cutParagraphIndex: null,
    };
  }

  let cut = anchor;
  while (
    cut > scanStart &&
    (isSoftLeadIn(paragraphs[cut - 1].text) ||
      (webNovelFooter && isWebNovelFooterPrefix(paragraphs[cut - 1].text)))
  ) {
    cut -= 1;
  }

  return {
    paragraphs: paragraphs.slice(0, cut),
    removedParagraphCount: paragraphs.length - cut,
    cutParagraphIndex: cut,
  };
}
