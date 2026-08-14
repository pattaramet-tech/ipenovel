import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The CLI script lives under scripts/ (outside this project's `include`
// glob, see vitest.config.ts) - imported here from a server/**/*.test.ts
// file so parseArgs/main/reportCliCrash are still covered without changing
// the shared test collection config. Importing this module never triggers
// main() itself (see its own isDirectExecution guard) - only the exported
// functions are called directly below.
import { parseArgs, reportCliCrash, formatContinuationAdvice } from "../scripts/migrate-legacy-manus-assets-to-r2";

describe("migrate-legacy-manus-assets-to-r2.ts - parseArgs: general flags", () => {
  it("--dry-run alone is accepted, with the usual defaults", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, limit: 20, type: "all", startId: 0, column: undefined });
  });

  it("--limit=N", () => {
    expect(parseArgs(["--dry-run", "--limit=5"]).limit).toBe(5);
  });

  it("rejects a non-positive or malformed --limit", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--limit=-3"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--limit=abc"])).toThrow(/Invalid --limit/);
  });

  it("--start-id=N", () => {
    expect(parseArgs(["--dry-run", "--start-id=100"]).startId).toBe(100);
  });

  it("rejects a negative --start-id", () => {
    expect(() => parseArgs(["--start-id=-1"])).toThrow(/Invalid --start-id/);
  });

  it.each(["payments", "wallet", "sports", "all"])("--type=%s is accepted (dry-run)", (type) => {
    expect(parseArgs(["--dry-run", `--type=${type}`]).type).toBe(type);
  });

  it("rejects an invalid --type", () => {
    expect(() => parseArgs(["--type=novels"])).toThrow(/Invalid --type/);
  });

  it.each(["home", "away", "cover"])("--column=%s is accepted with --type=sports", (column) => {
    expect(parseArgs(["--dry-run", "--type=sports", `--column=${column}`]).column).toBe(column);
  });

  it("--column is accepted with --type=all", () => {
    expect(parseArgs(["--dry-run", "--type=all", "--column=home"]).column).toBe("home");
  });

  it("rejects an invalid --column value", () => {
    expect(() => parseArgs(["--type=sports", "--column=goalkeeper"])).toThrow(/Invalid --column/);
  });

  it("rejects --column with --type=payments (not applicable)", () => {
    expect(() => parseArgs(["--dry-run", "--type=payments", "--column=home"])).toThrow(/--column is only valid with/);
  });

  it("rejects --column with --type=wallet (not applicable)", () => {
    expect(() => parseArgs(["--dry-run", "--type=wallet", "--column=cover"])).toThrow(/--column is only valid with/);
  });

  it("rejects an unrecognized flag", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unrecognized argument/);
  });

  it("combines multiple flags", () => {
    expect(parseArgs(["--dry-run", "--limit=7", "--type=sports", "--start-id=42", "--column=away"])).toEqual({
      dryRun: true,
      limit: 7,
      type: "sports",
      startId: 42,
      column: "away",
    });
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - parseArgs: strict integer parsing for --limit/--start-id (P2-2)", () => {
  it.each(["20oops", "1e3", "20.5", "+20"])("rejects malformed --limit=%s", (value) => {
    expect(() => parseArgs([`--limit=${value}`])).toThrow(/Invalid --limit/);
  });

  it.each(["100oops", "1e3", "10.5", "-0"])("rejects malformed --start-id=%s", (value) => {
    expect(() => parseArgs([`--start-id=${value}`])).toThrow(/Invalid --start-id/);
  });

  it("--limit=20 is accepted", () => {
    expect(parseArgs(["--dry-run", "--limit=20"]).limit).toBe(20);
  });

  it("--start-id=0 is accepted", () => {
    expect(parseArgs(["--dry-run", "--start-id=0"]).startId).toBe(0);
  });

  it("--start-id=100 is accepted", () => {
    expect(parseArgs(["--dry-run", "--start-id=100"]).startId).toBe(100);
  });

  it("accepts a --limit exactly at Number.MAX_SAFE_INTEGER", () => {
    expect(parseArgs(["--dry-run", `--limit=${Number.MAX_SAFE_INTEGER}`]).limit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accepts a --start-id exactly at Number.MAX_SAFE_INTEGER", () => {
    expect(parseArgs(["--dry-run", `--start-id=${Number.MAX_SAFE_INTEGER}`]).startId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a --limit one past Number.MAX_SAFE_INTEGER", () => {
    const tooBig = (Number.MAX_SAFE_INTEGER + 1).toString();
    expect(() => parseArgs([`--limit=${tooBig}`])).toThrow(/Invalid --limit/);
  });

  it("rejects a --start-id one past Number.MAX_SAFE_INTEGER", () => {
    const tooBig = (Number.MAX_SAFE_INTEGER + 1).toString();
    expect(() => parseArgs([`--start-id=${tooBig}`])).toThrow(/Invalid --start-id/);
  });

  it("rejects a pathologically large digit string, far beyond Number.MAX_SAFE_INTEGER", () => {
    expect(() => parseArgs(["--start-id=99999999999999999999"])).toThrow(/Invalid --start-id/);
    expect(() => parseArgs(["--limit=99999999999999999999"])).toThrow(/Invalid --limit/);
  });

  it("never silently truncates or partially parses a malformed value", () => {
    // "20oops" must never be silently accepted as 20.
    let args: ReturnType<typeof parseArgs> | undefined;
    try {
      args = parseArgs(["--dry-run", "--limit=20oops"]);
    } catch {
      // expected
    }
    expect(args).toBeUndefined();
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - parseArgs: mode selection fails closed (P1)", () => {
  it("1. no mode flag -> rejected", () => {
    expect(() => parseArgs([])).toThrow(/No mode flag supplied/);
    expect(() => parseArgs(["--limit=20", "--type=payments"])).toThrow(/No mode flag supplied/);
  });

  it("2. --dry-run only -> accepted", () => {
    expect(() => parseArgs(["--dry-run"])).not.toThrow();
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("3. --live only with explicit payments type -> accepted", () => {
    const args = parseArgs(["--live", "--type=payments"]);
    expect(args.dryRun).toBe(false);
    expect(args.type).toBe("payments");
  });

  it("4. --live wallet -> accepted", () => {
    const args = parseArgs(["--live", "--type=wallet"]);
    expect(args.dryRun).toBe(false);
    expect(args.type).toBe("wallet");
  });

  it("5. --live sports -> accepted", () => {
    const args = parseArgs(["--live", "--type=sports"]);
    expect(args.dryRun).toBe(false);
    expect(args.type).toBe("sports");
  });

  it("6. --dry-run + --live -> rejected", () => {
    expect(() => parseArgs(["--dry-run", "--live", "--type=payments"])).toThrow(
      /Cannot pass both --dry-run and --live/
    );
    expect(() => parseArgs(["--live", "--dry-run", "--type=payments"])).toThrow(
      /Cannot pass both --dry-run and --live/
    );
  });

  it("7. --live --type=all -> rejected", () => {
    expect(() => parseArgs(["--live", "--type=all"])).toThrow(/--live --type=all is not allowed/);
  });

  it("8. --live with no explicit --type -> rejected", () => {
    expect(() => parseArgs(["--live"])).toThrow(/--live requires an explicit --type/);
  });

  it("10. existing dry-run --type=all behavior remains valid", () => {
    expect(parseArgs(["--dry-run", "--limit=20", "--type=all"])).toEqual({
      dryRun: true,
      limit: 20,
      type: "all",
      startId: 0,
      column: undefined,
    });
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - main(): rejection happens BEFORE any DB/R2 access (P1)", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runMainWithArgs(extraArgs: string[]) {
    vi.resetModules();
    const servicePath = "./services/legacyManusAssetMigrationService";
    vi.doMock(servicePath, async () => {
      const actual = await vi.importActual<typeof import("./services/legacyManusAssetMigrationService")>(
        servicePath
      );
      return { ...actual, runLegacyManusAssetMigrationBatch: vi.fn() };
    });
    const service = await import("./services/legacyManusAssetMigrationService");
    const cli = await import("../scripts/migrate-legacy-manus-assets-to-r2");

    process.argv = ["node", "migrate-legacy-manus-assets-to-r2.ts", ...extraArgs];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => {
      throw new Error("process.exit called");
    }) as any));

    await expect(cli.main()).rejects.toThrow("process.exit called");

    return { service, errorSpy, exitSpy };
  }

  it("9a. no mode flag -> runLegacyManusAssetMigrationBatch is never called, exits 1", async () => {
    const { service, exitSpy } = await runMainWithArgs(["--limit=20", "--type=payments"]);
    expect(service.runLegacyManusAssetMigrationBatch).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("9b. --dry-run + --live -> runLegacyManusAssetMigrationBatch is never called, exits 1", async () => {
    const { service, exitSpy } = await runMainWithArgs(["--dry-run", "--live", "--type=payments"]);
    expect(service.runLegacyManusAssetMigrationBatch).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("9c. --live --type=all -> runLegacyManusAssetMigrationBatch is never called, exits 1", async () => {
    const { service, exitSpy } = await runMainWithArgs(["--live", "--type=all"]);
    expect(service.runLegacyManusAssetMigrationBatch).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("9d. --live with no --type -> runLegacyManusAssetMigrationBatch is never called, exits 1", async () => {
    const { service, exitSpy } = await runMainWithArgs(["--live"]);
    expect(service.runLegacyManusAssetMigrationBatch).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints a safe, non-empty usage error for an invalid mode-flag combination", async () => {
    const { errorSpy } = await runMainWithArgs([]);
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).toMatch(/mode flag/i);
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - package.json: no live-by-default migration alias (P1)", () => {
  it("11. package.json contains only the safe dry-run shortcut, no bare live-by-default script", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts;

    expect(scripts["migrate:legacy-manus-assets:dry"]).toBeDefined();
    expect(scripts["migrate:legacy-manus-assets:dry"]).toContain("--dry-run");
    expect(scripts["migrate:legacy-manus-assets:dry"]).not.toContain("--live");

    // The old live-by-default alias must not exist, and no other script may
    // point at this CLI without an explicit --dry-run.
    expect(scripts["migrate:legacy-manus-assets"]).toBeUndefined();
    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes("migrate-legacy-manus-assets-to-r2")) {
        expect(command, `script "${name}" must be --dry-run only`).toContain("--dry-run");
      }
    }
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - formatContinuationAdvice: dry-run vs live (P2-3)", () => {
  it("dry-run + remainingEligible prints dry-run-specific advice", () => {
    const message = formatContinuationAdvice({ dryRun: true, limit: 20, startId: 0, type: "all" }, 5);
    expect(message).toMatch(/re-validate the SAME first --limit=20 eligible/i);
    expect(message).toMatch(/increase --limit/i);
    expect(message).toMatch(/--type=payments.*--type=wallet.*--type=sports/i);
  });

  it("dry-run message does NOT say the same command picks up where it left off", () => {
    const message = formatContinuationAdvice({ dryRun: true, limit: 20, startId: 0, type: "all" }, 5);
    expect(message).not.toMatch(/picks up where this run left off/i);
    expect(message).not.toMatch(/EXACT SAME command \(same --start-id/i);
  });

  it("live + remainingEligible prints exact-same-command resume advice", () => {
    const message = formatContinuationAdvice({ dryRun: false, limit: 20, startId: 100, type: "payments" }, 5);
    expect(message).toMatch(/re-run this EXACT SAME command \(same --start-id=100\)/i);
    expect(message).toMatch(/picks up where this run left off/i);
  });

  it("live behavior remains unchanged: never claims dry-run-specific advice", () => {
    const message = formatContinuationAdvice({ dryRun: false, limit: 20, startId: 0, type: "wallet" }, 3);
    expect(message).not.toMatch(/re-validate the SAME first/i);
    expect(message).not.toMatch(/dry-run never writes anything/i);
  });

  it("both messages mention the shared --limit=N context", () => {
    const dryRunMessage = formatContinuationAdvice({ dryRun: true, limit: 20, startId: 0, type: "all" }, 5);
    const liveMessage = formatContinuationAdvice({ dryRun: false, limit: 20, startId: 0, type: "payments" }, 5);
    expect(dryRunMessage).toContain("--limit=20");
    expect(liveMessage).toContain("--limit=20");
  });
});

describe("migrate-legacy-manus-assets-to-r2.ts - reportCliCrash (P2 sanitization)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never prints a raw DATABASE_URL, password, or signed-URL query string on an unexpected crash", () => {
    const FAKE_DB_HOST = "fake-db-host.internal";
    const FAKE_PASSWORD = "FAKE_PASSWORD_MARKER_hunter2";
    const FAKE_SIGNED_QUERY = "X-Amz-Signature=FAKE_SIGNED_QUERY_MARKER_abc123";
    const rawDriverMessage =
      `Failed query: update payments set slipImageUrl = ? where id = ? ` +
      `params: mysql://root:${FAKE_PASSWORD}@${FAKE_DB_HOST}:3306/ipenovel,1,` +
      `https://d2xsxph8kpxj0f.cloudfront.net/some/slip.png?${FAKE_SIGNED_QUERY}`;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => {
      throw new Error("process.exit called");
    }) as any));

    expect(() => reportCliCrash(new Error(rawDriverMessage))).toThrow("process.exit called");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = errorSpy.mock.calls[0].map((a) => String(a)).join(" ");
    expect(loggedArgs).not.toContain(FAKE_DB_HOST);
    expect(loggedArgs).not.toContain(FAKE_PASSWORD);
    expect(loggedArgs).not.toContain(FAKE_SIGNED_QUERY);
    expect(loggedArgs).not.toContain("d2xsxph8kpxj0f.cloudfront.net");
    expect(loggedArgs).not.toContain("mysql://");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("still logs something recognizable for a plain, already-safe error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    expect(() => reportCliCrash(new Error("ECONNREFUSED"))).toThrow("process.exit called");
    const loggedArgs = errorSpy.mock.calls[0].map((a) => String(a)).join(" ");
    expect(loggedArgs).toContain("ECONNREFUSED");
  });
});
