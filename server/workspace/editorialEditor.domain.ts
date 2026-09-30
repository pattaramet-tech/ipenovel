import { createHash } from "node:crypto";
import {
  editorialDraftSha256,
  paragraphFingerprint,
  reindexEditorialDraftDocument,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";

export const EDITORIAL_EDITOR_VERSION = "workspace-editor-v1" as const;

export type EditorialEditKind =
  | "replace_sentence"
  | "replace_range"
  | "replace_paragraph"
  | "replace_tab";

export type EditorialParagraphEditCommand = {
  kind: "replace_sentence" | "replace_range" | "replace_paragraph";
  paragraphKey: string;
  expectedParagraphFingerprint: string;
  startOffset?: number;
  endOffset?: number;
  expectedText: string;
  replacementText: string;
};

export type EditorialTabEditCommand = {
  kind: "replace_tab";
  sourceTabId: string;
  expectedTabStructuralSha256: string;
  expectedText: string;
  replacementText: string;
  /**
   * IPE-058-C: explicit logical paragraph identity, one entry per replacement
   * paragraph in order. A non-empty key that exists in the current tab
   * declares "this replacement paragraph IS that logical paragraph" (text may
   * be edited — identity is preserved). An empty string (or a key not present
   * in the tab) declares a NEW paragraph; the server mints a fresh key.
   * Omitted entirely = legacy callers: identity is reconciled by exact-text
   * occurrence matching (k-th occurrence maps to the k-th previous paragraph
   * with identical text), so insertions never steal neighbouring keys.
   */
  replacementParagraphKeys?: string[];
};

export type EditorialDraftEditCommand =
  | EditorialParagraphEditCommand
  | EditorialTabEditCommand;

export class EditorialEditorDomainError extends Error {
  constructor(
    readonly code:
      | "PARAGRAPH_NOT_FOUND"
      | "PARAGRAPH_AMBIGUOUS"
      | "PARAGRAPH_CONFLICT"
      | "TAB_NOT_FOUND"
      | "TAB_AMBIGUOUS"
      | "TAB_CONFLICT"
      | "RANGE_INVALID"
      | "RANGE_CONFLICT"
      | "REPLACEMENT_INVALID"
      | "NO_CHANGE",
    message: string
  ) {
    super(message);
    this.name = "EditorialEditorDomainError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneDocument(document: EditorialDraftDocument) {
  return JSON.parse(JSON.stringify(document)) as EditorialDraftDocument;
}

function validateReplacement(value: string) {
  const replacement = String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n");
  if (replacement.length > 200_000) {
    throw new EditorialEditorDomainError(
      "REPLACEMENT_INVALID",
      "Replacement text exceeds the 200,000-character paragraph limit."
    );
  }
  if (replacement.includes("\n")) {
    throw new EditorialEditorDomainError(
      "REPLACEMENT_INVALID",
      "A paragraph edit cannot introduce a line break. Edit paragraphs separately."
    );
  }
  return replacement;
}

function normalizeTabEditorText(value: string) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
}

export function editorialTabEditorText(
  tab: EditorialDraftDocument["tabs"][number]
) {
  return tab.paragraphs.map(paragraph => paragraph.text).join("\n\n");
}

function tabEditorParagraphs(value: string) {
  const normalized = normalizeTabEditorText(value).trim();
  if (!normalized) return [];
  if (normalized.length > 2_000_000) {
    throw new EditorialEditorDomainError(
      "REPLACEMENT_INVALID",
      "Tab replacement exceeds the 2,000,000-character limit."
    );
  }
  const paragraphs = normalized
    .split(/\n[\t ]*\n+/)
    .map(text => text.trim())
    .filter(Boolean);
  if (paragraphs.length > 10_000 || paragraphs.some(text => text.length > 200_000)) {
    throw new EditorialEditorDomainError(
      "REPLACEMENT_INVALID",
      "Tab replacement exceeds the paragraph count or paragraph size limit."
    );
  }
  return paragraphs;
}

function applyEditorialTabEdit(
  document: EditorialDraftDocument,
  command: EditorialTabEditCommand,
  mintOptions?: { identitySeed?: string }
) {
  const next = cloneDocument(document);
  const matches = next.tabs
    .map((tab, tabIndex) => ({ tab, tabIndex }))
    .filter(({ tab }) => tab.sourceTabId === command.sourceTabId);
  if (!matches.length) {
    throw new EditorialEditorDomainError(
      "TAB_NOT_FOUND",
      "Tab identity was not found in the expected Draft."
    );
  }
  if (matches.length !== 1) {
    throw new EditorialEditorDomainError(
      "TAB_AMBIGUOUS",
      "Tab identity is ambiguous in the expected Draft."
    );
  }

  const { tab, tabIndex } = matches[0]!;
  if (tab.structuralSha256 !== command.expectedTabStructuralSha256) {
    throw new EditorialEditorDomainError(
      "TAB_CONFLICT",
      "Tab structure changed before the edit was applied."
    );
  }
  const beforeText = editorialTabEditorText(tab);
  if (normalizeTabEditorText(command.expectedText) !== beforeText) {
    throw new EditorialEditorDomainError(
      "TAB_CONFLICT",
      "Whole-tab expected text no longer matches the Draft."
    );
  }

  const replacementText = normalizeTabEditorText(command.replacementText);
  const replacementParagraphs = tabEditorParagraphs(replacementText);
  const canonicalReplacement = replacementParagraphs.join("\n\n");
  if (canonicalReplacement === beforeText) {
    throw new EditorialEditorDomainError(
      "NO_CHANGE",
      "Replacement does not change the Draft."
    );
  }

  const previousParagraphs = tab.paragraphs;
  const previousKeys = new Set(
    previousParagraphs.map(paragraph => paragraph.paragraphKey)
  );
  let inheritedKeys: Array<string | null>;
  if (command.replacementParagraphKeys) {
    // Canvas path: the editing surface declares logical identity explicitly.
    const provided = command.replacementParagraphKeys;
    if (provided.length !== replacementParagraphs.length) {
      throw new EditorialEditorDomainError(
        "TAB_CONFLICT",
        "Replacement paragraph identity count does not match the replacement text."
      );
    }
    const seen = new Set<string>();
    for (const key of provided) {
      if (!key) continue;
      if (seen.has(key)) {
        throw new EditorialEditorDomainError(
          "TAB_CONFLICT",
          "Duplicate replacement paragraph identity."
        );
      }
      seen.add(key);
    }
    inheritedKeys = provided.map(key =>
      key && previousKeys.has(key) ? key : null
    );
  } else {
    // Legacy path: deterministic occurrence matching — the k-th replacement
    // paragraph with a given text inherits the k-th previous paragraph with
    // the identical text. Insertions therefore never steal neighbouring keys;
    // deleted paragraphs' keys simply disappear.
    const available = new Map<string, string[]>();
    for (const paragraph of previousParagraphs) {
      const queue = available.get(paragraph.text) ?? [];
      queue.push(paragraph.paragraphKey);
      available.set(paragraph.text, queue);
    }
    inheritedKeys = replacementParagraphs.map(text => {
      const queue = available.get(text);
      const key = queue?.shift();
      return key ?? null;
    });
  }

  let mintOrdinal = 0;
  // IPE-058-C review fix: minted keys are scoped by an immutable
  // mutation-identity seed so a fresh logical paragraph created in a LATER
  // Draft revision can never reuse the paragraphKey of a deleted paragraph
  // (stale QC evidence must never retarget a recreated paragraph). The
  // service passes the edit idempotency payload SHA — identical for an exact
  // mutation retry (idempotent), different across Draft revisions
  // (expectedDraftId/Version/Sha are part of the payload). Direct domain
  // callers without a seed get "" (deterministic within one save only).
  const identitySeed = mintOptions?.identitySeed ?? "";
  tab.paragraphs = replacementParagraphs.map((text, index) => {
    const inheritedKey = inheritedKeys[index];
    const previous = inheritedKey
      ? previousParagraphs.find(
          paragraph => paragraph.paragraphKey === inheritedKey
        )
      : undefined;
    const unchanged = previous?.text === text;
    const sourceParagraphIndex =
      previous && (unchanged || previous.sourceParagraphIndex > 0)
        ? previous.sourceParagraphIndex
        : -(index + 1);
    const sourceParagraphFingerprint =
      previous && (unchanged || previous.sourceParagraphIndex > 0)
        ? previous.sourceParagraphFingerprint
        : paragraphFingerprint(text);
    // Minted keys use a dedicated domain + mutation-identity seed + per-save
    // ordinal: unique across Draft revisions (seed), unique within one save
    // (ordinal), and stable for an exact mutation retry.
    const paragraphKey =
      inheritedKey ??
      sha256(
        [
          "workspace-editorial-tab-paragraph-v3",
          tab.sourceTabId,
          identitySeed,
          String((mintOrdinal += 1)),
          text,
        ].join("\0")
      );
    return {
      paragraphKey,
      sourceParagraphIndex,
      paragraphOrder: index + 1,
      text,
      sourceParagraphFingerprint,
      sourceOccurrenceCount: previous?.sourceOccurrenceCount ?? 1,
      sourceOccurrenceOrdinal: previous?.sourceOccurrenceOrdinal ?? 1,
      paragraphFingerprint: paragraphFingerprint(text),
      occurrenceCount: 1,
      occurrenceOrdinal: 1,
    };
  });

  const reindexed = reindexEditorialDraftDocument(next);
  const updatedTab = reindexed.tabs[tabIndex]!;
  const beforeSha256 = editorialDraftSha256(reindexEditorialDraftDocument(document));
  const afterSha256 = editorialDraftSha256(reindexed);
  return {
    document: reindexed,
    beforeSha256,
    afterSha256,
    details: {
      editorVersion: EDITORIAL_EDITOR_VERSION,
      kind: command.kind,
      sourceTabId: command.sourceTabId,
      beforeTabStructuralSha256: command.expectedTabStructuralSha256,
      afterTabStructuralSha256: updatedTab.structuralSha256,
      expectedTextSha256: sha256(command.expectedText),
      replacementTextSha256: sha256(canonicalReplacement),
      beforeParagraphCount: previousParagraphs.length,
      afterParagraphCount: updatedTab.paragraphs.length,
    },
  };
}

export function applyEditorialDraftEdit(
  document: EditorialDraftDocument,
  command: EditorialDraftEditCommand,
  mintOptions?: { identitySeed?: string }
) {
  if (command.kind === "replace_tab") {
    return applyEditorialTabEdit(document, command, mintOptions);
  }
  const next = cloneDocument(document);
  const matches: Array<{
    tabIndex: number;
    paragraphIndex: number;
    paragraph: EditorialDraftDocument["tabs"][number]["paragraphs"][number];
  }> = [];

  next.tabs.forEach((tab, tabIndex) => {
    tab.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraph.paragraphKey === command.paragraphKey) {
        matches.push({ tabIndex, paragraphIndex, paragraph });
      }
    });
  });

  if (!matches.length) {
    throw new EditorialEditorDomainError(
      "PARAGRAPH_NOT_FOUND",
      "Paragraph identity was not found in the expected Draft."
    );
  }
  if (matches.length !== 1) {
    throw new EditorialEditorDomainError(
      "PARAGRAPH_AMBIGUOUS",
      "Paragraph identity is ambiguous in the expected Draft."
    );
  }

  const target = matches[0];
  if (
    target.paragraph.paragraphFingerprint !==
    command.expectedParagraphFingerprint
  ) {
    throw new EditorialEditorDomainError(
      "PARAGRAPH_CONFLICT",
      "Paragraph fingerprint changed before the edit was applied."
    );
  }

  const beforeText = target.paragraph.text;
  const replacementText = validateReplacement(command.replacementText);
  let afterText: string;
  let startOffset = 0;
  let endOffset = beforeText.length;

  if (command.kind === "replace_paragraph") {
    if (command.expectedText !== beforeText) {
      throw new EditorialEditorDomainError(
        "PARAGRAPH_CONFLICT",
        "Whole-paragraph expected text no longer matches the Draft."
      );
    }
    afterText = replacementText;
  } else {
    startOffset = Number(command.startOffset);
    endOffset = Number(command.endOffset);
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset < startOffset ||
      endOffset > beforeText.length
    ) {
      throw new EditorialEditorDomainError(
        "RANGE_INVALID",
        "Edit range is outside the paragraph."
      );
    }
    if (beforeText.slice(startOffset, endOffset) !== command.expectedText) {
      throw new EditorialEditorDomainError(
        "RANGE_CONFLICT",
        "Expected sentence/range text no longer matches the Draft."
      );
    }
    afterText =
      beforeText.slice(0, startOffset) +
      replacementText +
      beforeText.slice(endOffset);
  }

  if (afterText === beforeText) {
    throw new EditorialEditorDomainError(
      "NO_CHANGE",
      "Replacement does not change the Draft."
    );
  }

  target.paragraph.text = afterText;
  const reindexed = reindexEditorialDraftDocument(next);
  const updated =
    reindexed.tabs[target.tabIndex].paragraphs[target.paragraphIndex];
  const beforeSha256 = editorialDraftSha256(
    reindexEditorialDraftDocument(document)
  );
  const afterSha256 = editorialDraftSha256(reindexed);

  return {
    document: reindexed,
    beforeSha256,
    afterSha256,
    details: {
      editorVersion: EDITORIAL_EDITOR_VERSION,
      kind: command.kind,
      paragraphKey: command.paragraphKey,
      beforeParagraphFingerprint: command.expectedParagraphFingerprint,
      afterParagraphFingerprint: paragraphFingerprint(updated.text),
      startOffset,
      endOffset,
      expectedTextSha256: sha256(command.expectedText),
      replacementTextSha256: sha256(replacementText),
      beforeParagraphTextSha256: sha256(beforeText),
      afterParagraphTextSha256: sha256(afterText),
    },
  };
}

export function editorialEditIdempotencyPayloadSha256(input: {
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  command: EditorialDraftEditCommand;
  findingKey?: string | null;
}) {
  return sha256(
    JSON.stringify({
      editorVersion: EDITORIAL_EDITOR_VERSION,
      expectedDraftId: input.expectedDraftId,
      expectedDraftVersion: input.expectedDraftVersion,
      expectedDraftSha256: input.expectedDraftSha256,
      findingKey: input.findingKey ?? null,
      command: input.command,
    })
  );
}
