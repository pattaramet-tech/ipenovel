import { createHash } from "node:crypto";
import {
  editorialDraftSha256,
  paragraphFingerprint,
  reindexEditorialDraftDocument,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";

export const EDITORIAL_EDITOR_VERSION = "workspace-editor-v1" as const;

export type EditorialEditKind =
  "replace_sentence" | "replace_range" | "replace_paragraph";

export type EditorialDraftEditCommand = {
  kind: EditorialEditKind;
  paragraphKey: string;
  expectedParagraphFingerprint: string;
  startOffset?: number;
  endOffset?: number;
  expectedText: string;
  replacementText: string;
};

export class EditorialEditorDomainError extends Error {
  constructor(
    readonly code:
      | "PARAGRAPH_NOT_FOUND"
      | "PARAGRAPH_AMBIGUOUS"
      | "PARAGRAPH_CONFLICT"
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

export function applyEditorialDraftEdit(
  document: EditorialDraftDocument,
  command: EditorialDraftEditCommand
) {
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
