import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import {
  parseWorkspacePublishExecutionScope,
  requireWorkspacePublishEnvironmentSafety,
  requireWorkspacePublishRequestPolicy,
  resolveWorkspacePublishExecutionPolicy,
  scopeMatches,
  WorkspacePublishRuntimeError,
} from "./publishExecution.runtime";

const PRODUCTION_URL = "mysql://user:secret@prod-db.internal:3306/ipenovel_prod";
const STAGING_URL = "mysql://user:secret@staging-db.internal:3306/ipenovel_staging";
const PRODUCTION_FINGERPRINT = databaseIdentityFingerprint(PRODUCTION_URL);
const STAGING_FINGERPRINT = databaseIdentityFingerprint(STAGING_URL);

function releaseEnv(
  environment: "production" | "production-staging",
  overrides: Record<string, string | undefined> = {}
) {
  return {
    DEPLOYMENT_ENVIRONMENT: environment,
    DATABASE_URL: environment === "production" ? PRODUCTION_URL : STAGING_URL,
    PRODUCTION_DB_FINGERPRINT: PRODUCTION_FINGERPRINT,
    PRODUCTION_STAGING_DB_FINGERPRINT: STAGING_FINGERPRINT,
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
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

  it("activates Production only when DATABASE_URL matches the approved Production fingerprint", () => {
    const policy = resolveWorkspacePublishExecutionPolicy(releaseEnv("production"));
    expect(policy).toMatchObject({
      mode: "production",
      executionEnabled: true,
      externalProviderEnabled: true,
      safety: {
        tier: "production",
        databaseName: "ipenovel_prod",
        databaseFingerprint: PRODUCTION_FINGERPRINT,
      },
    });

    expect(() =>
      requireWorkspacePublishEnvironmentSafety(
        releaseEnv("production", {
          DATABASE_URL: "mysql://user:secret@wrong.internal:3306/ipenovel_wrong",
        })
      )
    ).toThrowError(/does not match the approved production database identity/i);
  });

  it("activates production-staging only when its DB fingerprint matches and differs from Production", () => {
    const policy = requireWorkspacePublishRequestPolicy(releaseEnv("production-staging"));
    expect(policy).toMatchObject({
      mode: "production-staging",
      executionEnabled: true,
      externalProviderEnabled: true,
      safety: {
        tier: "production-staging",
        databaseName: "ipenovel_staging",
        databaseFingerprint: STAGING_FINGERPRINT,
      },
    });

    expect(() =>
      requireWorkspacePublishEnvironmentSafety(
        releaseEnv("production-staging", {
          PRODUCTION_STAGING_DB_FINGERPRINT: undefined,
        })
      )
    ).toThrowError(/PRODUCTION_STAGING_DB_FINGERPRINT/);

    expect(() =>
      requireWorkspacePublishEnvironmentSafety(
        releaseEnv("production-staging", {
          PRODUCTION_STAGING_DB_FINGERPRINT: PRODUCTION_FINGERPRINT,
        })
      )
    ).toThrowError(/fingerprints must differ/);

    expect(() =>
      requireWorkspacePublishEnvironmentSafety(
        releaseEnv("production-staging", {
          DATABASE_URL: PRODUCTION_URL,
        })
      )
    ).toThrowError(/does not match the approved production-staging database identity/i);
  });

  it("keeps Preview/development environments inactive without a rollout or acceptance flag", () => {
    const policy = resolveWorkspacePublishExecutionPolicy({
      DEPLOYMENT_ENVIRONMENT: "preview",
      DATABASE_URL: "mysql://user:secret@preview.internal:3306/ipenovel_preview",
      WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    } as NodeJS.ProcessEnv);

    expect(policy).toEqual({
      mode: "inactive",
      executionEnabled: false,
      externalProviderEnabled: true,
      safety: null,
    });
    expect(() =>
      requireWorkspacePublishRequestPolicy({
        DEPLOYMENT_ENVIRONMENT: "preview",
        WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
      } as NodeJS.ProcessEnv)
    ).toThrowError(/not active in this deployment environment/i);
  });

  it("keeps the external provider as an independent fail-closed gate in both release environments", () => {
    for (const environment of ["production", "production-staging"] as const) {
      expect(() =>
        requireWorkspacePublishRequestPolicy(
          releaseEnv(environment, { WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "false" })
        )
      ).toThrowError(/external provider is not enabled/i);
    }
  });

  it("rejects non-exact deployment environment literals", () => {
    expect(
      resolveWorkspacePublishExecutionPolicy({
        ...releaseEnv("production"),
        DEPLOYMENT_ENVIRONMENT: "Production",
      })
    ).toMatchObject({ mode: "inactive", executionEnabled: false });
  });

  it("checks execution/provider guards before any outbox claim", () => {
    const source = readFileSync(new URL("./publishExecution.runtime.ts", import.meta.url), "utf8");
    const executionGuard = source.indexOf("if (!input.executionEnabled)");
    const providerGuard = source.indexOf('input.provider.mode === "external" && !input.allowExternalProvider');
    const claim = source.indexOf("await claimPublishOutbox");
    expect(executionGuard).toBeGreaterThan(-1);
    expect(providerGuard).toBeGreaterThan(executionGuard);
    expect(claim).toBeGreaterThan(providerGuard);
  });
});
