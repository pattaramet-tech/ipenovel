/**
 * IPE-058-C — Single-canvas paragraph-aware chapter editor model.
 *
 * Pure client logic (no DOM) so it is directly unit-testable under the node
 * vitest project. The editing surface is ONE textarea over the flat canvas
 * text; the canonical model stays the paragraph-aware plain text used by the
 * `replace_tab` Draft boundary:
 *
 *   paragraphs  --join "\n\n"-->  canvas text
 *   canvas text --split on blank lines-->  paragraphs
 *
 * Identity reconciliation (fixes the IPE-058-A/B known positional-carry
 * defect): the canvas tracks each logical paragraph through operations, so
 * identity is carried by the SURVIVING LOGICAL PARAGRAPH, never by position.
 *
 * Operation rules (deterministic):
 * - unchanged paragraph: key preserved.
 * - text edit inside a paragraph: key preserved (the new piece inherits the
 *   unmatched previous node's identity).
 * - Enter / inserted blank line: the node splits; the FIRST piece keeps the
 *   node's key, every other piece is a new paragraph (fresh key on save).
 * - merge (blank line removed / Backspace across boundary): the merged node
 *   keeps the FIRST node's key; the other node's key disappears.
 * - delete: the node's key disappears; survivors keep their keys.
 * - insert: new node, no key; never steals a neighbouring key.
 * - paste of N paragraphs: first affected piece keeps the target node's key,
 *   all other pieces are new.
 * - reorder: identity follows the logical paragraph to its new position.
 *
 * Soft break: Shift+Enter inserts a single "\n" INSIDE the paragraph node.
 * The canonical boundary is a BLANK line ("\n\n"); single "\n" survives the
 * server's blank-line split and the round trip unchanged.
 *
 * Offsets are JavaScript UTF-16 code-unit indexes — the same convention as
 * checker findings (offsetEncoding "utf16"). No conversion happens anywhere.
 */

export type ChapterCanvasParagraph = {
  id: string;
  paragraphKey?: string;
  text: string;
};

const CANVAS_SEPARATOR = "\n\n";
const CANVAS_PARAGRAPH_SPLIT_RE = /\n[\t ]*\n+/;

function normalizeNewlines(value: string) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n");
}

/** Split raw canvas text into raw (untrimmed-edge) node texts. */
function splitCanvasPieces(canvasText: string) {
  const normalized = normalizeNewlines(canvasText);
  if (!normalized.trim()) return [];
  return normalized
    .split(CANVAS_PARAGRAPH_SPLIT_RE)
    .filter(piece => piece.trim() !== "");
}

function pieceIdentityKey(piece: string) {
  return normalizeNewlines(piece).trim();
}

/**
 * Deterministic conversion: paragraph nodes -> continuous canvas text.
 * Raw join (no trimming) so typing whitespace at paragraph edges is never
 * snapped back while editing.
 */
export function serializeChapterCanvasText(
  paragraphs: readonly ChapterCanvasParagraph[]
) {
  return paragraphs.map(paragraph => paragraph.text).join(CANVAS_SEPARATOR);
}

/**
 * Save projection: trimmed paragraphs + the aligned explicit identity list
 * for the `replace_tab` command ("" = new paragraph, server mints).
 */
export function serializeChapterCanvasForSave(
  paragraphs: readonly ChapterCanvasParagraph[]
): { text: string; replacementParagraphKeys: string[] } {
  const kept: ChapterCanvasParagraph[] = [];
  for (const paragraph of paragraphs) {
    const text = normalizeNewlines(paragraph.text).trim();
    if (!text) continue;
    kept.push({ ...paragraph, text });
  }
  return {
    text: kept.map(paragraph => paragraph.text).join(CANVAS_SEPARATOR),
    replacementParagraphKeys: kept.map(paragraph =>
      paragraph.paragraphKey ? String(paragraph.paragraphKey) : ""
    ),
  };
}

/** Canvas start offset of each paragraph node (UTF-16 code units). */
export function chapterCanvasParagraphStarts(
  paragraphs: readonly ChapterCanvasParagraph[]
) {
  const starts: number[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    starts.push(cursor);
    cursor += paragraph.text.length + CANVAS_SEPARATOR.length;
  }
  return starts;
}

function nodeIndexAtOffset(starts: number[], offset: number) {
  let index = 0;
  for (let position = 0; position < starts.length; position += 1) {
    if (starts[position]! <= offset) index = position;
    else break;
  }
  return index;
}

export type ChapterCanvasChangeResult = {
  paragraphs: ChapterCanvasParagraph[];
  changed: boolean;
  /** Suggested caret offset in the new canvas text after the change. */
  caret: number;
};

/**
 * Apply one continuous-canvas change (from a textarea change event) onto the
 * paragraph node model, preserving identity per the operation rules above.
 *
 * Algorithm (deterministic, O(n)):
 * 1. Split both canvas texts into pieces on blank lines.
 * 2. Match new pieces to previous nodes by identical trimmed text, k-th
 *    occurrence to k-th occurrence, in document order (handles duplicates,
 *    insert, delete, and reorder — identity follows the logical node).
 * 3. Pair each still-unmatched new piece with the next still-unmatched
 *    previous node in ORIGINAL document order: the new piece INHERITS that
 *    node's identity (text edit / split first piece / merge first piece).
 *    Leftover previous nodes are deleted (their keys disappear); leftover
 *    new pieces are new paragraphs (never stealing a key).
 */
export function applyChapterCanvasChange(input: {
  previous: readonly ChapterCanvasParagraph[];
  oldText: string;
  newText: string;
  nextId: () => string;
}): ChapterCanvasChangeResult {
  const { previous, oldText, newText, nextId } = input;
  if (oldText === newText) {
    return {
      paragraphs: [...previous],
      changed: false,
      caret: newText.length,
    };
  }

  // Caret projection: common prefix/suffix diff — O(n), single pass each.
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const inserted = newText.slice(prefix, newText.length - suffix);
  const caret = prefix + inserted.length;

  const oldPieces = splitCanvasPieces(oldText);
  const newPieces = splitCanvasPieces(newText);
  if (!newPieces.length) {
    // Whole canvas emptied: keep the first previous node's identity on the
    // single empty node (structural checkers see the empty tab, not a missing
    // paragraph identity).
    const anchor = previous[0];
    return {
      paragraphs: anchor
        ? [{ id: anchor.id, paragraphKey: anchor.paragraphKey, text: '' }]
        : [],
      changed: true,
      caret: 0,
    };
  }

  const available = new Map<string, ChapterCanvasParagraph[]>();
  for (const paragraph of previous) {
    const key = pieceIdentityKey(paragraph.text);
    if (!key) continue;
    const queue = available.get(key) ?? [];
    queue.push(paragraph);
    available.set(key, queue);
  }
  const matchedNodes = new Set<ChapterCanvasParagraph>();
  const matched: Array<ChapterCanvasParagraph | null> = newPieces.map(piece => {
    const queue = available.get(pieceIdentityKey(piece));
    const node = queue?.shift();
    if (node) matchedNodes.add(node);
    return node ?? null;
  });
  // Unmatched previous nodes in ORIGINAL document order (never Map.values()
  // order, which is first-seen text-key order and scrambles duplicates).
  const unmatchedPrevious = previous.filter(
    paragraph => !matchedNodes.has(paragraph)
  );

  // Pair unmatched new pieces with unmatched previous nodes in original document order.
  const paragraphs: ChapterCanvasParagraph[] = [];
  let unmatchedIndex = 0;
  for (let index = 0; index < newPieces.length; index += 1) {
    const piece = newPieces[index]!;
    const matchedNode = matched[index];
    if (matchedNode) {
      paragraphs.push({
        id: matchedNode.id,
        paragraphKey: matchedNode.paragraphKey,
        text: piece,
      });
      continue;
    }
    const inherited = unmatchedPrevious[unmatchedIndex];
    if (inherited) {
      unmatchedIndex += 1;
      paragraphs.push({
        id: inherited.id,
        paragraphKey: inherited.paragraphKey,
        text: piece,
      });
    } else {
      paragraphs.push({ id: nextId(), text: piece });
    }
  }
  return { paragraphs, changed: true, caret };
}

/** Map a canvas offset onto its paragraph node. */
export function chapterCanvasOffsetToParagraph(
  paragraphs: readonly ChapterCanvasParagraph[],
  offset: number
): { nodeIndex: number; offsetInNode: number; paragraph: ChapterCanvasParagraph } | null {
  if (!paragraphs.length) return null;
  const starts = chapterCanvasParagraphStarts(paragraphs);
  const nodeIndex = nodeIndexAtOffset(starts, offset);
  const paragraph = paragraphs[nodeIndex]!;
  return {
    nodeIndex,
    offsetInNode: Math.max(0, offset - starts[nodeIndex]!),
    paragraph,
  };
}

export type ChapterCanvasFindingRange = { start: number; end: number };

/**
 * Map a QC finding (paragraphKey + UTF-16 offsets within that paragraph) onto
 * the flat canvas text. Returns null when the finding cannot be targeted
 * safely — callers must fail gracefully and never highlight another
 * paragraph or a different text span in its place:
 * - the paragraphKey no longer exists (stale finding);
 * - offsets are not finite numbers (NaN/Infinity);
 * - offsets are negative;
 * - start > end;
 * - either offset exceeds the paragraph's UTF-16 length (no clamping onto
 *   the paragraph boundary — an invalid coordinate is no-target, period).
 *
 * A zero-width range (start === end) is valid (caret-style findings).
 */
export function chapterCanvasFindingRange(
  paragraphs: readonly ChapterCanvasParagraph[],
  finding: {
    paragraphKey?: string | null;
    startOffset?: number | null;
    endOffset?: number | null;
  }
): ChapterCanvasFindingRange | null {
  const paragraphKey = String(finding.paragraphKey ?? "");
  if (!paragraphKey) return null;
  const nodeIndex = paragraphs.findIndex(
    paragraph => paragraph.paragraphKey === paragraphKey
  );
  if (nodeIndex < 0) return null;
  const rawStart = Number(finding.startOffset ?? 0);
  const rawEnd = Number(finding.endOffset ?? rawStart);
  if (
    !Number.isFinite(rawStart) ||
    !Number.isFinite(rawEnd) ||
    rawStart < 0 ||
    rawEnd < 0 ||
    rawStart > rawEnd
  ) {
    return null;
  }
  const starts = chapterCanvasParagraphStarts(paragraphs);
  const nodeStart = starts[nodeIndex]!;
  const nodeLength = paragraphs[nodeIndex]!.text.length;
  if (rawStart > nodeLength || rawEnd > nodeLength) {
    return null;
  }
  return { start: nodeStart + rawStart, end: nodeStart + rawEnd };
}

/** Canvas offset of the start of a paragraph node (clamped). */
export function chapterCanvasParagraphStartOffset(
  paragraphs: readonly ChapterCanvasParagraph[],
  nodeIndex: number
) {
  if (!paragraphs.length) return 0;
  const starts = chapterCanvasParagraphStarts(paragraphs);
  return starts[Math.max(0, Math.min(nodeIndex, paragraphs.length - 1))]!;
}

/** Controlled undo/redo history for the canvas (never spans a server save). */
export type ChapterCanvasHistory = {
  undo: Array<{ paragraphs: ChapterCanvasParagraph[]; caret: number }>;
  redo: Array<{ paragraphs: ChapterCanvasParagraph[]; caret: number }>;
  limit: number;
};

export function createChapterCanvasHistory(limit = 200): ChapterCanvasHistory {
  return { undo: [], redo: [], limit };
}

export function pushChapterCanvasHistory(
  history: ChapterCanvasHistory,
  entry: { paragraphs: ChapterCanvasParagraph[]; caret: number }
): ChapterCanvasHistory {
  const undo = [...history.undo, entry];
  while (undo.length > history.limit) undo.shift();
  return { undo, redo: [], limit: history.limit };
}

export function undoChapterCanvas(
  history: ChapterCanvasHistory,
  current: { paragraphs: ChapterCanvasParagraph[]; caret: number }
): { history: ChapterCanvasHistory; entry: { paragraphs: ChapterCanvasParagraph[]; caret: number } | null } {
  const previous = history.undo[history.undo.length - 1];
  if (!previous) return { history, entry: null };
  return {
    history: {
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, current],
      limit: history.limit,
    },
    entry: previous,
  };
}

export function redoChapterCanvas(
  history: ChapterCanvasHistory,
  current: { paragraphs: ChapterCanvasParagraph[]; caret: number }
): { history: ChapterCanvasHistory; entry: { paragraphs: ChapterCanvasParagraph[]; caret: number } | null } {
  const next = history.redo[history.redo.length - 1];
  if (!next) return { history, entry: null };
  return {
    history: {
      undo: [...history.undo, current],
      redo: history.redo.slice(0, -1),
      limit: history.limit,
    },
    entry: next,
  };
}

/**
 * IPE-058-E review fix: canonical PRESENTATION state for the approval/QC
 * panel. pending_confirm is NOT a fallback — it exists ONLY when a current
 * Draft exists, QC evidence is CURRENT_READY, QC is ready, and the existing
 * approval is not already valid (and Stage is not already ready to publish).
 * Every other condition gets an explicit state, so a stale draft/checker or
 * an errored/running/missing checker can never display as pending_confirm.
 */
export type EditorialApprovalPresentationState =
  | "no_draft"
  | "checker_not_run"
  | "checking"
  | "checker_stale"
  | "checker_error"
  | "qc_blocked"
  | "pending_confirm"
  | "approved"
  | "ready_to_publish";

export function deriveApprovalPresentationState(input: {
  hasDraft: boolean;
  qcState:
    | "NOT_RUN"
    | "RUNNING"
    | "STALE"
    | "ERROR"
    | "CURRENT_HAS_FINDINGS"
    | "CURRENT_READY"
    | null
    | undefined;
  qcReady: boolean | null | undefined;
  approvalValid: boolean | null | undefined;
  readyToPublish: boolean | null | undefined;
}): EditorialApprovalPresentationState {
  if (!input.hasDraft) return "no_draft";
  if (input.readyToPublish) return "ready_to_publish";
  if (input.approvalValid) return "approved";
  if (input.qcState === "STALE") return "checker_stale";
  if (input.qcState === "ERROR") return "checker_error";
  if (input.qcState === "RUNNING") return "checking";
  if (input.qcState === "NOT_RUN" || input.qcState == null) {
    return "checker_not_run";
  }
  if (input.qcState === "CURRENT_READY" && input.qcReady) {
    return "pending_confirm";
  }
  // CURRENT_HAS_FINDINGS or a non-ready CURRENT_READY (defensive).
  return "qc_blocked";
}
