import { createHash } from "node:crypto";

export const EDITORIAL_APPROVAL_CONTRACT =
  "workspace-editorial-approval-v1" as const;
export const EDITORIAL_EPISODE_STAGE_CONTRACT =
  "workspace-editorial-episode-stage-v1" as const;

export type EditorialEpisodeDraftInput = {
  workItemType: "new_story" | "new_episode";
  episodeNumber: string | null;
  episodeTitle: string | null;
  tabs: Array<{
    sourceTabId: string;
    tabOrder: number;
    title: string;
    chapterNumber: string | null;
    chapterTitle: string | null;
    paragraphs: Array<{
      paragraphOrder: number;
      text: string;
    }>;
  }>;
};

export type EditorialEpisodeDraftPlan = {
  episodeNumber: string;
  title: string;
  content: string;
  contentFormat: "plain_text";
  wordCount: number;
  sourceTabId: string;
  sourceTabTitle: string;
  sourceTitleLine: string;
  contentSha256: string;
};

export class EditorialApprovalDomainError extends Error {
  constructor(
    readonly code:
      | "WORK_ITEM_NOT_EPISODE"
      | "EPISODE_NUMBER_REQUIRED"
      | "DRAFT_STRUCTURE_AMBIGUOUS"
      | "TITLE_REQUIRED"
      | "CONTENT_REQUIRED"
      | "EPISODE_NUMBER_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "EditorialApprovalDomainError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const THAI_DIGITS: Record<string, string> = {
  "๐": "0",
  "๑": "1",
  "๒": "2",
  "๓": "3",
  "๔": "4",
  "๕": "5",
  "๖": "6",
  "๗": "7",
  "๘": "8",
  "๙": "9",
};

export function normalizeEditorialEpisodeNumber(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[๐-๙]/g, char => THAI_DIGITS[char] ?? char)
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseEditorialEpisodeHeading(value: string) {
  const text = String(value || "")
    .normalize("NFKC")
    .trim();
  if (!text) return null;
  const normalizedDigits = text.replace(
    /[๐-๙]/g,
    char => THAI_DIGITS[char] ?? char
  );
  const match = normalizedDigits.match(
    /^(?:#\s*|บท(?:ที่)?\s*|ตอน(?:ที่)?\s*|chapters?\s*|ch\.?\s*|episodes?\s*|ep\.?\s*)([0-9]+(?:\s*[-–—]\s*[0-9]+)?)\s*(?:[:：.\-]\s*)?(.*)$/i
  );
  if (!match) return null;
  return {
    episodeNumber: normalizeEditorialEpisodeNumber(match[1]),
    titleRemainder: String(match[2] || "").trim(),
  };
}

function countWords(content: string) {
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
}

export function buildEditorialEpisodeDraftPlan(
  input: EditorialEpisodeDraftInput
): EditorialEpisodeDraftPlan {
  if (input.workItemType !== "new_episode") {
    throw new EditorialApprovalDomainError(
      "WORK_ITEM_NOT_EPISODE",
      "Episode staging requires a NEW_EPISODE work item."
    );
  }
  const episodeNumber = normalizeEditorialEpisodeNumber(
    input.episodeNumber ?? ""
  );
  if (!episodeNumber) {
    throw new EditorialApprovalDomainError(
      "EPISODE_NUMBER_REQUIRED",
      "Episode staging requires an episode number."
    );
  }

  const tabs = input.tabs.slice().sort((a, b) => a.tabOrder - b.tabOrder);
  if (tabs.length !== 1) {
    throw new EditorialApprovalDomainError(
      "DRAFT_STRUCTURE_AMBIGUOUS",
      "A NEW_EPISODE work item must resolve to exactly one Draft tab before staging."
    );
  }
  const tab = tabs[0];
  const paragraphs = tab.paragraphs
    .slice()
    .sort((a, b) => a.paragraphOrder - b.paragraphOrder);
  const titleIndex = paragraphs.findIndex(row => String(row.text || "").trim());
  if (titleIndex < 0) {
    throw new EditorialApprovalDomainError(
      "TITLE_REQUIRED",
      "Draft has no non-empty title line."
    );
  }
  const sourceTitleLine = String(paragraphs[titleIndex].text || "").trim();
  const parsedHeading = parseEditorialEpisodeHeading(sourceTitleLine);
  const chapterNumber = normalizeEditorialEpisodeNumber(
    tab.chapterNumber ?? ""
  );
  const detectedNumber = parsedHeading?.episodeNumber || chapterNumber || null;
  if (
    detectedNumber &&
    normalizeEditorialEpisodeNumber(detectedNumber) !== episodeNumber
  ) {
    throw new EditorialApprovalDomainError(
      "EPISODE_NUMBER_CONFLICT",
      `Draft heading episode number ${detectedNumber} does not match work item episode number ${episodeNumber}.`
    );
  }

  const explicitTitle = String(input.episodeTitle || "").trim();
  const parsedTitle = String(
    parsedHeading?.titleRemainder || tab.chapterTitle || ""
  ).trim();
  // Production package export treats the first non-empty line as the title.
  // Preserve that behavior when intake metadata did not provide an explicit title.
  const title = explicitTitle || sourceTitleLine || parsedTitle;
  if (!title) {
    throw new EditorialApprovalDomainError(
      "TITLE_REQUIRED",
      "Episode title could not be resolved."
    );
  }

  const content = paragraphs
    .slice(titleIndex + 1)
    .map(row => String(row.text || "").trimEnd())
    .join("\n\n")
    .trim();
  if (!content) {
    throw new EditorialApprovalDomainError(
      "CONTENT_REQUIRED",
      "Episode staging requires content after the first non-empty title line."
    );
  }

  return {
    episodeNumber,
    title,
    content,
    contentFormat: "plain_text",
    wordCount: countWords(content),
    sourceTabId: tab.sourceTabId,
    sourceTabTitle: tab.title,
    sourceTitleLine,
    contentSha256: sha256(content),
  };
}

export function editorialQcEvidenceSha256(input: {
  runId: number;
  draftId: number;
  engineVersion: string;
  allowListSha256: string;
  findings: Array<{
    findingKey: string;
    disposition: string;
    resolutionVersion: number;
  }>;
}) {
  const findings = input.findings
    .map(finding => ({
      findingKey: finding.findingKey,
      disposition: finding.disposition,
      resolutionVersion: finding.resolutionVersion,
    }))
    .sort((a, b) => a.findingKey.localeCompare(b.findingKey));
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_APPROVAL_CONTRACT,
      runId: input.runId,
      draftId: input.draftId,
      engineVersion: input.engineVersion,
      allowListSha256: input.allowListSha256.toLowerCase(),
      findings,
    })
  );
}

export function editorialApprovalPayloadSha256(input: {
  workItemId: number;
  draftId: number;
  draftVersion: number;
  draftSha256: string;
  checkerRunId: number;
  qcEvidenceSha256: string;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_APPROVAL_CONTRACT,
      workItemId: input.workItemId,
      draftId: input.draftId,
      draftVersion: input.draftVersion,
      draftSha256: input.draftSha256.toLowerCase(),
      checkerRunId: input.checkerRunId,
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
    })
  );
}

export function editorialEpisodeStateSha256(input: {
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  contentFormat: string | null;
  wordCount: number | null;
  isPublished: boolean;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT,
      novelId: input.novelId,
      episodeNumber: normalizeEditorialEpisodeNumber(input.episodeNumber),
      title: input.title,
      content: input.content ?? "",
      contentFormat: input.contentFormat ?? "plain_text",
      wordCount: input.wordCount ?? 0,
      isPublished: Boolean(input.isPublished),
    })
  );
}

export function editorialEpisodeStagePayloadSha256(input: {
  workItemId: number;
  approvalId: number;
  draftId: number;
  draftSha256: string;
  qcEvidenceSha256: string;
  novelId: number;
  plan: EditorialEpisodeDraftPlan;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_EPISODE_STAGE_CONTRACT,
      workItemId: input.workItemId,
      approvalId: input.approvalId,
      draftId: input.draftId,
      draftSha256: input.draftSha256.toLowerCase(),
      qcEvidenceSha256: input.qcEvidenceSha256.toLowerCase(),
      novelId: input.novelId,
      episodeNumber: input.plan.episodeNumber,
      title: input.plan.title,
      contentSha256: input.plan.contentSha256,
      contentFormat: input.plan.contentFormat,
      wordCount: input.plan.wordCount,
      sourceTabId: input.plan.sourceTabId,
    })
  );
}
