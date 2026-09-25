import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import {
  parseWorkspacePublishExecutionScope,
  requirePreviewPublishExecutionSafety,
  requireProductionPublishExecutionSafety,
  requireWorkspacePublishRequestPolicy,
  resolveWorkspacePublishExecutionPolicy,
  scopeMatches,
  WorkspacePublishRuntimeError,
} from "./publishExecution.runtime";

const PRODUCTION_URL = "mysql://user:secret@prod-db.internal:3306/ipenovel_prod";
const STAGING_URL = "mysql://user:secret@staging-db.internal:3306/ipenovel_staging";

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: "production",
    DATABASE_URL: PRODUCTION_URL,
    PRODUCTION_DB_FINGERPRINT: databaseIdentityFingerprint(PRODUCTION_URL),
    PRODUCTION_STAGING_DB_FINGERPRINT: databaseIdentityFingerprint(STAGING_URL),
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function previewEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: "preview",
    DATABASE_URL: "mysql://user:secret@db.internal:3306/ipenovel_preview",
    WORKSPACE_PUBLISH_EXECUTION_ENABLED: "true",
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    WORKSPACE_PUBLISH_ACCEPTANCE_TIER: "preview",
    WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME: "ipenovel_preview",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("workspace publish execution runtime scope", () => {
  it("parses one exact scoped run and rejects missing, duplicate, extra, or non-positive fields", () => {
    const scope = parseWorkspacePublishExecutionScope("workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2");
    expect(scope).toEqual({
      workspaceId: 2,
      workspaceNovelId: 2,
      runId: 7,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: 2,
    });
    expect(scopeMatches(scope, { ...scope })).toBe(true);
    expect(scopeMatches(scope, { ...scope, runId: 8 })).toBe(false);

    for (const raw of [
      undefined,
      "workspaceId=2,workspaceNovelId=2,runId=7,epoch=1",
      "workspaceId=2,workspaceId=3,workspaceNovelId=2,runId=7,epoch=1,version=2",
      "workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2,extra=1",
      "workspaceId=2,workspaceNovelId=2,runId=0,epoch=1,version=2",
    ]) {
      expect(() => parseWorkspacePublishExecutionScope(raw)).toThrow(WorkspacePublishRuntimeError);
    }
  });

  it("requires an explicit preview tier and exact preview database identity", () => {
    const safe = previewEnv();
    expect(requirePreviewPublishExecutionSafety(safe)).toEqual({
      tier: "preview",
      databaseName: "ipenovel_preview",
    });
    expect(() => requirePreviewPublishExecutionSafety({ ...safe, WORKSPACE_PUBLISH_ACCEPTANCE_TIER: "production" }))
      .toThrowError(/ACCEPTANCE_TIER=preview/);
    expect(() => requirePreviewPublishExecutionSafety({ ...safe, WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME: "ipenovel_prod" }))
      .toThrowError(/database identity/);
    expect(() => requirePreviewPublishExecutionSafety({ ...safe, DATABASE_URL: undefined }))
      .toThrow(WorkspacePublishRuntimeError);
  });

  it("enables Production from exact environment + DB identity without reading the legacy execution flag", () => {
    const withoutFlag = productionEnv();
    delete withoutFlag.WORKSPACE_PUBLISH_EXECUTION_ENABLED;
    const disabledLegacyFlag = productionEnv({ WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false" });

    const first = resolveWorkspacePublishExecutionPolicy(withoutFlag);
    const second = resolveWorkspacePublishExecutionPolicy(disabledLegacyFlag);

    for (const policy of [first, second]) {
      expect(policy.mode).toBe("production");
      expect(policy.executionEnabled).toBe(true);
      expect(policy.externalProviderEnabled).toBe(true);
      expect(policy.safety).toEqual({ tier: "production", databaseName: "ipenovel_prod" });
      expect(policy.finalGateExecutionBlock).toBe(false);
    }
  });

  it("does not require Preview acceptance settings on the Production path", () => {
    const env = productionEnv({
      WORKSPACE_PUBLISH_ACCEPTANCE_TIER: undefined,
      WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME: undefined,
      WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false",
    });
    expect(requireWorkspacePublishRequestPolicy(env).mode).toBe("production");
  });

  it("fails closed for a non-exact Production environment or wrong Production DB identity", () => {
    expect(() =>
      requireProductionPublishExecutionSafety(
        productionEnv({ DEPLOYMENT_ENVIRONMENT: "Production" })
      )
    ).toThrowError(/DEPLOYMENT_ENVIRONMENT=production exactly/);

    expect(() =>
      requireProductionPublishExecutionSafety(
        productionEnv({
          PRODUCTION_DB_FINGERPRINT: databaseIdentityFingerprint(
            "mysql://user:secret@other-db.internal:3306/not_production"
          ),
        })
      )
    ).toThrowError(/does not match the approved Production database identity/);

    expect(() =>
      requireProductionPublishExecutionSafety(
        productionEnv({
          PRODUCTION_STAGING_DB_FINGERPRINT: databaseIdentityFingerprint(PRODUCTION_URL),
        })
      )
    ).toThrowError(/fingerprints must differ/);
  });

  it("keeps the external provider as an independent fail-closed Production gate", () => {
    expect(() =>
      requireWorkspacePublishRequestPolicy(
        productionEnv({ WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "false" })
      )
    ).toThrowError(/external provider is not enabled/i);
  });

  it("preserves legacy Preview activation through WORKSPACE_PUBLISH_EXECUTION_ENABLED", () => {
    const active = resolveWorkspacePublishExecutionPolicy(previewEnv());
    expect(active.mode).toBe("legacy-preview");
    expect(active.executionEnabled).toBe(true);
    expect(active.finalGateExecutionBlock).toBe(true);
    expect(active.safety).toEqual({ tier: "preview", databaseName: "ipenovel_preview" });

    const disabled = resolveWorkspacePublishExecutionPolicy(
      previewEnv({ WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false" })
    );
    expect(disabled.mode).toBe("disabled");
    expect(disabled.executionEnabled).toBe(false);
    expect(disabled.safety).toBeNull();
  });

  it("checks execution/provider flags before any outbox claim", () => {
    const source = readFileSync(new URL("./publishExecution.runtime.ts", import.meta.url), "utf8");
    const executionGuard = source.indexOf("if (!input.executionEnabled)");
    const providerGuard = source.indexOf('input.provider.mode === "external" && !input.allowExternalProvider');
    const claim = source.indexOf("await claimPublishOutbox");
    expect(executionGuard).toBeGreaterThan(-1);
    expect(providerGuard).toBeGreaterThan(executionGuard);
    expect(claim).toBeGreaterThan(providerGuard);
  });
});
