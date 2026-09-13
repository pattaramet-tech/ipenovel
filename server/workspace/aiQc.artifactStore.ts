import { createHash } from "node:crypto";
import { putPrivateObject } from "../services/r2PrivateStorage";
import type { WorkspaceAiQcArtifactStore } from "./aiQc.service";

const AI_QC_ARTIFACT_KEY =
  /^workspace\/ai-qc\/[1-9]\d*\/jobs\/[1-9]\d*\/(?:attempts\/[1-9]\d*|receipts\/[a-f0-9]{64})\/workspace-ai-qc-v1\.json$/;

export class WorkspaceAiQcArtifactStoreError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_KEY_INVALID"
      | "ARTIFACT_HASH_INVALID"
      | "ARTIFACT_HASH_MISMATCH"
      | "ARTIFACT_STORAGE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcArtifactStoreError";
  }
}

export type WorkspaceAiQcPrivatePut = typeof putPrivateObject;

export function createWorkspaceAiQcPrivateR2ArtifactStore(
  putPrivate: WorkspaceAiQcPrivatePut = putPrivateObject
): WorkspaceAiQcArtifactStore {
  return {
    async putJson(input) {
      if (!AI_QC_ARTIFACT_KEY.test(input.objectKey)) {
        throw new WorkspaceAiQcArtifactStoreError(
          "ARTIFACT_KEY_INVALID",
          "AI QC artifact key does not match the immutable Workspace AI QC layout."
        );
      }
      if (!/^[a-f0-9]{64}$/.test(input.contentSha256)) {
        throw new WorkspaceAiQcArtifactStoreError(
          "ARTIFACT_HASH_INVALID",
          "AI QC artifact contentSha256 must be a lowercase SHA-256 digest."
        );
      }

      const content = Buffer.from(input.content, "utf8");
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== input.contentSha256) {
        throw new WorkspaceAiQcArtifactStoreError(
          "ARTIFACT_HASH_MISMATCH",
          "AI QC artifact content hash does not match the supplied digest."
        );
      }

      try {
        const uploaded = await putPrivate(
          "workspaceAiQcArtifact",
          input.objectKey,
          content,
          "application/json; charset=utf-8"
        );
        if (uploaded.key !== input.objectKey) {
          throw new WorkspaceAiQcArtifactStoreError(
            "ARTIFACT_STORAGE_FAILED",
            "AI QC artifact storage returned a different object identity."
          );
        }
      } catch (error) {
        if (error instanceof WorkspaceAiQcArtifactStoreError) throw error;
        throw new WorkspaceAiQcArtifactStoreError(
          "ARTIFACT_STORAGE_FAILED",
          "AI QC artifact could not be persisted to private storage."
        );
      }
    },
  };
}
