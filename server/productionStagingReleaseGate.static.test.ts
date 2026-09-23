import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const rcWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "main-release-candidate.yml"),
  "utf8"
);
const stagingWorkflow = fs.readFileSync(
  path.join(
    repoRoot,
    ".github",
    "workflows",
    "production-staging-regression.yml"
  ),
  "utf8"
);
const stagingGate = fs.readFileSync(
  path.join(repoRoot, "scripts", "e2e-production-staging-gate.mjs"),
  "utf8"
);
const stagingPreflight = fs.readFileSync(
  path.join(repoRoot, "scripts", "production-staging-preflight.mjs"),
  "utf8"
);
const rcPreflight = fs.readFileSync(
  path.join(repoRoot, "scripts", "main-release-candidate-preflight.mjs"),
  "utf8"
);
const stagingSafety = fs.readFileSync(
  path.join(repoRoot, "server", "_core", "productionStagingSafety.ts"),
  "utf8"
);
const serverEntry = fs.readFileSync(
  path.join(repoRoot, "server", "_core", "index.ts"),
  "utf8"
);

describe("M12D.9A main-bound isolated Production staging", () => {
  it("creates release candidates only by explicit dispatch from exact main HEAD", () => {
    expect(rcWorkflow).toContain("workflow_dispatch:");
    expect(rcWorkflow).not.toMatch(/^\\s*push\\s*:/m);
    expect(rcWorkflow).toContain("CREATE_MAIN_RELEASE_CANDIDATE");
    expect(rcPreflight).toContain("candidate !== mainHead");
    expect(rcPreflight).toContain("origin/main");
  });

  it("binds the release candidate to the declared Production baseline", () => {
    expect(rcWorkflow).toContain("production_baseline_sha:");
    expect(rcWorkflow).toContain(
      "node scripts/production-staging-status.mjs rc-baseline final"
    );
    expect(stagingPreflight).toContain("production-staging/rc-baseline/");
    expect(stagingPreflight).toContain("isAncestor(baseline, candidate)");
  });

  it("allows staging regression only from repository dispatch for production-staging", () => {
    expect(stagingWorkflow).toContain("production-staging-deployed");
    expect(stagingWorkflow).not.toMatch(/^\\s*push\\s*:/m);
    expect(stagingWorkflow).toContain(
      "PRODUCTION_STAGING_ENVIRONMENT: ${{ github.event.client_payload.environment || '' }}"
    );
    expect(stagingWorkflow).toContain(
      "PRODUCTION_STAGING_SOURCE_BRANCH: ${{ github.event.client_payload.source_branch || '' }}"
    );
    expect(stagingPreflight).toContain("environment !== STAGING_ENVIRONMENT");
    expect(stagingPreflight).toContain('sourceBranch !== "main"');
  });

  it("pins staging browser tests to the dedicated non-Production host and exact revision", () => {
    expect(stagingGate).toContain(
      'const STAGING_HOST = "production-staging.ipenovel.com"'
    );
    expect(stagingGate).toContain("revision === expectedRevision");
    expect(stagingGate).toContain("environment === expectedEnvironment");
    expect(stagingGate).toContain('runProject("public")');
    expect(stagingGate).toContain('runProject("auth")');
    expect(stagingGate).toContain('runProject("admin")');
    expect(stagingGate).toContain('runProject("mutation"');
    expect(stagingGate).not.toContain("https://ipenovel.com");
  });

  it("requires isolated staging authentication state instead of Preview state", () => {
    expect(stagingWorkflow).toContain(
      "E2E_PRODUCTION_STAGING_USER_STORAGE_STATE_B64"
    );
    expect(stagingWorkflow).toContain(
      "E2E_PRODUCTION_STAGING_ADMIN_STORAGE_STATE_B64"
    );
    expect(stagingGate).toContain("E2E_STAGING_USER_STORAGE_STATE_B64");
    expect(stagingGate).toContain("E2E_STAGING_ADMIN_STORAGE_STATE_B64");
  });

  it("guards the staging database identity before startup migrations", () => {
    expect(stagingSafety).toContain(
      'PRODUCTION_STAGING_ENVIRONMENT = "production-staging"'
    );
    expect(stagingSafety).toContain("PRODUCTION_STAGING_DB_FINGERPRINT");
    expect(stagingSafety).toContain("PRODUCTION_DB_FINGERPRINT");
    expect(stagingSafety).toContain("actual === production");
    const safetyIndex = serverEntry.indexOf(
      "assertProductionStagingDatabaseIsolation();"
    );
    const migrateIndex = serverEntry.indexOf("await ensureDatabaseMigrated();");
    expect(safetyIndex).toBeGreaterThan(-1);
    expect(migrateIndex).toBeGreaterThan(safetyIndex);
  });

  it("never adds a Production deploy mutation to staging workflows", () => {
    const combined =
      rcWorkflow + stagingWorkflow + stagingGate + stagingPreflight;
    expect(combined).not.toContain("COOLIFY_API_TOKEN");
    expect(combined).not.toContain("/api/v1/deploy");
    expect(combined).not.toContain("production-deployed");
  });
});
