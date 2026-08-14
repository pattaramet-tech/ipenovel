import { afterEach, describe, expect, it, vi } from "vitest";
// The CLI script lives under scripts/ (outside this project's `include`
// glob, see vitest.config.ts) - imported here from a server/**/*.test.ts
// file so parseArgs/reportCliCrash are still covered without changing the
// shared test collection config. Importing this module never triggers
// main() (see its own isDirectExecution guard) - only parseArgs and
// reportCliCrash are exercised below.
import { parseArgs, reportCliCrash } from "../scripts/migrate-legacy-manus-assets-to-r2";

describe("migrate-legacy-manus-assets-to-r2.ts - parseArgs", () => {
  it("defaults: not dry-run, limit=20, type=all, startId=0, no column", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: 20, type: "all", startId: 0, column: undefined });
  });

  it("--dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("--limit=N", () => {
    expect(parseArgs(["--limit=5"]).limit).toBe(5);
  });

  it("rejects a non-positive --limit", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--limit=-3"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--limit=abc"])).toThrow(/Invalid --limit/);
  });

  it("--start-id=N", () => {
    expect(parseArgs(["--start-id=100"]).startId).toBe(100);
  });

  it("rejects a negative --start-id", () => {
    expect(() => parseArgs(["--start-id=-1"])).toThrow(/Invalid --start-id/);
  });

  it.each(["payments", "wallet", "sports", "all"])("--type=%s is accepted", (type) => {
    expect(parseArgs([`--type=${type}`]).type).toBe(type);
  });

  it("rejects an invalid --type", () => {
    expect(() => parseArgs(["--type=novels"])).toThrow(/Invalid --type/);
  });

  it.each(["home", "away", "cover"])("--column=%s is accepted with --type=sports", (column) => {
    expect(parseArgs(["--type=sports", `--column=${column}`]).column).toBe(column);
  });

  it("--column is accepted with --type=all", () => {
    expect(parseArgs(["--type=all", "--column=home"]).column).toBe("home");
  });

  it("rejects an invalid --column value", () => {
    expect(() => parseArgs(["--type=sports", "--column=goalkeeper"])).toThrow(/Invalid --column/);
  });

  it("rejects --column with --type=payments (not applicable)", () => {
    expect(() => parseArgs(["--type=payments", "--column=home"])).toThrow(/--column is only valid with/);
  });

  it("rejects --column with --type=wallet (not applicable)", () => {
    expect(() => parseArgs(["--type=wallet", "--column=cover"])).toThrow(/--column is only valid with/);
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
