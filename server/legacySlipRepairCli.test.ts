import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const marker = "DO_NOT_PRINT_PRIVATE_REPAIR_SECRET";
const sha = "a".repeat(40);
function run(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/repair-legacy-slip-reference.ts", ...args],
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
      },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout + result.stderr).not.toContain(marker);
  return result;
}

describe("repair CLI cannot apply", () => {
  it("standalone help is inert even with invalid credentials", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No apply/live mode");
  });
  it.each([
    [],
    ["--apply"],
    ["--live"],
    ["--dry-run", "--apply"],
    ["--help", "--live"],
    [
      "--record-attestation",
      "--plan=/root/p/plan.json",
      "--statement=/root/p/s.json",
      `--code-sha=${sha}`,
      "--approve",
    ],
    [
      "--dry-run",
      "--confirm-preview",
      "--plan=/root/p/plan.json",
      "--attestation=/root/p/a.json",
      `--code-sha=${sha}`,
      "--target=11280001",
    ],
    [
      "--dry-run=",
      "--confirm-preview",
      "--plan=/root/p/plan.json",
      "--attestation=/root/p/a.json",
      `--code-sha=${sha}`,
    ],
    [marker],
  ])("rejects unsafe args before credentials/files %j", (...args: string[]) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "INVALID_REPAIR_ARGUMENTS",
      artifactCreated: false,
      databaseWrites: 0,
      objectWrites: 0,
      liveApplyAvailable: false,
    });
  });
  it.skipIf(process.platform === "linux")(
    "valid record request fails platform gate before private input",
    () => {
      const result = run([
        "--record-attestation",
        "--plan=/root/p/plan.json",
        "--statement=/root/p/s.json",
        `--code-sha=${sha}`,
      ]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe("UNSUPPORTED_PLATFORM");
    }
  );
  it("entry point never imports writer, migration, approval service, or dotenv", () => {
    const cli = readFileSync(
      new URL("../scripts/repair-legacy-slip-reference.ts", import.meta.url),
      "utf8"
    );
    expect(cli).not.toMatch(
      /legacySlipRepairWriter|executeLegacySlipRepair|migrate\.mjs|dotenv|approvePayment|recheckOcr/
    );
  });
});
