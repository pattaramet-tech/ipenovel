import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const workflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "preview-regression.yml"
);
const runnerPath = path.join(repoRoot, "scripts", "e2e-preview-gate.mjs");

describe("M12D.8.2 Preview deploy regression gate", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const runner = fs.readFileSync(runnerPath, "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  );

  it("targets only the dedicated Preview host and never production", () => {
    expect(workflow).toContain("E2E_BASE_URL: https://r2-preview.ipenovel.com");
    expect(runner).toContain('const PREVIEW_HOST = "r2-preview.ipenovel.com"');
    expect(workflow).not.toContain("https://ipenovel.com");
    expect(runner).not.toContain("https://ipenovel.com");
  });

  it("runs only after an explicit/manual or post-deploy dispatch, never directly on push", () => {
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/repository_dispatch:/);
    expect(workflow).toMatch(/preview-deployed/);
    expect(workflow).not.toMatch(/^\s*push\s*:/m);
  });

  it("keeps authenticated state in GitHub secrets and uploads only test artifacts", () => {
    expect(workflow).toContain("E2E_PREVIEW_USER_STORAGE_STATE_B64");
    expect(workflow).toContain("E2E_PREVIEW_ADMIN_STORAGE_STATE_B64");
    expect(workflow).toContain("playwright-report/");
    expect(workflow).toContain("test-results/playwright/");
    expect(workflow).not.toMatch(/\.playwright\/\.auth\/.*\n\s*$/m);
  });

  it("full profile requires user/admin state and includes the reversible mutation project", () => {
    expect(runner).toMatch(/profile === "full" && !hasUserState/);
    expect(runner).toMatch(/profile === "full" && !hasAdminState/);
    expect(runner).toMatch(/runProject\("public"\)/);
    expect(runner).toMatch(/runProject\("auth"\)/);
    expect(runner).toMatch(/runProject\("admin"\)/);
    expect(runner).toMatch(
      /runProject\("mutation", \{ E2E_ALLOW_MUTATION: "1" \}\)/
    );
  });

  it("waits for stable health/readiness before browser tests", () => {
    expect(runner).toContain('fetchJson("/healthz")');
    expect(runner).toContain('fetchJson("/readyz")');
    expect(runner).toContain("stableRequired");
  });

  it("exposes the gate through the package script", () => {
    expect(pkg.scripts["test:e2e:preview-gate"]).toBe(
      "node scripts/e2e-preview-gate.mjs"
    );
  });
});
