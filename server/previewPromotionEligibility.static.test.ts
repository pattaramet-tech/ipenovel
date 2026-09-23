import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "preview-regression.yml"),
  "utf8"
);
const gateRunner = fs.readFileSync(
  path.join(repoRoot, "scripts", "e2e-preview-gate.mjs"),
  "utf8"
);
const statusWriter = fs.readFileSync(
  path.join(repoRoot, "scripts", "e2e-promotion-status.mjs"),
  "utf8"
);
const statusChecker = fs.readFileSync(
  path.join(repoRoot, "scripts", "e2e-check-promotion-eligibility.mjs"),
  "utf8"
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);

describe("M12D.8.4 SHA-bound Preview promotion eligibility", () => {
  it("grants only the minimal extra GitHub permission needed for commit statuses", () => {
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("statuses: write");
    expect(workflow).not.toContain("deployments: write");
    expect(workflow).not.toContain("contents: write");
  });

  it("records pending then final eligibility only for repository-dispatch runs", () => {
    expect(workflow).toContain("Mark Preview promotion eligibility pending");
    expect(workflow).toContain("node scripts/e2e-promotion-status.mjs pending");
    expect(workflow).toContain("Preview promotion eligibility");
    expect(workflow).toContain("node scripts/e2e-promotion-status.mjs final");
    expect(workflow).toContain(
      "if: ${{ always() && github.event_name == 'repository_dispatch' }}"
    );
  });

  it("binds automated gating to the dedicated Preview branch", () => {
    expect(workflow).toContain(
      "E2E_REQUIRED_DEPLOY_BRANCH: fix/m12d8-reconcile-056-ui"
    );
    expect(workflow).toContain(
      "E2E_DEPLOYED_BRANCH: ${{ github.event.client_payload.branch || '' }}"
    );
    expect(gateRunner).toContain("deployedBranch !== requiredDeployBranch");
    expect(gateRunner).toContain("Repository-dispatch gate requires branch");
  });

  it("marks a SHA eligible only after a successful Full Gate on the required branch", () => {
    expect(statusWriter).toContain(
      'const CONTEXT = "preview/promotion-eligibility"'
    );
    expect(statusWriter).toContain('gateResult === "success"');
    expect(statusWriter).toContain('profile === "full"');
    expect(statusWriter).toContain("branch === requiredBranch");
    expect(statusWriter).toContain('state: "success"');
    expect(statusWriter).toContain('state: "failure"');
  });

  it("does not contain a Production deployment action or Production target", () => {
    expect(workflow).not.toContain("https://ipenovel.com");
    expect(statusWriter).not.toContain("deployments");
    expect(statusWriter).not.toContain("production");
  });

  it("provides a reusable machine-readable eligibility checker", () => {
    expect(statusChecker).toContain(
      'const CONTEXT = "preview/promotion-eligibility"'
    );
    expect(statusChecker).toContain(
      'console.log(`PROMOTABLE=${promotable ? "yes" : "no"}`)'
    );
    expect(pkg.scripts["preview:promotion:check"]).toBe(
      "node scripts/e2e-check-promotion-eligibility.mjs"
    );
  });
});
