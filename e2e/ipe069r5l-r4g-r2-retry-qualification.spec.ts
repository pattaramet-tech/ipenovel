import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const runId = process.env.IPE069_RUN_ID ?? "";
const runEvidenceDir = process.env.IPE069_RUN_EVIDENCE_DIR ?? "";
const probeFile = runEvidenceDir
  ? path.join(runEvidenceDir, "ipe069r5l-r4g-r2-retry-probe.json")
  : "";

async function holdAfterProbeWrite(): Promise<void> {
  const holdMs = Number(process.env.E2E_RETRY_HOLD_MS ?? "0");
  if (Number.isFinite(holdMs) && holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
}

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

  test("worker replacement keeps this invocation's run id, directory, and marker", async () => {
    const info = test.info();

    if (info.retry === 0) {
      writeFileSync(
        probeFile,
        JSON.stringify(
          {
            attempt: 0,
            retry: info.retry,
            workerIndex: info.workerIndex,
            runId,
            dir: runEvidenceDir,
          },
          null,
          2
        )
      );
      await holdAfterProbeWrite();
      expect(
        info.retry,
        "attempt 0 fails intentionally for the retry qualification"
      ).toBe(1);
    }

    if (!existsSync(probeFile)) {
      throw new Error(
        `Retry probe missing after worker replacement: ${probeFile}`
      );
    }
    const previous = JSON.parse(readFileSync(probeFile, "utf8"));

    expect(previous.attempt, "probe must be the attempt 0 record").toBe(0);
    expect(previous.retry, "probe must come from the first attempt").toBe(0);
    expect(previous.runId, "probe run id must be this invocation").toBe(runId);
    expect(previous.dir, "probe directory must be this claimed directory").toBe(
      runEvidenceDir
    );
    expect(
      info.workerIndex,
      "retry must run in a replacement worker"
    ).not.toBe(previous.workerIndex);
    expect(readFileSync(path.join(runEvidenceDir, ".run-id"), "utf8")).toBe(
      runId
    );

    rmSync(probeFile, { force: true });
    expect(existsSync(probeFile), "probe cleanup removes only the probe file").toBe(
      false
    );
    expect(existsSync(runEvidenceDir), "probe cleanup keeps the claimed directory").toBe(
      true
    );
    expect(readFileSync(path.join(runEvidenceDir, ".run-id"), "utf8")).toBe(
      runId
    );
  });
});
