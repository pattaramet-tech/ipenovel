import { validatePrivateR2Config } from "../services/r2PrivateConfigValidator";
import { createWorkspaceAiQcPrivateR2ArtifactStore } from "./aiQc.artifactStore";
import {
  runConfiguredScopedAiQcWorkerOnce,
  type WorkspaceAiQcConfiguredWorkerInput,
} from "./aiQc.worker";

const PROVIDER_REQUIRED = [
  "WORKSPACE_AI_QC_PROVIDER_API_URL",
  "WORKSPACE_AI_QC_PROVIDER_API_KEY",
  "WORKSPACE_AI_QC_PROVIDER_MODEL",
] as const;

const PRIVATE_R2_REQUIRED = [
  "R2_PRIVATE_ACCOUNT_ID",
  "R2_PRIVATE_ACCESS_KEY_ID",
  "R2_PRIVATE_SECRET_ACCESS_KEY",
  "R2_PRIVATE_ENDPOINT",
  "R2_PRIVATE_BUCKET_NAME",
] as const;

export type WorkspaceAiQcPreviewEnv = Record<string, string | undefined>;

export interface WorkspaceAiQcReadinessCheck {
  ready: boolean;
  missing: string[];
  invalid: string[];
}
export interface WorkspaceAiQcPreviewReadinessReport {
  runtimeTarget: WorkspaceAiQcReadinessCheck;
  provider: WorkspaceAiQcReadinessCheck & { enabled: boolean };
  reconciliation: WorkspaceAiQcReadinessCheck;
  artifactStore: WorkspaceAiQcReadinessCheck & {
    category?: "CONFIG_MISSING" | "CONFIG_INVALID" | "ENDPOINT_INVALID";
    detail?: string;
  };
  execution: WorkspaceAiQcReadinessCheck & { enabled: boolean };
  readyForDisarmedPreview: boolean;
  readyForControlledExecution: boolean;
  blockers: string[];
}

export class WorkspaceAiQcPreviewReadinessError extends Error {
  constructor(readonly report: WorkspaceAiQcPreviewReadinessReport) {
    super("Workspace AI QC Preview runtime is not ready for controlled external execution.");
    this.name = "WorkspaceAiQcPreviewReadinessError";
  }
}

function hasValue(env: WorkspaceAiQcPreviewEnv, name: string) {
  return typeof env[name] === "string" && env[name]!.trim().length > 0;
}

function validHttpUrl(raw: string | undefined) {
  if (!raw?.trim()) return false;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function positiveBounded(raw: string | undefined, max: number) {
  if (!raw?.trim()) return true;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function checkProvider(env: WorkspaceAiQcPreviewEnv) {
  const missing = PROVIDER_REQUIRED.filter(name => !hasValue(env, name));
  const invalid: string[] = [];
  if (hasValue(env, "WORKSPACE_AI_QC_PROVIDER_API_URL") && !validHttpUrl(env.WORKSPACE_AI_QC_PROVIDER_API_URL)) {
    invalid.push("WORKSPACE_AI_QC_PROVIDER_API_URL");
  }
  if (hasValue(env, "WORKSPACE_AI_QC_PROVIDER_MODEL") && env.WORKSPACE_AI_QC_PROVIDER_MODEL!.trim().length > 160) {
    invalid.push("WORKSPACE_AI_QC_PROVIDER_MODEL");
  }
  if (hasValue(env, "WORKSPACE_AI_QC_PROVIDER_NAME") && env.WORKSPACE_AI_QC_PROVIDER_NAME!.trim().length > 120) {
    invalid.push("WORKSPACE_AI_QC_PROVIDER_NAME");
  }
  if (!positiveBounded(env.WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS, 120_000)) {
    invalid.push("WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS");
  }
  if (!positiveBounded(env.WORKSPACE_AI_QC_PROVIDER_MAX_INPUT_CHARS, 1_000_000)) {
    invalid.push("WORKSPACE_AI_QC_PROVIDER_MAX_INPUT_CHARS");
  }
  return { enabled: env.WORKSPACE_AI_QC_PROVIDER_ENABLED === "true", ready: missing.length === 0 && invalid.length === 0, missing, invalid };
}
function checkReconciliation(env: WorkspaceAiQcPreviewEnv): WorkspaceAiQcReadinessCheck {
  const name = "WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE";
  if (!hasValue(env, name)) return { ready: false, missing: [name], invalid: [] };
  const template = env[name]!.trim();
  const marker = "{providerRequestId}";
  if (template.split(marker).length !== 2 || !validHttpUrl(template.replace(marker, "receipt-probe"))) {
    return { ready: false, missing: [], invalid: [name] };
  }
  return { ready: true, missing: [], invalid: [] };
}

function rawPrivateR2Expiry(env: WorkspaceAiQcPreviewEnv) {
  const raw = env.R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS;
  if (!raw?.trim()) return 900;
  return Number(raw.trim());
}

function checkArtifactStore(env: WorkspaceAiQcPreviewEnv) {
  const missing = PRIVATE_R2_REQUIRED.filter(name => !hasValue(env, name));
  if (missing.length > 0) {
    return { ready: false, missing: [...missing], invalid: [], category: "CONFIG_MISSING" as const };
  }
  const problem = validatePrivateR2Config({
    accountId: env.R2_PRIVATE_ACCOUNT_ID!,
    accessKeyId: env.R2_PRIVATE_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_PRIVATE_SECRET_ACCESS_KEY!,
    endpoint: env.R2_PRIVATE_ENDPOINT!,
    bucketName: env.R2_PRIVATE_BUCKET_NAME!,
    signedUrlExpiresSeconds: rawPrivateR2Expiry(env),
  });
  if (!problem) return { ready: true, missing: [], invalid: [] };
  return {
    ready: false,
    missing: [],
    invalid: [problem.detail],
    category: problem.category,
    detail: problem.detail,
  };
}

function validExecutionScope(raw: string | undefined) {
  if (!raw?.trim()) return false;
  const parts = raw.split(",").map(part => part.trim().split("="));
  const expected = ["workspaceId", "jobId", "snapshotId", "requestKey"];
  const keys = parts.map(part => part[0]);
  const fields = Object.fromEntries(parts.filter(part => part.length === 2));
  return parts.length === 4
    && parts.every(part => part.length === 2 && part[0] && part[1])
    && new Set(keys).size === 4
    && expected.every(key => keys.includes(key))
    && ["workspaceId", "jobId", "snapshotId"].every(
      key => Number.isSafeInteger(Number(fields[key])) && Number(fields[key]) > 0
    )
    && /^[a-f0-9]{64}$/i.test(fields.requestKey ?? "");
}
function checkExecution(env: WorkspaceAiQcPreviewEnv) {
  const enabled = env.WORKSPACE_AI_QC_EXECUTION_ENABLED === "true";
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!hasValue(env, "WORKSPACE_AI_QC_EXECUTION_SCOPE")) {
    if (enabled) missing.push("WORKSPACE_AI_QC_EXECUTION_SCOPE");
  } else if (!validExecutionScope(env.WORKSPACE_AI_QC_EXECUTION_SCOPE)) {
    invalid.push("WORKSPACE_AI_QC_EXECUTION_SCOPE");
  }
  if (!positiveBounded(env.WORKSPACE_AI_QC_LEASE_SECONDS, 300)) {
    invalid.push("WORKSPACE_AI_QC_LEASE_SECONDS");
  }
  if (!positiveBounded(env.WORKSPACE_AI_QC_MAX_ATTEMPTS, 10)) {
    invalid.push("WORKSPACE_AI_QC_MAX_ATTEMPTS");
  }
  return {
    enabled,
    ready: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
export function buildWorkspaceAiQcPreviewReadiness(
  env: WorkspaceAiQcPreviewEnv
): WorkspaceAiQcPreviewReadinessReport {
  const targetValue = env.WORKSPACE_AI_QC_RUNTIME_TARGET;
  const runtimeTarget: WorkspaceAiQcReadinessCheck = targetValue === "preview"
    ? { ready: true, missing: [], invalid: [] }
    : targetValue?.trim()
      ? { ready: false, missing: [], invalid: ["WORKSPACE_AI_QC_RUNTIME_TARGET"] }
      : { ready: false, missing: ["WORKSPACE_AI_QC_RUNTIME_TARGET"], invalid: [] };
  const provider = checkProvider(env);
  const reconciliation = checkReconciliation(env);
  const artifactStore = checkArtifactStore(env);
  const execution = checkExecution(env);

  const infrastructureReady = runtimeTarget.ready
    && provider.ready
    && reconciliation.ready
    && artifactStore.ready
    && execution.ready;
  const readyForDisarmedPreview = infrastructureReady
    && !provider.enabled
    && !execution.enabled;
  const readyForControlledExecution = infrastructureReady
    && provider.enabled
    && execution.enabled;
  const blockers = unique([
    ...runtimeTarget.missing,
    ...runtimeTarget.invalid,
    ...provider.missing,
    ...provider.invalid,
    ...reconciliation.missing,
    ...reconciliation.invalid,
    ...artifactStore.missing,
    ...artifactStore.invalid,
    ...execution.missing,
    ...execution.invalid,
    ...(!provider.enabled ? ["WORKSPACE_AI_QC_PROVIDER_ENABLED"] : []),
    ...(!execution.enabled ? ["WORKSPACE_AI_QC_EXECUTION_ENABLED"] : []),
  ]);

  return {
    runtimeTarget,
    provider,
    reconciliation,
    artifactStore,
    execution,
    readyForDisarmedPreview,
    readyForControlledExecution,
    blockers,
  };
}
export type WorkspaceAiQcPreviewWorkerInput = Omit<
  WorkspaceAiQcConfiguredWorkerInput,
  "artifactStore"
>;

export async function runConfiguredPreviewAiQcWorkerOnce(
  input: WorkspaceAiQcPreviewWorkerInput
) {
  const report = buildWorkspaceAiQcPreviewReadiness(process.env);
  if (!report.readyForControlledExecution) {
    throw new WorkspaceAiQcPreviewReadinessError(report);
  }
  return runConfiguredScopedAiQcWorkerOnce({
    ...input,
    artifactStore: createWorkspaceAiQcPrivateR2ArtifactStore(),
  });
}
