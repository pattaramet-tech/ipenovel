import { createHash } from "node:crypto";

export const THAI_NOVEL_EXPORT_CONTRACT =
  "workspace-thai-novel-bulk-txt-v1" as const;

export const THAI_NOVEL_EXPORT_MAX_WORK_ITEMS = 50;
export const THAI_NOVEL_EXPORT_MAX_FILES = 1000;
export const THAI_NOVEL_EXPORT_MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
export const THAI_NOVEL_EXPORT_MAX_ZIP_BYTES = 30 * 1024 * 1024;
export const THAI_NOVEL_EXPORT_FILENAME_TITLE_MAX_LENGTH = 80;

export type ThaiNovelExportSourceFile = {
  workItemId: number;
  draftId: number;
  draftVersion: number;
  draftSha256: string;
  approvalId: number;
  checkerRunId: number;
  qcEvidenceSha256: string;
  stageIds: number[];
  stagedDraftSha256: string;
  novelId: number;
  novelTitle: string;
  episodeNumber: string;
  title: string;
  content: string;
  contentSha256: string;
};

export type ThaiNovelExportFile = ThaiNovelExportSourceFile & {
  fileName: string;
  text: string;
  byteLength: number;
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeThaiNovelFileNameTitle(
  value: string,
  maxLength = THAI_NOVEL_EXPORT_FILENAME_TITLE_MAX_LENGTH
) {
  const cleaned = String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[,，]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!cleaned) return "episode";
  if (!Number.isFinite(maxLength) || maxLength <= 0 || cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength).trim().replace(/[. ]+$/g, "") + "…";
}

export function sanitizeThaiNovelZipBaseName(value: string) {
  return sanitizeThaiNovelFileNameTitle(value, 120) || "Thai-Novel";
}

export function buildThaiNovelTxt(title: string, content: string) {
  const normalizedTitle = String(title || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedContent = String(content || "")
    .replace(/^\ufeff/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalizedTitle) {
    throw new Error("Thai-Novel TXT requires a chapter title.");
  }
  if (!normalizedContent) {
    throw new Error("Thai-Novel TXT requires chapter content.");
  }
  return "\ufeff" + normalizedTitle + "\n\n" + normalizedContent;
}

export function episodeSortKey(value: string) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

export function buildThaiNovelExportFiles(
  sources: readonly ThaiNovelExportSourceFile[]
): {
  files: ThaiNovelExportFile[];
  warnings: string[];
  totalUncompressedBytes: number;
} {
  if (sources.length === 0) {
    throw new Error("Thai-Novel export requires at least one chapter.");
  }
  if (sources.length > THAI_NOVEL_EXPORT_MAX_FILES) {
    throw new Error(
      `Thai-Novel export supports at most ${THAI_NOVEL_EXPORT_MAX_FILES} TXT files per ZIP.`
    );
  }

  const sorted = [...sources].sort(
    (a, b) =>
      episodeSortKey(a.episodeNumber) - episodeSortKey(b.episodeNumber) ||
      a.episodeNumber.localeCompare(b.episodeNumber, "th") ||
      a.workItemId - b.workItemId
  );

  const episodeIds = new Set<string>();
  const usedNames = new Map<string, number>();
  const warnings: string[] = [];
  const files: ThaiNovelExportFile[] = [];
  let totalUncompressedBytes = 0;

  for (const source of sorted) {
    const episodeIdentity = String(source.episodeNumber || "").trim();
    if (!episodeIdentity) {
      throw new Error("Thai-Novel export found a chapter without episodeNumber.");
    }
    if (episodeIds.has(episodeIdentity)) {
      throw new Error(
        `Thai-Novel export found duplicate episodeNumber ${episodeIdentity} in the selected packs.`
      );
    }
    episodeIds.add(episodeIdentity);

    const base = sanitizeThaiNovelFileNameTitle(source.title);
    const baseKey = base.toLocaleLowerCase("th");
    const occurrence = (usedNames.get(baseKey) ?? 0) + 1;
    usedNames.set(baseKey, occurrence);
    const fileName =
      occurrence === 1 ? `${base}.txt` : `${base}_${occurrence}.txt`;
    if (occurrence > 1) {
      warnings.push(
        `ชื่อไฟล์ซ้ำ “${base}.txt” จึงเปลี่ยนไฟล์ลำดับที่ ${occurrence} เป็น “${fileName}”`
      );
    }

    const text = buildThaiNovelTxt(source.title, source.content);
    const byteLength = Buffer.byteLength(text, "utf8");
    totalUncompressedBytes += byteLength;
    if (totalUncompressedBytes > THAI_NOVEL_EXPORT_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Thai-Novel export exceeds ${Math.floor(
          THAI_NOVEL_EXPORT_MAX_UNCOMPRESSED_BYTES / 1024 / 1024
        )}MB uncompressed limit.`
      );
    }

    files.push({
      ...source,
      fileName,
      text,
      byteLength,
    });
  }

  return { files, warnings, totalUncompressedBytes };
}

export function thaiNovelExportPreviewFingerprint(input: {
  workspaceId: number;
  novelId: number;
  workItemIds: readonly number[];
  files: readonly ThaiNovelExportFile[];
}) {
  return sha256(
    JSON.stringify({
      contract: THAI_NOVEL_EXPORT_CONTRACT,
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      workItemIds: [...input.workItemIds].sort((a, b) => a - b),
      files: input.files.map(file => ({
        workItemId: file.workItemId,
        draftId: file.draftId,
        draftVersion: file.draftVersion,
        draftSha256: file.draftSha256,
        approvalId: file.approvalId,
        checkerRunId: file.checkerRunId,
        qcEvidenceSha256: file.qcEvidenceSha256,
        stageIds: [...file.stageIds].sort((a, b) => a - b),
        stagedDraftSha256: file.stagedDraftSha256,
        episodeNumber: file.episodeNumber,
        title: file.title,
        contentSha256: file.contentSha256,
        fileName: file.fileName,
        byteLength: file.byteLength,
      })),
    })
  );
}

export function thaiNovelExportZipSha256(buffer: Buffer) {
  return sha256(buffer);
}
