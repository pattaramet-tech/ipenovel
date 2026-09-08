import { createHash } from "node:crypto";

export const WORKSPACE_AI_QC_SCHEMA_VERSION = "workspace-ai-qc-v1" as const;

export type WorkspaceAiQcCategory =
  | "foreign_word"
  | "typo"
  | "consistency"
  | "duplicate_like"
  | "formatting"
  | "other";
export type WorkspaceAiQcSeverity = "info" | "warning" | "error";

export interface WorkspaceAiQcFinding {
  category: WorkspaceAiQcCategory;
  severity: WorkspaceAiQcSeverity;
  locationKey: string;
  message: string;
  evidenceSha256: string;
  confidence: number;
}

export interface WorkspaceAiQcProviderResult {
  providerRequestId: string;
  providerName: string;
  model: string;
  findings: WorkspaceAiQcFinding[];
}

export interface WorkspaceAiQcArtifactEnvelope {
  schemaVersion: typeof WORKSPACE_AI_QC_SCHEMA_VERSION;
  advisory: true;
  source: {
    snapshotId: number;
    normalizedSha256: string;
    normalizationVersion: number;
  };
  operation: string;
  promptVersion: string;
  modelPolicyVersion: string;
  provider: {
    providerName: string;
    model: string;
    providerRequestId: string;
  };
  summary: {
    findingCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  findings: WorkspaceAiQcFinding[];
}

export class WorkspaceAiQcContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAiQcContractError";
  }
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new WorkspaceAiQcContractError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new WorkspaceAiQcContractError(`${field} is empty or exceeds ${maxLength} characters.`);
  }
  return trimmed;
}

function requireSha256(value: unknown, field: string): string {
  const normalized = requireString(value, field, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new WorkspaceAiQcContractError(`${field} must be a SHA-256 hex digest.`);
  }
  return normalized;
}

const categories = new Set<WorkspaceAiQcCategory>([
  "foreign_word",
  "typo",
  "consistency",
  "duplicate_like",
  "formatting",
  "other",
]);
const severities = new Set<WorkspaceAiQcSeverity>(["info", "warning", "error"]);

export function validateWorkspaceAiQcProviderResult(value: unknown): WorkspaceAiQcProviderResult {
  if (!value || typeof value !== "object") {
    throw new WorkspaceAiQcContractError("AI QC provider result must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.findings) || input.findings.length > 500) {
    throw new WorkspaceAiQcContractError("AI QC findings must be an array with at most 500 entries.");
  }
  const findings = input.findings.map((item, index): WorkspaceAiQcFinding => {
    if (!item || typeof item !== "object") {
      throw new WorkspaceAiQcContractError(`findings[${index}] must be an object.`);
    }
    const finding = item as Record<string, unknown>;
    if (!categories.has(finding.category as WorkspaceAiQcCategory)) {
      throw new WorkspaceAiQcContractError(`findings[${index}].category is unsupported.`);
    }
    if (!severities.has(finding.severity as WorkspaceAiQcSeverity)) {
      throw new WorkspaceAiQcContractError(`findings[${index}].severity is unsupported.`);
    }
    if (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) {
      throw new WorkspaceAiQcContractError(`findings[${index}].confidence must be between 0 and 1.`);
    }
    return {
      category: finding.category as WorkspaceAiQcCategory,
      severity: finding.severity as WorkspaceAiQcSeverity,
      locationKey: requireString(finding.locationKey, `findings[${index}].locationKey`, 240),
      message: requireString(finding.message, `findings[${index}].message`, 1000),
      evidenceSha256: requireSha256(finding.evidenceSha256, `findings[${index}].evidenceSha256`),
      confidence: finding.confidence,
    };
  });
  return {
    providerRequestId: requireString(input.providerRequestId, "providerRequestId", 255),
    providerName: requireString(input.providerName, "providerName", 120),
    model: requireString(input.model, "model", 160),
    findings,
  };
}

export function buildWorkspaceAiQcArtifact(input: {
  snapshotId: number;
  normalizedSha256: string;
  normalizationVersion: number;
  operation: string;
  promptVersion: string;
  modelPolicyVersion: string;
  providerResult: WorkspaceAiQcProviderResult;
}): WorkspaceAiQcArtifactEnvelope {
  const findings = input.providerResult.findings;
  return {
    schemaVersion: WORKSPACE_AI_QC_SCHEMA_VERSION,
    advisory: true,
    source: {
      snapshotId: input.snapshotId,
      normalizedSha256: requireSha256(input.normalizedSha256, "normalizedSha256"),
      normalizationVersion: input.normalizationVersion,
    },
    operation: input.operation,
    promptVersion: input.promptVersion,
    modelPolicyVersion: input.modelPolicyVersion,
    provider: {
      providerName: input.providerResult.providerName,
      model: input.providerResult.model,
      providerRequestId: input.providerResult.providerRequestId,
    },
    summary: {
      findingCount: findings.length,
      errorCount: findings.filter(finding => finding.severity === "error").length,
      warningCount: findings.filter(finding => finding.severity === "warning").length,
      infoCount: findings.filter(finding => finding.severity === "info").length,
    },
    findings,
  };
}

export function serializeWorkspaceAiQcArtifact(artifact: WorkspaceAiQcArtifactEnvelope) {
  const content = JSON.stringify(artifact);
  return {
    content,
    contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
