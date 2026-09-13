import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceAiQcPrivateR2ArtifactStore,
  WorkspaceAiQcArtifactStoreError,
} from "./aiQc.artifactStore";

const objectKey =
  "workspace/ai-qc/7/jobs/11/attempts/13/workspace-ai-qc-v1.json";
const content = JSON.stringify({ contract: "workspace-ai-qc-v1", findings: [] });
const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");

describe("IPE-054-C private-R2 AI QC artifact store", () => {
  it("validates the immutable key/hash and writes JSON only to the AI QC private-R2 context", async () => {
    const putPrivate = vi.fn(async () => ({ key: objectKey }));
    const store = createWorkspaceAiQcPrivateR2ArtifactStore(putPrivate as any);
    await store.putJson({ objectKey, content, contentSha256 });
    expect(putPrivate).toHaveBeenCalledTimes(1);
    expect(putPrivate).toHaveBeenCalledWith(
      "workspaceAiQcArtifact",
      objectKey,
      Buffer.from(content, "utf8"),
      "application/json; charset=utf-8"
    );
  });

  it("rejects a mismatched digest before any storage call", async () => {
    const putPrivate = vi.fn();
    const store = createWorkspaceAiQcPrivateR2ArtifactStore(putPrivate as any);
    await expect(store.putJson({
      objectKey,
      content,
      contentSha256: "a".repeat(64),
    })).rejects.toBeInstanceOf(WorkspaceAiQcArtifactStoreError);
    expect(putPrivate).not.toHaveBeenCalled();
  });

  it("rejects keys outside the immutable Workspace AI QC layout", async () => {
    const putPrivate = vi.fn();
    const store = createWorkspaceAiQcPrivateR2ArtifactStore(putPrivate as any);
    await expect(store.putJson({
      objectKey: "payment-slips/7/not-an-ai-artifact.json",
      content,
      contentSha256,
    })).rejects.toMatchObject({ code: "ARTIFACT_KEY_INVALID" });
    expect(putPrivate).not.toHaveBeenCalled();
  });

  it("sanitizes private storage failures instead of surfacing provider details", async () => {
    const putPrivate = vi.fn(async () => {
      throw new Error("secret endpoint or bucket detail must not escape");
    });
    const store = createWorkspaceAiQcPrivateR2ArtifactStore(putPrivate as any);
    let error: unknown;
    try {
      await store.putJson({ objectKey, content, contentSha256 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ARTIFACT_STORAGE_FAILED" });
    expect(String(error)).not.toContain("secret endpoint");
  });

  it("accepts only hashed receipt storage identities for recovery artifacts", async () => {
    const receiptKey = `workspace/ai-qc/7/jobs/11/receipts/${"b".repeat(64)}/workspace-ai-qc-v1.json`;
    const putPrivate = vi.fn(async () => ({ key: receiptKey }));
    const store = createWorkspaceAiQcPrivateR2ArtifactStore(putPrivate as any);
    await expect(store.putJson({ objectKey: receiptKey, content, contentSha256 })).resolves.toBeUndefined();
    await expect(store.putJson({
      objectKey: "workspace/ai-qc/7/jobs/11/receipts/provider/request/../unsafe/workspace-ai-qc-v1.json",
      content,
      contentSha256,
    })).rejects.toMatchObject({ code: "ARTIFACT_KEY_INVALID" });
  });});
