import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const marker = "DO_NOT_ECHO_PRIVATE_MARKER";

function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/audit-legacy-slip-references.ts", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      // Preserve OS/loader environment, but never pass ambient DB/R2 settings.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(DATABASE_URL|R2_|NODE_OPTIONS|DOTENV_)/.test(key)
          )
        ),
        ...overrides,
      },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(marker);
  expect(result.signal).toBeNull();
  return result;
}

describe("legacy slip audit real CLI preflight (no network)", () => {
  it("standalone help ignores invalid/private environment and never loads runtime", () => {
    const result = run(["--help"], {
      DATABASE_URL: marker,
      R2_PRIVATE_ENDPOINT: marker,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No apply/live mode");
    expect(result.stderr).toBe("");
  });

  it.each([
    [],
    ["--live"],
    ["--apply"],
    ["--dry-run"],
    ["--confirm-preview"],
    ["--dry-run", "--confirm-preview", "--limit=1"],
    ["--dry-run", "--confirm-preview", "--mark-complete"],
    ["--help", "--dry-run"],
    ["--dry-run", "--dry-run"],
    [marker],
  ])(
    "rejects flags %j before environment or client loading",
    (...args: string[]) => {
      const result = run(args, { DATABASE_URL: marker });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        type: "fatal",
        code: "INVALID_ARGUMENTS",
      });
    }
  );

  it("rejects missing database configuration with a fixed code", () => {
    const result = run(["--dry-run", "--confirm-preview"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      type: "fatal",
      code: "INVALID_DATABASE_CONFIG",
    });
  });

  it("rejects a non-preview URL without connecting or echoing its password", () => {
    const result = run(["--dry-run", "--confirm-preview"], {
      DATABASE_URL: `mysql://user:${marker}@127.0.0.1:1/production`,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      type: "fatal",
      code: "PREVIEW_TARGET_MISMATCH",
    });
  });

  it("requires private storage configuration before importing runtime or connecting", () => {
    const result = run(["--dry-run", "--confirm-preview"], {
      DATABASE_URL: `mysql://user:${marker}@z71vl8sxkolha3jf644qgsgr:3306/ipenovel`,
      R2_ACCOUNT_ID: marker,
      R2_ACCESS_KEY_ID: marker,
      R2_SECRET_ACCESS_KEY: marker,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      type: "fatal",
      code: "INVALID_PRIVATE_R2_CONFIG",
    });
  });
});
