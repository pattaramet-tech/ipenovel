import { describe, expect, it } from "vitest";
import {
  buildWorkspaceAiQcArtifact,
  serializeWorkspaceAiQcArtifact,
  validateWorkspaceAiQcProviderResult,
  WorkspaceAiQcContractError,
} from "./aiQc.domain";

const digest = "a".repeat(64);

describe("workspace M04-B AI QC contract", () => {
  it("validates bounded structured advisory findings", () => {
    const result = validateWorkspaceAiQcProviderResult({
      providerRequestId: "req-001",
      providerName: "mock-provider",
      model: "mock-model-v1",
      findings: [{
        category: "foreign_word",
        severity: "warning",
        locationKey: "paragraph:12",
        message: "Possible foreign-language token requires review.",
        evidenceSha256: digest,
        confidence: 0.92,
      }],
    });
    const artifact = buildWorkspaceAiQcArtifact({
      snapshotId: 7,
      normalizedSha256: "b".repeat(64),
      normalizationVersion: 1,
      operation: "semantic_qc",
      promptVersion: "prompt-v1",
      modelPolicyVersion: "policy-v1",
      providerResult: result,
    });
    expect(artifact.advisory).toBe(true);
    expect(artifact.summary).toEqual({ findingCount: 1, errorCount: 0, warningCount: 1, infoCount: 0 });
    expect(artifact.findings[0].evidenceSha256).toBe(digest);
    expect(serializeWorkspaceAiQcArtifact(artifact).contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects raw/unbounded or malformed provider output instead of coercing it", () => {
    expect(() => validateWorkspaceAiQcProviderResult({
      providerRequestId: "req-002",
      providerName: "mock-provider",
      model: "mock-model-v1",
      findings: [{
        category: "invented",
        severity: "warning",
        locationKey: "document",
        message: "bad category",
        evidenceSha256: digest,
        confidence: 0.5,
      }],
    })).toThrow(WorkspaceAiQcContractError);
    expect(() => validateWorkspaceAiQcProviderResult({
      providerRequestId: "req-003",
      providerName: "mock-provider",
      model: "mock-model-v1",
      findings: [{
        category: "typo",
        severity: "warning",
        locationKey: "document",
        message: "bad digest",
        evidenceSha256: "not-a-hash",
        confidence: 1.2,
      }],
    })).toThrow(WorkspaceAiQcContractError);
  });
});
