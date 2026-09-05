import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  parseRepairExecutionArgs,
  LEGACY_REPAIR_EXECUTION_RELEASED,
} from "../scripts/lib/legacySlipRepairExecution";

const marker = "PRIVATE_ENV_OR_PATH_MUST_NOT_LEAK";
const valid = [
  "--execute",
  "--confirm-preview",
  "--plan=/private/p.json",
  "--attestation=/private/a.json",
  "--review=/private/r.json",
  "--authorization=/private/z.json",
  `--code-sha=${"a".repeat(40)}`,
];
function run(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/execute-legacy-slip-reference-repair.ts",
      ...args,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(DATABASE_URL|R2_|NODE_OPTIONS|DOTENV_)/.test(key)
          )
        ),
        DATABASE_URL: marker,
        R2_PRIVATE_SECRET_ACCESS_KEY: marker,
        LEGACY_REPAIR_EXECUTION_RELEASED: "true",
        ENABLE_LEGACY_REPAIR: "1",
      },
    }
  );
  expect(r.error).toBeUndefined();
  expect(r.signal).toBeNull();
  expect(r.stdout + r.stderr).not.toContain(marker);
  return r;
}
describe("execution CLI hard release boundary", () => {
  it("standalone help needs no credentials/Linux/files", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("DISABLED release candidate");
    expect(r.stdout).toContain("--reconcile");
  });
  it("execute refuses before private file/platform/environment read even if env requests bypass", () => {
    const r = run(valid);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "BLOCKED",
      code: "LIVE_EXECUTION_RELEASE_GATE_DISABLED",
      liveApplyAvailable: false,
      writerInvoked: false,
      committedDatabaseWrites: 0,
      objectWrites: 0,
    });
  });
  it.each([
    [],
    ["--apply"],
    ["--help", "--execute"],
    [...valid, "--release=true"],
    [...valid, "--host=localhost"],
    [...valid, "--preflight=/private/pf.json"],
    valid.filter(x => x !== "--confirm-preview"),
    valid.filter(x => !x.startsWith("--authorization=")),
    valid.map(x => (x === "--execute" ? "--execute=" : x)),
    valid.map(x =>
      x.startsWith("--review=") ? "--review=/private/../r.json" : x
    ),
    valid.map(x =>
      x.startsWith("--review=") ? "--review=C:/private/r.json" : x
    ),
    valid.map(x =>
      x.startsWith("--review=") ? "--review=/private/a.json" : x
    ),
    valid.map(x => (x.startsWith("--review=") ? "--plan=/private/x.json" : x)),
    valid.map(x => (x.startsWith("--code-sha=") ? "--code-sha=51e4fa2" : x)),
    valid.map(x => (x === "--execute" ? "--reconcile" : x)).concat("--execute"),
    [marker],
  ])("invalid syntax fails without IO %j", (...args: string[]) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr).code).toBe("INVALID_EXECUTION_ARGUMENTS");
  });
  it("parser accepts exact reconcile shape without enabling execution", () => {
    expect(
      parseRepairExecutionArgs(
        valid.map(x => (x === "--execute" ? "--reconcile" : x))
      ).mode
    ).toBe("reconcile");
    expect(LEGACY_REPAIR_EXECUTION_RELEASED).toBe(false);
  });
  it("entry point has no runtime release/host/pin override or writer import", () => {
    const source = readFileSync(
      new URL(
        "../scripts/execute-legacy-slip-reference-repair.ts",
        import.meta.url
      ),
      "utf8"
    );
    expect(source).not.toMatch(
      /process\.env|legacySlipRepairWriter|dotenv|migrate\.mjs|createConnection|createClient/
    );
  });
});
