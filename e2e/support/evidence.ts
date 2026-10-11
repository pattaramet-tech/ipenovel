// IPE-069R5L-R4E-R2 — evidence isolation helpers (pure, filesystem-only).
//
// Evidence from an EARLIER execution must never make an INCOMPLETE later run
// look complete: every run gets its own directory derived from a unique run
// id, the directory must be freshly created by that run, and completeness is
// decided only by the presence of the files the run itself declares.
import fs from "node:fs";
import path from "node:path";

/** Unique per-execution evidence directory: <root>/run-<runId>. */
export function buildRunEvidenceDir(evidenceRoot: string, runId: string): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  return path.join(evidenceRoot, `run-${safeRunId}`);
}

/**
 * Freshness guarantee: the run directory must NOT exist before the run
 * creates it. A pre-existing directory means a previous (possibly
 * incomplete) execution left files behind — the caller must pick a new run
 * id instead of silently reusing stale evidence.
 */
export function isFreshEvidenceDir(dir: string): boolean {
  return !fs.existsSync(dir);
}

export function createFreshRunEvidenceDir(dir: string): void {
  if (!isFreshEvidenceDir(dir)) {
    throw new Error(`Evidence directory already exists (stale run id?): ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
}

/** Files declared by a run that must exist for the evidence to count as complete. */
export function evidenceCompleteness(
  dir: string,
  requiredFiles: readonly string[]
): { complete: boolean; missing: string[] } {
  const missing = requiredFiles.filter(
    (file) => !fs.existsSync(path.join(dir, file))
  );
  return { complete: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// IPE-069R5L-R4E-R3 — atomic run-directory creation + run-scoped integrity.
//
// Repeating an E2E_RUN_ID must never let a later execution read screenshots
// left by an earlier one: directories are claimed ATOMICALLY (mkdir fails
// with EEXIST on any collision, including across Playwright workers), and a
// run marker binds the directory to the execution that created it —
// completeness is only granted to the run id written in that marker.
// ---------------------------------------------------------------------------

export const RUN_MARKER_FILE = ".run-id";

/**
 * Atomically claim a UNIQUE directory for this execution. Never reuses an
 * existing directory: on EEXIST the candidate is suffixed and retried, so a
 * repeated E2E_RUN_ID (or a concurrent worker) gets its own directory and
 * cannot see the previous execution's screenshots.
 */
export function createUniqueRunEvidenceDir(
  evidenceRoot: string,
  runId: string
): string {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const base = buildRunEvidenceDir(evidenceRoot, runId);
  let candidate = base;
  let attempt = 1;
  for (;;) {
    try {
      fs.mkdirSync(candidate); // atomic — EEXIST means already claimed
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      attempt += 1;
      candidate = `${base}-${attempt}`;
    }
  }
}

/** Bind a freshly claimed directory to the execution that created it. */
export function writeRunMarker(dir: string, runId: string): void {
  fs.writeFileSync(path.join(dir, RUN_MARKER_FILE), runId, "utf8");
}

/**
 * Run-scoped completeness: the directory must carry a marker written by THIS
 * execution (runId match) before its files are considered — evidence from an
 * older execution (same files, different marker) reports complete=false with
 * every file listed as missing and stale=true.
 */
export function evidenceCompletenessForRun(
  dir: string,
  runId: string,
  requiredFiles: readonly string[]
): { complete: boolean; missing: string[]; stale: boolean } {
  const markerPath = path.join(dir, RUN_MARKER_FILE);
  const markerRunId = fs.existsSync(markerPath)
    ? fs.readFileSync(markerPath, "utf8")
    : null;
  if (markerRunId !== runId) {
    return { complete: false, missing: [...requiredFiles], stale: true };
  }
  const missing = requiredFiles.filter(
    (file) => !fs.existsSync(path.join(dir, file))
  );
  return { complete: missing.length === 0, missing, stale: false };
}