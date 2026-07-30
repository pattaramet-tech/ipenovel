import { beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSnapshots } from "../scripts/vps-migration/compare-snapshots.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "vps-migration", "compare-snapshots.mjs");

function snapshot(checks: Record<string, { value: unknown; policy?: "exact" | "informational" }>, migrationTags: string[] = []) {
  return { label: "test-snapshot", takenAt: new Date().toISOString(), checks, migrationTags };
}

describe("compareSnapshots (exact match)", () => {
  it("returns ok:true with no mismatches when every exact check matches and migration tag sets are identical", () => {
    const source = snapshot(
      { approved_orders_count: { value: 10, policy: "exact" }, approved_orders_total: { value: "100.00", policy: "exact" } },
      ["0000_a", "0001_b"]
    );
    const target = snapshot(
      { approved_orders_count: { value: 10, policy: "exact" }, approved_orders_total: { value: "100.00", policy: "exact" } },
      ["0001_b", "0000_a"] // order-independent
    );
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });
});

describe("compareSnapshots (financial mismatch)", () => {
  it("reports a mismatch and ok:false when an exact-policy financial SUM differs", () => {
    const source = snapshot({ approved_orders_total: { value: "1000.00", policy: "exact" } });
    const target = snapshot({ approved_orders_total: { value: "999.99", policy: "exact" } });
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ check: "approved_orders_total", source: "1000.00", target: "999.99" })
    );
  });

  it("tolerates floating-point noise (e.g. 100.10 vs 100.1) as equal, not a false-positive mismatch", () => {
    const source = snapshot({ wallet_balance_total: { value: "100.10", policy: "exact" } });
    const target = snapshot({ wallet_balance_total: { value: 100.1, policy: "exact" } });
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(true);
  });
});

describe("compareSnapshots (entitlement mismatch)", () => {
  it("reports a mismatch and ok:false when an exact-policy entitlement COUNT differs", () => {
    const source = snapshot({ purchases_count: { value: 500, policy: "exact" } });
    const target = snapshot({ purchases_count: { value: 498, policy: "exact" } });
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual(expect.objectContaining({ check: "purchases_count", source: 500, target: 498 }));
  });

  it("reports a mismatch when migration tag sets differ (target missing an applied migration)", () => {
    const source = snapshot({}, ["0000_a", "0001_b", "0002_c"]);
    const target = snapshot({}, ["0000_a", "0001_b"]);
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(false);
    const migrationMismatch = result.mismatches.find((m) => m.check === "migrationTags");
    expect(migrationMismatch?.missingFromTarget).toEqual(["0002_c"]);
  });
});

describe("compareSnapshots (informational / non-critical metadata)", () => {
  it("reports an informational mismatch as a warning, not a blocking mismatch - exit stays 0", () => {
    const source = snapshot({ novels_count: { value: 500, policy: "informational" } });
    const target = snapshot({ novels_count: { value: 502, policy: "informational" } }); // e.g. 2 novels added between snapshots
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ check: "novels_count", source: 500, target: 502 }));
  });

  it("defaults a check with no explicit policy to 'exact' (safer default) AND warns that it should be made explicit", () => {
    const source = snapshot({ mystery_count: { value: 5 } });
    const target = snapshot({ mystery_count: { value: 6 } });
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(false); // treated as exact
    expect(result.warnings.some((w) => w.check === "mystery_count" && w.reason.includes("policy"))).toBe(true);
  });

  it("flags (as a mismatch) a check present in only one snapshot, rather than silently ignoring it", () => {
    const source = snapshot({ only_in_source: { value: 1, policy: "exact" } });
    const target = snapshot({});
    const result = compareSnapshots(source, target);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContainEqual(expect.objectContaining({ check: "only_in_source" }));
  });
});

describe("compare-snapshots.mjs CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vps-migration-compare-test-"));
  });

  it("exits 0 when snapshots match exactly", () => {
    const sourcePath = path.join(dir, "source.json");
    const targetPath = path.join(dir, "target.json");
    writeFileSync(sourcePath, JSON.stringify(snapshot({ x: { value: 1, policy: "exact" } })));
    writeFileSync(targetPath, JSON.stringify(snapshot({ x: { value: 1, policy: "exact" } })));

    const result = spawnSync(process.execPath, [scriptPath, sourcePath, targetPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits non-zero when an exact check mismatches (e.g. a financial total)", () => {
    const sourcePath = path.join(dir, "source.json");
    const targetPath = path.join(dir, "target.json");
    writeFileSync(sourcePath, JSON.stringify(snapshot({ approved_orders_total: { value: "1000.00", policy: "exact" } })));
    writeFileSync(targetPath, JSON.stringify(snapshot({ approved_orders_total: { value: "900.00", policy: "exact" } })));

    const result = spawnSync(process.execPath, [scriptPath, sourcePath, targetPath], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/approved_orders_total/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with a usage message when file arguments are missing - never connects to anything on its own", () => {
    const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage:/);
  });
});
