import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const promotionWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "production-promotion.yml"),
  "utf8"
);
const verifyWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "production-deploy-verify.yml"),
  "utf8"
);
const preflight = fs.readFileSync(
  path.join(repoRoot, "scripts", "production-promotion-preflight.mjs"),
  "utf8"
);
const verification = fs.readFileSync(
  path.join(repoRoot, "scripts", "production-deployment-verify.mjs"),
  "utf8"
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);

describe("M12D.9 Controlled Production Promotion", () => {
  it("requires explicit manual authorization inputs and never promotes on push", () => {
    expect(promotionWorkflow).toContain("workflow_dispatch:");
    expect(promotionWorkflow).not.toMatch(/^\s*push\s*:/m);
    expect(promotionWorkflow).toContain("backup_confirmed:");
    expect(promotionWorkflow).toContain("baseline_confirmed:");
    expect(promotionWorkflow).toContain("migration_review_confirmed:");
    expect(promotionWorkflow).toContain("AUTHORIZE_PRODUCTION_PROMOTION");
    expect(promotionWorkflow).toContain('test "$GITHUB_REF_NAME" = "main"');
    expect(promotionWorkflow).toContain("run: pnpm test:gate");
    expect(promotionWorkflow).toContain(
      "VITE_PAYMENT_QR_IMAGE_URL: ${{ vars.PRODUCTION_VITE_PAYMENT_QR_IMAGE_URL }}"
    );
    expect(promotionWorkflow).toContain(
      "Missing repository variable PRODUCTION_VITE_PAYMENT_QR_IMAGE_URL"
    );
  });

  it("grants status/read permissions but no repository or deployment write permission", () => {
    expect(promotionWorkflow).toContain("contents: read");
    expect(promotionWorkflow).toContain("actions: read");
    expect(promotionWorkflow).toContain("statuses: write");
    expect(promotionWorkflow).not.toContain("contents: write");
    expect(promotionWorkflow).not.toContain("deployments: write");
  });

  it("contains no automated Coolify Production deploy or API token path", () => {
    const combined =
      promotionWorkflow + verifyWorkflow + preflight + verification;
    expect(combined).not.toContain("COOLIFY_API_TOKEN");
    expect(combined).not.toContain("/api/v1/deploy");
    expect(combined).not.toContain("119.10.137.15");
  });

  it("binds authorization to exact main-bound Production staging evidence and rollback ancestry", () => {
    expect(preflight).toContain(
      'const MAIN_BOUND_CONTEXT = "production-staging/main-bound-rc"'
    );
    expect(preflight).toContain(
      'const STAGING_STATUS_CONTEXT = "production-staging/release-candidate"'
    );
    expect(preflight).toContain('new URL("/readyz", stagingBase)');
    expect(preflight).toContain(
      "stagingReady?.environment !== STAGING_ENVIRONMENT"
    );
    expect(preflight).toContain("isAncestor(rollback, candidate)");
    expect(preflight).toContain("isAncestor(candidate, mainHead)");
    expect(preflight).toContain('stagingRun?.event !== "repository_dispatch"');
    expect(preflight).toContain("production-staging/release-baseline/");
  });

  it("reports migration delta and blocks unreviewed destructive-looking schema operations", () => {
    expect(preflight).toContain('"drizzle/*.sql"');
    expect(preflight).toContain("DROP\\s+(?:TABLE|COLUMN|INDEX)");
    expect(preflight).toContain("PRODUCTION_MIGRATION_REVIEW_CONFIRMED");
    expect(preflight).toContain("riskyMigrationOperations");
  });

  it("post-deploy verification is production-only, exact-SHA and read-only", () => {
    expect(verifyWorkflow).toContain("production-deployed");
    expect(verifyWorkflow).toContain(
      "PRODUCTION_BASE_URL: https://ipenovel.com"
    );
    expect(verification).toContain(
      'const AUTH_CONTEXT = "production/promotion-authorization"'
    );
    expect(verification).toContain("parsed.hostname !== PROD_HOST");
    expect(verification).toContain("revision === sha");
    expect(verification).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
  });

  it("exposes reusable operator preflight/check/verification commands", () => {
    expect(pkg.scripts["production:promotion:preflight"]).toBe(
      "node scripts/production-promotion-preflight.mjs"
    );
    expect(pkg.scripts["production:promotion:check"]).toBe(
      "node scripts/production-promotion-check.mjs"
    );
    expect(pkg.scripts["production:deployment:verify"]).toBe(
      "node scripts/production-deployment-verify.mjs"
    );
  });
});
