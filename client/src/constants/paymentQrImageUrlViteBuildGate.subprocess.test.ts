import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Real-subprocess proof that vite.config.ts's payment-QR fail-closed gate
 * (see PR #40's final safety correction) is actually wired up, not just
 * correct in isolation (see paymentQrImageUrl.test.ts for the exhaustive
 * pure-function matrix). Spawns the real `vite build` CLI - not a mock -
 * against this repo's real vite.config.ts.
 *
 * Only the "blank" case is exercised here (not the full missing/http/
 * Manus matrix - that's already exhaustively covered by the fast, pure
 * unit tests above). This is deliberately the one negative case that's
 * both the most safety-critical (a misconfigured deploy silently shipping
 * with no payment QR at all) and the only one that can be reproduced
 * deterministically regardless of whatever a developer's local .env file
 * happens to contain: vite.config.ts resolves this value via Vite's own
 * loadEnv(), which merges file-based values with real process.env, and
 * process.env always wins - so explicitly setting the env var to an empty
 * string here is guaranteed to reproduce the "required" rejection even if
 * a real value is set in a local .env file. The gate throws before any
 * plugin/bundling work starts, so this fails fast (no dist/public writes,
 * no multi-second build).
 */
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const viteBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");

function runViteBuildWithBlankQrUrl() {
  return spawnSync(viteBin, ["build"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_PAYMENT_QR_IMAGE_URL: "",
    },
  });
}

describe("vite.config.ts payment-QR production-build gate (real `vite build` subprocess)", () => {
  it("a blank VITE_PAYMENT_QR_IMAGE_URL fails the real production build with a clear, non-secret error", () => {
    const result = runViteBuildWithBlankQrUrl();

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("VITE_PAYMENT_QR_IMAGE_URL is required for production builds.");
  }, 30000);
});
