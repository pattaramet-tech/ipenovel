// IPE-069R5L-R4G P2-02 — run-wide evidence directory claiming.
//
// Playwright workers and retries are separate processes: per-worker claims
// scatter Guest/User/Admin evidence across directories. The directory must
// therefore be claimed ONCE by the main runner process (playwright.config.ts)
// and handed to every worker and retry through process.env inheritance —
// with the atomic EEXIST guard guaranteeing a repeated E2E_RUN_ID across
// invocations still gets a fresh, suffixed directory.
import { createUniqueRunEvidenceDir, writeRunMarker } from "./evidence";

export interface NavbarRunEvidenceClaim {
  runId: string;
  dir: string;
}

/**
 * Claim the navbar run-wide evidence directory. Called ONCE from the
 * Playwright runner (config top-level); the returned identity is published
 * via process.env so every worker and retry — including Playwright retries
 * that spawn a fresh worker — resolves to the SAME directory, while a
 * repeated E2E_RUN_ID across invocations is atomically given a new
 * suffixed directory instead of reusing stale evidence.
 */
export function claimNavbarRunEvidence(evidenceRoot: string): NavbarRunEvidenceClaim {
  const runId = process.env.E2E_RUN_ID?.trim() ||
    `navbar-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dir = createUniqueRunEvidenceDir(evidenceRoot, runId);
  writeRunMarker(dir, runId);
  return { runId, dir };
}