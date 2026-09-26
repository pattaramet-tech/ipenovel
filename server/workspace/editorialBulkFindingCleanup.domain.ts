import { createHash } from "node:crypto";
import {
  reindexEditorialDraftDocument,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";

export const EDITORIAL_BULK_CLEANUP_VERSION =
  "workspace-editorial-bulk-cleanup-v1" as const;

export type EditorialBulkCleanupFinding = {
  findingKey: string;
  ruleKey: string;
  token: string;
  normalizedToken: string;
  sourceTabId: string;
  paragraphKey: string;
  paragraphOrder: number;
  paragraphFingerprint: string;
  startOffset: number;
  endOffset: number;
  disposition?: string;
  resolutionVersion?: number;
};

export type EditorialBulkCleanupAction =
  | { kind: "group"; groupKey: string }
  | { kind: "source_junk" };

export type EditorialBulkCleanupGroup = {
  groupKey: string;
  ruleKey: string;
  normalizedToken: string;
  displayToken: string;
  occurrenceCount: number;
  paragraphCount: number;
  workItemCount: number;
  workItemIds: number[];
};

export class EditorialBulkCleanupDomainError extends Error {
  constructor(
    readonly code:
      | "FINDING_STALE"
      | "FINDING_RANGE_CONFLICT"
      | "NO_CHANGE"
      | "DUPLICATE_RANGE",
    message: string
  ) {
    super(message);
    this.name = "EditorialBulkCleanupDomainError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function editorialBulkCleanupGroupKey(input: {
  ruleKey: string;
  normalizedToken: string;
}) {
  return sha256(
    JSON.stringify({
      version: EDITORIAL_BULK_CLEANUP_VERSION,
      ruleKey: input.ruleKey,
      normalizedToken: input.normalizedToken,
    })
  );
}

export function groupEditorialBulkCleanupFindings(
  rows: Array<{ workItemId: number; finding: EditorialBulkCleanupFinding }>
): EditorialBulkCleanupGroup[] {
  const groups = new Map<
    string,
    {
      groupKey: string;
      ruleKey: string;
      normalizedToken: string;
      displayToken: string;
      occurrenceCount: number;
      paragraphKeys: Set<string>;
      workItemIds: Set<number>;
    }
  >();

  for (const row of rows) {
    if (row.finding.disposition && row.finding.disposition !== "open") continue;
    const normalizedToken =
      row.finding.normalizedToken || row.finding.token.normalize("NFC").trim();
    if (!normalizedToken) continue;
    const groupKey = editorialBulkCleanupGroupKey({
      ruleKey: row.finding.ruleKey,
      normalizedToken,
    });
    const group = groups.get(groupKey) ?? {
      groupKey,
      ruleKey: row.finding.ruleKey,
      normalizedToken,
      displayToken: row.finding.token,
      occurrenceCount: 0,
      paragraphKeys: new Set<string>(),
      workItemIds: new Set<number>(),
    };
    group.occurrenceCount += 1;
    group.paragraphKeys.add(`${row.workItemId}:${row.finding.paragraphKey}`);
    group.workItemIds.add(row.workItemId);
    groups.set(groupKey, group);
  }

  return Array.from(groups.values())
    .map(group => ({
      groupKey: group.groupKey,
      ruleKey: group.ruleKey,
      normalizedToken: group.normalizedToken,
      displayToken: group.displayToken,
      occurrenceCount: group.occurrenceCount,
      paragraphCount: group.paragraphKeys.size,
      workItemCount: group.workItemIds.size,
      workItemIds: Array.from(group.workItemIds).sort((a, b) => a - b),
    }))
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount ||
        a.displayToken.localeCompare(b.displayToken, "th")
    );
}

export function findingMatchesEditorialBulkCleanupAction(
  finding: EditorialBulkCleanupFinding,
  action: EditorialBulkCleanupAction
) {
  if (finding.disposition && finding.disposition !== "open") return false;
  if (action.kind === "source_junk") return finding.ruleKey === "source_junk";
  return (
    editorialBulkCleanupGroupKey({
      ruleKey: finding.ruleKey,
      normalizedToken:
        finding.normalizedToken || finding.token.normalize("NFC").trim(),
    }) === action.groupKey
  );
}

function compactAfterRemoval(value: string) {
  return value
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?ๆฯ])/g, "$1")
    .trim();
}

export function applyEditorialBulkCleanupToDocument(input: {
  document: EditorialDraftDocument;
  findings: readonly EditorialBulkCleanupFinding[];
}) {
  if (!input.findings.length) {
    throw new EditorialBulkCleanupDomainError(
      "NO_CHANGE",
      "No open findings matched this cleanup action."
    );
  }

  const next = JSON.parse(
    JSON.stringify(input.document)
  ) as EditorialDraftDocument;
  const byParagraph = new Map<string, EditorialBulkCleanupFinding[]>();
  for (const finding of input.findings) {
    const bucket = byParagraph.get(finding.paragraphKey) ?? [];
    bucket.push(finding);
    byParagraph.set(finding.paragraphKey, bucket);
  }

  let removedFindingCount = 0;
  let removedParagraphCount = 0;
  const changedParagraphKeys: string[] = [];

  for (const tab of next.tabs) {
    const kept = [];
    for (const paragraph of tab.paragraphs) {
      const findings = byParagraph.get(paragraph.paragraphKey);
      if (!findings?.length) {
        kept.push(paragraph);
        continue;
      }
      if (
        findings.some(
          finding =>
            finding.sourceTabId !== tab.sourceTabId ||
            finding.paragraphFingerprint !== paragraph.paragraphFingerprint
        )
      ) {
        throw new EditorialBulkCleanupDomainError(
          "FINDING_STALE",
          "Finding paragraph identity changed before bulk cleanup."
        );
      }

      changedParagraphKeys.push(paragraph.paragraphKey);

      if (findings.some(finding => finding.ruleKey === "source_junk")) {
        removedFindingCount += findings.length;
        removedParagraphCount += 1;
        continue;
      }

      const ordered = [...findings].sort(
        (a, b) => b.startOffset - a.startOffset || b.endOffset - a.endOffset
      );
      let text = paragraph.text;
      let previousStart = Number.POSITIVE_INFINITY;
      for (const finding of ordered) {
        if (
          !Number.isInteger(finding.startOffset) ||
          !Number.isInteger(finding.endOffset) ||
          finding.startOffset < 0 ||
          finding.endOffset <= finding.startOffset ||
          finding.endOffset > paragraph.text.length
        ) {
          throw new EditorialBulkCleanupDomainError(
            "FINDING_RANGE_CONFLICT",
            "Finding range is outside the current paragraph."
          );
        }
        if (finding.endOffset > previousStart) {
          throw new EditorialBulkCleanupDomainError(
            "DUPLICATE_RANGE",
            "Overlapping findings cannot be bulk-deleted safely."
          );
        }
        if (
          paragraph.text.slice(finding.startOffset, finding.endOffset) !==
          finding.token
        ) {
          throw new EditorialBulkCleanupDomainError(
            "FINDING_RANGE_CONFLICT",
            "Finding token no longer matches the current paragraph."
          );
        }
        text =
          text.slice(0, finding.startOffset) +
          text.slice(finding.endOffset);
        previousStart = finding.startOffset;
        removedFindingCount += 1;
      }
      const replacement = compactAfterRemoval(text);
      if (replacement) {
        paragraph.text = replacement;
        kept.push(paragraph);
      } else {
        removedParagraphCount += 1;
      }
    }
    tab.paragraphs = kept;
  }

  if (!changedParagraphKeys.length) {
    throw new EditorialBulkCleanupDomainError(
      "NO_CHANGE",
      "Bulk cleanup produced no Draft change."
    );
  }

  const document = reindexEditorialDraftDocument(next);
  return {
    document,
    removedFindingCount,
    removedParagraphCount,
    changedParagraphCount: new Set(changedParagraphKeys).size,
    changedParagraphKeys: Array.from(new Set(changedParagraphKeys)),
  };
}

export function editorialBulkCleanupPreviewFingerprint(input: {
  workspaceId: number;
  workItemIds: readonly number[];
  workItems: readonly {
    workItemId: number;
    draftId: number | null;
    draftVersion: number | null;
    draftSha256: string | null;
    runId: number | null;
    engineVersion: string | null;
    isCurrent: boolean;
    openFindings: readonly EditorialBulkCleanupFinding[];
  }[];
}) {
  return sha256(
    JSON.stringify({
      version: EDITORIAL_BULK_CLEANUP_VERSION,
      workspaceId: input.workspaceId,
      workItemIds: [...input.workItemIds].sort((a, b) => a - b),
      workItems: [...input.workItems]
        .sort((a, b) => a.workItemId - b.workItemId)
        .map(item => ({
          workItemId: item.workItemId,
          draftId: item.draftId,
          draftVersion: item.draftVersion,
          draftSha256: item.draftSha256,
          runId: item.runId,
          engineVersion: item.engineVersion,
          isCurrent: item.isCurrent,
          openFindings: [...item.openFindings]
            .sort((a, b) => a.findingKey.localeCompare(b.findingKey))
            .map(finding => ({
              findingKey: finding.findingKey,
              ruleKey: finding.ruleKey,
              normalizedToken: finding.normalizedToken,
              token: finding.token,
              sourceTabId: finding.sourceTabId,
              paragraphKey: finding.paragraphKey,
              paragraphOrder: finding.paragraphOrder,
              paragraphFingerprint: finding.paragraphFingerprint,
              startOffset: finding.startOffset,
              endOffset: finding.endOffset,
              disposition: finding.disposition ?? "open",
              resolutionVersion: finding.resolutionVersion ?? 0,
            })),
        })),
    })
  );
}
