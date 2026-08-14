import { describe, expect, it } from "vitest";
// The CLI script lives under scripts/ (outside this project's `include`
// glob, see vitest.config.ts) - imported here from a server/**/*.test.ts
// file so parseArgs is still covered without changing the shared test
// collection config. Importing this module never triggers main() (see its
// own isDirectExecution guard) - only parseArgs is exercised below.
import { parseArgs } from "../scripts/migrate-legacy-manus-assets-to-r2";

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
