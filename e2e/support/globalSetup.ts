// IPE-069R5L-R4G-R1 Finding 1 — run-wide navbar evidence claiming lives in
// the sanctioned Playwright lifecycle: globalSetup runs EXACTLY ONCE per
// actual test invocation (never for `--list`), in the main runner process —
// so the claim is one-per-invocation, not one-per-worker-process, and the
// resolved identity is published via process.env to every worker and retry.
//
// The claimed directory is created ATOMICALLY (EEXIST → suffixed candidate)
// and bound to the run with a marker file: a repeated E2E_RUN_ID across
// invocations gets a fresh suffixed directory instead of stale evidence.
//
// Public-only invocations: the run directory is claimed as bookkeeping (a
// marker only, zero screenshots) because Playwright does not surface the
// CLI project filter to globalSetup — no navbar EVIDENCE files are ever
// written by public-only runs.
import os from "node:os";
import path from "node:path";
import { claimNavbarRunEvidence } from "./runEvidence";

export default function globalSetup(): void {
  const evidenceRoot = process.env.E2E_NAV_EVIDENCE_DIR?.trim() ||
    path.join(os.tmpdir(), "IPE-069R5C-navbar");
  const claim = claimNavbarRunEvidence(evidenceRoot);
  process.env.IPE069_RUN_ID = claim.runId;
  process.env.IPE069_RUN_EVIDENCE_DIR = claim.dir;
}