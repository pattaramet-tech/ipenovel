import { describe, it, expect } from "vitest";
import { runGateBSteps, GATE_B_STEPS, type GateBStep, type SpawnSyncFn } from "../../scripts/run-gate-b";

/**
 * DB-independent, in-process coverage for runGateBSteps() - the real
 * exported control-flow function scripts/run-gate-b.ts's CLI entrypoint
 * calls. Uses a fake spawnFn (never a real child process, never a real
 * database) so every branch (stop-on-first-failure, exit-code
 * propagation, "later steps never run after a failure") is proven
 * directly against the actual implementation, deterministically and
 * quickly. See runGateB.subprocess.test.ts for genuine subprocess-level
 * coverage of the real CLI entrypoint itself.
 */

function makeFakeSpawn(statuses: Array<number | "error">): { spawnFn: SpawnSyncFn; callCount: () => number } {
  let callIndex = 0;
  const spawnFn: SpawnSyncFn = (() => {
    const outcome = statuses[callIndex];
    callIndex += 1;
    if (outcome === "error") {
      return { status: null, error: new Error("spawn failed"), pid: 0, output: [], stdout: null, stderr: null, signal: null } as any;
    }
    return { status: outcome, error: undefined, pid: 0, output: [], stdout: null, stderr: null, signal: null } as any;
  }) as SpawnSyncFn;
  return { spawnFn, callCount: () => callIndex };
}

const STEPS: GateBStep[] = [
  { label: "step 1 (prepare)", command: "does-not-matter", args: [] },
  { label: "step 2 (vitest)", command: "does-not-matter", args: [] },
];

describe("runGateBSteps", () => {
  it("prepare (first step) failure returns nonzero, and the second step is never run", () => {
    const { spawnFn, callCount } = makeFakeSpawn([1]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).toBe(1);
    expect(callCount()).toBe(1);
  });

  it("vitest (second step) failure returns nonzero after prepare succeeds", () => {
    const { spawnFn, callCount } = makeFakeSpawn([0, 1]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).toBe(1);
    expect(callCount()).toBe(2);
  });

  it("full success (both steps exit 0) returns zero", () => {
    const { spawnFn, callCount } = makeFakeSpawn([0, 0]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).toBe(0);
    expect(callCount()).toBe(2);
  });

  it("preserves the exact nonzero exit code a step reported, not just a generic 1", () => {
    const { spawnFn } = makeFakeSpawn([7]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).toBe(7);
  });

  it("a spawn-level error (e.g. the command could not be launched at all) is treated as a failure and stops the sequence", () => {
    const { spawnFn, callCount } = makeFakeSpawn(["error"]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).not.toBe(0);
    expect(callCount()).toBe(1);
  });

  it("a failed test run inside a step is never reinterpreted as success - a nonzero status always propagates", () => {
    const { spawnFn } = makeFakeSpawn([0, 1]);

    const exitCode = runGateBSteps(STEPS, spawnFn);

    expect(exitCode).not.toBe(0);
  });
});

describe("GATE_B_STEPS - the real, production step definitions", () => {
  it("has exactly two steps: prepare, then the migration-0024 integration test file only", () => {
    expect(GATE_B_STEPS).toHaveLength(2);
    expect(GATE_B_STEPS[0].label).toMatch(/test:db:prepare/);
    expect(GATE_B_STEPS[1].label).toMatch(/migration-0024/);
  });

  it("never uses a shell pipeline (no '|' or 'tee' in any step's command/args)", () => {
    for (const step of GATE_B_STEPS) {
      expect(step.command).not.toMatch(/\|/);
      for (const arg of step.args) {
        expect(arg).not.toMatch(/\|/);
        expect(arg).not.toMatch(/\btee\b/);
      }
    }
  });

  it("the second step scopes vitest to exactly the migration-0024 integration test file, not the whole integration suite", () => {
    const secondStepArgs = GATE_B_STEPS[1].args.join(" ");
    expect(secondStepArgs).toMatch(/vitest\.integration\.config\.ts/);
    expect(secondStepArgs).toMatch(/migration-0024-episode-schema-repair\.integration\.test\.ts/);
  });
});
