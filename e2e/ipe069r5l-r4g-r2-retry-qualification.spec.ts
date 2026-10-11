import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// IPE-069R5L-R4G-R2 Finding B — REAL Playwright retry / worker replacement
// qualification. This spec is ISOLATED: it runs ONLY when
// E2E_RETRY_QUALIFICATION=1 is set (focused run with --retries=1), so the
// intentional first-attempt failure below never appears in the normal full
// E2E suite.
//
// What it proves, per Playwright's real lifecycle:
// 1. Attempt 0 fails intentionally → Playwright tears the worker down and
//    retries in a FRESH worker process (workerIndex changes).
// 2. The run context is ONE per invocation: both attempts see the SAME
//    IPE069_RUN_ID and IPE069_RUN_EVIDENCE_DIR (inherited from the runner).
// 3. No new directory claim happens between the replacement — the run-*
//    directory list in the evidence root is unchanged.
// 4. The run marker still binds the directory to this invocation.
//
// IPE-069R5L-R4G-R3 — the retry probe is per-invocation (not a static filename
// in OS temp), so concurrent focused runs cannot overwrite each other, and
// cleanup only removes the probe created by this execution.
const runId = process.env.IPE069_RUN_ID ?? "";
const runEvidenceDir = process.env.IPE069_RUN_EVIDENCE_DIR ?? "";
const evidenceRoot = runEvidenceDir ? path.dirname(runEvidenceDir) : "";
const probeFile = runEvidenceDir
  ? path.join(
      os.tmpdir(),
      `ipe069r5l-r4g-r2-retry-probe-${path.basename(runEvidenceDir)}.json`
    )
  : "";

const listRunDirs = (): string[] => {
  if (!evidenceRoot || !existsSync(evidenceRoot)) return [];
  return fs
    .readdirSync(evidenceRoot)
    .filter((entry) => entry.startsWith("run-"))
    .sort();
};

test.describe("@local-fixture IPE-069R5L-R4G-R2 real retry/worker replacement", () => {
  test.beforeEach(() => {
    test.skip(
      process.env.E2E_RETRY_QUALIFICATION !== "1",
      "Focused retry qualification runs only with E2E_RETRY_QUALIFICATION=1"
    );
    test.skip(
      !runId || !runEvidenceDir || !existsSync(runEvidenceDir) || !probeFile,
      "Run-wide evidence context not claimed by the runner"
    );
  });

  test("worker replacement keeps ONE run context; no new claim between attempts", async () => {
    const info = test.info();

    if (info.retry === 0) {
      // Attempt 0: record the run context, then FAIL INTENTIONALLY so
      // Playwright tears this worker down and retries in a fresh one.
      const before = listRunDirs();
      writeFileSync(
        probeFile,
        JSON.stringify(
          {
            attempt: 0,
            retry: info.retry,
            workerIndex: info.workerIndex,
            runId,
            dir: runEvidenceDir,
            runDirs: before,
          },
          null,
          2
        )
      );
      expect(
        info.retry,
        "attempt 0 fails intentionally for the retry qualification"
      ).toBe(1);
    }

    // Attempt 1 (after the real worker replacement):
    // The probe MUST exist; if it does not, the worker replacement/probe
    // lifecycle is broken and this must FAIL (not skip).
    if (!existsSync(probeFile)) {
      throw new Error(
        `Retry probe missing after worker replacement: ${probeFile}`
      );
    }
    const previous = JSON.parse(readFileSync(probeFile, "utf8"));

    // One run context: same run id, same evidence directory.
    expect(previous.runId).toBe(runId);
    expect(previous.dir).toBe(runEvidenceDir);
    // Worker replacement is REAL: the retry runs in a different worker.
    expect(info.workerIndex).not.toBe(previous.workerIndex);
    // No new claim between replacement: the run-* directory list is
    // unchanged (a new claim would append a run-* entry).
    expect(listRunDirs()).toEqual(previous.runDirs);
    // The run marker still binds the directory to this invocation.
    expect(readFileSync(path.join(runEvidenceDir, ".run-id"), "utf8")).toBe(
      runId
    );

    // The focused qualification leaves no residue: remove ONLY the probe
    // owned by this invocation.
    rmSync(probeFile, { force: true });
  });
});
