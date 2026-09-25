import {
  databaseIdentityFingerprint,
  normalizeDatabaseIdentityFingerprint,
} from "../../scripts/lib/databaseIdentity.mjs";
import {
  WORKSPACE_PUBLISH_MAX_ATTEMPTS,
  type WorkspacePublishExecutionScope,
  type WorkspacePublishObserver,
  type WorkspacePublishProvider,
} from "./publishExecution.domain";
import { claimPublishOutbox, processClaimedPublishOutbox } from "./publishExecution.service";
import {
  assertEditorialPublishRequestCurrent,
  reconcileEditorialPublishRun,
} from "./editorialPublish.service";

export class WorkspacePublishRuntimeError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_SCOPE_REQUIRED"
      | "EXECUTION_SCOPE_INVALID"
      | "ENVIRONMENT_SAFETY_GATE_BLOCKED"
      | "EXTERNAL_PROVIDER_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishRuntimeError";
  }
}

export type WorkspacePublishEnvironment = "production" | "production-staging";

export type WorkspacePublishEnvironmentSafety = {
  tier: WorkspacePublishEnvironment;
  databaseName: string;
  databaseFingerprint: string;
};

export type WorkspacePublishExecutionPolicy =
  | {
      mode: WorkspacePublishEnvironment;
      executionEnabled: true;
      externalProviderEnabled: boolean;
      safety: WorkspacePublishEnvironmentSafety;
    }
  | {
      mode: "inactive";
      executionEnabled: false;
      externalProviderEnabled: boolean;
      safety: null;
    };

function positiveInt(value: string | undefined, key: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", `Publish execution scope ${key} must be a positive integer.`);
  }
  return number;
}

/** Strict single-run scope. Example: workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2 */
export function parseWorkspacePublishExecutionScope(raw: string | undefined): WorkspacePublishExecutionScope {
  if (!raw?.trim()) throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "WORKSPACE_PUBLISH_EXECUTION_SCOPE is required.");
  const entries = raw.split(",").map(part => part.trim().split("="));
  if (entries.some(parts => parts.length !== 2)) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must use key=value comma-separated fields.");
  }
  const expectedKeys = ["workspaceId", "workspaceNovelId", "runId", "epoch", "version"];
  const entryKeys = entries.map(parts => parts[0]);
  if (entries.length !== expectedKeys.length || new Set(entryKeys).size !== entries.length) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must contain each required field exactly once.");
  }
  const fields = Object.fromEntries(entries) as Record<string, string>;
  if (Object.keys(fields).length !== expectedKeys.length || expectedKeys.some(key => !(key in fields))) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must contain exactly workspaceId,workspaceNovelId,runId,epoch,version.");
  }
  return {
    workspaceId: positiveInt(fields.workspaceId, "workspaceId"),
    workspaceNovelId: positiveInt(fields.workspaceNovelId, "workspaceNovelId"),
    runId: positiveInt(fields.runId, "runId"),
    expectedCutoverEpoch: positiveInt(fields.epoch, "epoch"),
    expectedOwnershipVersion: positiveInt(fields.version, "version"),
  };
}

function parseDatabaseIdentity(databaseUrl: string | undefined, label: string) {
  if (!databaseUrl?.trim()) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      `${label} Controlled Publish requires DATABASE_URL.`
    );
  }
  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!databaseName) throw new Error("database name missing");
    return {
      databaseName,
      databaseFingerprint: databaseIdentityFingerprint(databaseUrl),
    };
  } catch {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      `${label} database identity cannot be parsed safely.`
    );
  }
}

function requiredFingerprint(raw: string | undefined, variableName: string) {
  const fingerprint = normalizeDatabaseIdentityFingerprint(raw);
  if (!fingerprint) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      `Controlled Publish requires a valid ${variableName}.`
    );
  }
  return fingerprint;
}

function requirePublishDatabaseIdentity(
  env: NodeJS.ProcessEnv,
  environment: WorkspacePublishEnvironment
): WorkspacePublishEnvironmentSafety {
  const label = environment === "production" ? "Production" : "Production-staging";
  if (env.DEPLOYMENT_ENVIRONMENT !== environment) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      `${label} Controlled Publish requires DEPLOYMENT_ENVIRONMENT=${environment} exactly.`
    );
  }

  const productionFingerprint = requiredFingerprint(
    env.PRODUCTION_DB_FINGERPRINT,
    "PRODUCTION_DB_FINGERPRINT"
  );
  const stagingFingerprint =
    environment === "production-staging"
      ? requiredFingerprint(
          env.PRODUCTION_STAGING_DB_FINGERPRINT,
          "PRODUCTION_STAGING_DB_FINGERPRINT"
        )
      : normalizeDatabaseIdentityFingerprint(env.PRODUCTION_STAGING_DB_FINGERPRINT);

  if (stagingFingerprint && stagingFingerprint === productionFingerprint) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      "Production and production-staging database fingerprints must differ."
    );
  }

  const actual = parseDatabaseIdentity(env.DATABASE_URL, label);
  const expectedFingerprint =
    environment === "production" ? productionFingerprint : stagingFingerprint!;

  if (actual.databaseFingerprint !== expectedFingerprint) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      `${label} DATABASE_URL does not match the approved ${environment} database identity.`
    );
  }

  return {
    tier: environment,
    databaseName: actual.databaseName,
    databaseFingerprint: actual.databaseFingerprint,
  };
}

export function requireWorkspacePublishEnvironmentSafety(
  env: NodeJS.ProcessEnv = process.env
): WorkspacePublishEnvironmentSafety {
  if (env.DEPLOYMENT_ENVIRONMENT === "production") {
    return requirePublishDatabaseIdentity(env, "production");
  }
  if (env.DEPLOYMENT_ENVIRONMENT === "production-staging") {
    return requirePublishDatabaseIdentity(env, "production-staging");
  }
  throw new WorkspacePublishRuntimeError(
    "ENVIRONMENT_SAFETY_GATE_BLOCKED",
    "Controlled Publish is available only in production or production-staging."
  );
}

/**
 * Controlled Publish has no execution/acceptance feature flag. Runtime activation
 * is derived only from the deployment environment and its approved DB identity.
 * Preview/development environments stay inactive instead of impersonating either
 * release environment.
 */
export function resolveWorkspacePublishExecutionPolicy(
  env: NodeJS.ProcessEnv = process.env
): WorkspacePublishExecutionPolicy {
  const externalProviderEnabled = env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";

  if (
    env.DEPLOYMENT_ENVIRONMENT === "production" ||
    env.DEPLOYMENT_ENVIRONMENT === "production-staging"
  ) {
    return {
      mode: env.DEPLOYMENT_ENVIRONMENT,
      executionEnabled: true,
      externalProviderEnabled,
      safety: requireWorkspacePublishEnvironmentSafety(env),
    };
  }

  return {
    mode: "inactive",
    executionEnabled: false,
    externalProviderEnabled,
    safety: null,
  };
}

export function requireWorkspacePublishRequestPolicy(
  env: NodeJS.ProcessEnv = process.env
): Extract<WorkspacePublishExecutionPolicy, { executionEnabled: true }> {
  const policy = resolveWorkspacePublishExecutionPolicy(env);
  if (!policy.executionEnabled) {
    throw new WorkspacePublishRuntimeError(
      "ENVIRONMENT_SAFETY_GATE_BLOCKED",
      "Controlled Publish is not active in this deployment environment."
    );
  }
  if (!policy.externalProviderEnabled) {
    throw new WorkspacePublishRuntimeError(
      "EXTERNAL_PROVIDER_DISABLED",
      "Workspace publish external provider is not enabled."
    );
  }
  return policy;
}

export function scopeMatches(input: WorkspacePublishExecutionScope, expected: WorkspacePublishExecutionScope) {
  return input.workspaceId === expected.workspaceId
    && input.workspaceNovelId === expected.workspaceNovelId
    && input.runId === expected.runId
    && input.expectedCutoverEpoch === expected.expectedCutoverEpoch
    && input.expectedOwnershipVersion === expected.expectedOwnershipVersion;
}

/** One exact run, one claim, bounded retry count; deliberately no loop/scheduler. */
export async function runScopedPublishWorkerOnce(input: {
  scope: WorkspacePublishExecutionScope;
  leaseOwner: string;
  provider: WorkspacePublishProvider;
  executionEnabled: boolean;
  allowExternalProvider: boolean;
  maxAttempts?: number;
  observer?: WorkspacePublishObserver;
}) {
  if (!input.executionEnabled) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "Publish worker refused because execution is disabled.");
  }
  if (input.provider.mode === "external" && !input.allowExternalProvider) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "Publish worker refused because the external provider is disabled.");
  }
  const startedAt = Date.now();
  const maxAttempts = input.maxAttempts ?? WORKSPACE_PUBLISH_MAX_ATTEMPTS;
  await reconcileEditorialPublishRun({
    workspaceId: input.scope.workspaceId,
    runId: input.scope.runId,
  });
  const claimed = await claimPublishOutbox({
    workspaceId: input.scope.workspaceId,
    publishRunId: input.scope.runId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    expectedCutoverEpoch: input.scope.expectedCutoverEpoch,
    expectedOwnershipVersion: input.scope.expectedOwnershipVersion,
    maxAttempts,
  });
  if (!claimed) {
    input.observer?.({ type: "claim_miss", at: new Date().toISOString(), workspaceId: input.scope.workspaceId, publishRunId: input.scope.runId, durationMs: Date.now() - startedAt });
    return { claimed: false as const, durationMs: Date.now() - startedAt };
  }
  input.observer?.({ type: "claim_acquired", at: new Date().toISOString(), workspaceId: input.scope.workspaceId, publishRunId: input.scope.runId, outboxId: claimed.id, attempt: claimed.attempts });
  const result = await processClaimedPublishOutbox({
    workspaceId: input.scope.workspaceId,
    outboxId: claimed.id,
    leaseOwner: input.leaseOwner,
    provider: input.provider,
    expectedCutoverEpoch: input.scope.expectedCutoverEpoch,
    expectedOwnershipVersion: input.scope.expectedOwnershipVersion,
    executionEnabled: input.executionEnabled,
    allowExternalProvider: input.allowExternalProvider,
    maxAttempts,
    observer: input.observer,
    beforeProviderExecute: assertEditorialPublishRequestCurrent,
  });
  const editorialProjection = await reconcileEditorialPublishRun({
    workspaceId: input.scope.workspaceId,
    runId: input.scope.runId,
  });
  return {
    claimed: true as const,
    outboxId: claimed.id,
    attempt: claimed.attempts,
    result,
    editorialProjection,
    durationMs: Date.now() - startedAt,
  };
}
