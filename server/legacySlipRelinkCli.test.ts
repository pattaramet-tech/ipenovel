import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLegacySlipRelinkArgs } from "../scripts/lib/legacySlipRelinkOptions";

const sha = "a".repeat(40);
const marker = "DO_NOT_PRINT_PRIVATE_PREPARE_SECRET";
function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/prepare-legacy-slip-relink-plan.ts", ...args],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !/^(DATABASE_URL|R2_|NODE_OPTIONS|DOTENV_)/.test(k)
          )
        ),
        ...extra,
      },
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout + result.stderr).not.toContain(marker);
  return result;
}

describe("legacy relink prepare CLI preflight", () => {
  it("accepts only exact prepare mode, preview confirmation, and a declared exact SHA", () => {
    expect(
      parseLegacySlipRelinkArgs([
        "--confirm-preview",
        `--code-sha=${sha}`,
        "--prepare",
      ])
    ).toEqual({ mode: "prepare", declaredCodeSha: sha });
  });
  it("standalone help is inert with invalid private configuration", () => {
    const result = run(["--help"], {
      DATABASE_URL: marker,
      R2_PRIVATE_SECRET_ACCESS_KEY: marker,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No apply");
  });
  it.each([
    [],
    ["--prepare"],
    ["--apply"],
    ["--live"],
    ["--help", "--prepare"],
    ["--prepare", "--confirm-preview"],
    ["--prepare", "--confirm-preview", "--code-sha=0bfea43"],
    ["--prepare", "--confirm-preview", `--code-sha=${sha}`, "--attested"],
    [
      "--prepare",
      "--confirm-preview",
      `--code-sha=${sha}`,
      "--output-dir=/tmp/shared",
    ],
    ["--prepare", "--confirm-preview", `--code-sha=${sha}`, "--limit=1"],
    ["--prepare", "--prepare", `--code-sha=${sha}`],
    [marker],
  ])("rejects unsafe flags %j before clients/output", (...args: string[]) => {
    const result = run(args, { DATABASE_URL: marker });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "INVALID_PREPARE_ARGUMENTS",
      artifactCreated: false,
      writeAuthorized: false,
    });
  });
  it("requires configured Preview database before clients/output", () => {
    const result = run(["--prepare", "--confirm-preview", `--code-sha=${sha}`]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("INVALID_DATABASE_CONFIG");
  });
  it.skipIf(process.platform === "linux")(
    "fails closed on non-Linux before network access",
    () => {
      const result = run(
        ["--prepare", "--confirm-preview", `--code-sha=${sha}`],
        {
          DATABASE_URL: `mysql://user:${marker}@z71vl8sxkolha3jf644qgsgr/ipenovel`,
          R2_PRIVATE_ACCOUNT_ID: "account",
          R2_PRIVATE_ACCESS_KEY_ID: marker,
          R2_PRIVATE_SECRET_ACCESS_KEY: marker,
          R2_PRIVATE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
          R2_PRIVATE_BUCKET_NAME: "ipenovel-staging-private",
        }
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).artifactCreated).toBe(false);
    }
  );
});
