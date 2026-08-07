// No shebang here on purpose - this file is only ever invoked as
// `node scripts/vps-migration/compare-snapshots.mjs ...` (see README.md)
// or spawned via `process.execPath` in tests, never executed directly as
// `./compare-snapshots.mjs`. A leading `#!` breaks Vitest 2.1.9's
// sandboxed vm.Context module runner when this file is imported from
// server/vpsMigrationCompareSnapshots.test.ts (SyntaxError: Invalid or
// unexpected token) - see server/vpsMigrationScriptsSafety.test.ts for the
// static safety checks that still cover this file.
// Compares two admin-produced JSON snapshot files (source vs target
// database). Never connects to a database itself - it only reads two files
// already on disk that a human (or preflight tooling run separately) put
// there by hand, per the snapshot shape documented in README.md. There is
// no DROP/TRUNCATE/DELETE/UPDATE/INSERT and no network call anywhere in
// this file.
//
// compareSnapshots() is the pure comparison logic (exported, unit-tested in
// compareSnapshots.vps-migration.test.ts). main() is the thin CLI wrapper
// that reads argv/files and only runs when this file is executed directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Snapshot shape (see README.md for the full spec and an example):
 * {
 *   "label": "source-production-tidb" | any human label,
 *   "takenAt": ISO timestamp string,
 *   "checks": {
 *     "<checkName>": { "value": number | string, "policy": "exact" | "informational" }
 *   },
 *   "migrationTags": ["0000_needy_anthem", ...]
 * }
 *
 * "value" may be a string for large decimal financial sums to avoid any
 * floating-point comparison surprise - compared as normalized decimal
 * strings when both sides are numeric-looking, otherwise as strict string
 * equality.
 */

function normalizeNumericString(value) {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return null;
  // Fixes float noise (e.g. 12.1 - 0.1 artifacts) without pretending
  // sub-cent precision matters for a financial reconciliation check.
  return num.toFixed(6);
}

function valuesEqual(a, b) {
  const normalizedA = normalizeNumericString(a);
  const normalizedB = normalizeNumericString(b);
  if (normalizedA !== null && normalizedB !== null) {
    return normalizedA === normalizedB;
  }
  return String(a) === String(b);
}

/**
 * Compares two snapshots. Returns { ok, mismatches, warnings }.
 * - `mismatches`: checks whose policy is "exact" (or unspecified - see
 *   below) and whose values differ between source and target. Any entry
 *   here means the caller (main(), or a CI step) MUST exit non-zero.
 * - `warnings`: checks whose policy is explicitly "informational" and
 *   differ, plus structural oddities (a check present in one snapshot but
 *   missing from the other, or missing a "policy" field at all - treated
 *   as "exact" for safety, but flagged as a warning too so the snapshot
 *   producer notices and fixes the input rather than silently relying on
 *   the default).
 */
export function compareSnapshots(source, target) {
  const mismatches = [];
  const warnings = [];

  const sourceChecks = source.checks ?? {};
  const targetChecks = target.checks ?? {};
  const allCheckNames = new Set([...Object.keys(sourceChecks), ...Object.keys(targetChecks)]);

  for (const name of allCheckNames) {
    const sourceCheck = sourceChecks[name];
    const targetCheck = targetChecks[name];

    if (!sourceCheck || !targetCheck) {
      mismatches.push({
        check: name,
        reason: "present in only one snapshot",
        source: sourceCheck?.value ?? null,
        target: targetCheck?.value ?? null,
      });
      continue;
    }

    // No explicit policy = treated as "exact" (safer default: an
    // unlabeled check that turns out to matter is caught, not silently
    // waved through). Flagged as a warning regardless of outcome so the
    // snapshot's producer fixes it to be explicit.
    const policy = sourceCheck.policy ?? targetCheck.policy ?? "exact";
    if (!sourceCheck.policy || !targetCheck.policy) {
      warnings.push({ check: name, reason: "missing an explicit policy field, defaulting to 'exact'" });
    }
    if (sourceCheck.policy && targetCheck.policy && sourceCheck.policy !== targetCheck.policy) {
      warnings.push({
        check: name,
        reason: `policy differs between snapshots (source=${sourceCheck.policy}, target=${targetCheck.policy}) - using source's`,
      });
    }

    if (valuesEqual(sourceCheck.value, targetCheck.value)) continue;

    const entry = { check: name, source: sourceCheck.value, target: targetCheck.value };
    if (policy === "exact") {
      mismatches.push(entry);
    } else {
      warnings.push({ ...entry, reason: "informational mismatch - not blocking, but report it" });
    }
  }

  // Migration tag verification - order-independent set comparison. Always
  // treated as exact: a target missing an applied migration (or having an
  // extra one the source never ran) means the schemas have diverged.
  const sourceTags = new Set(source.migrationTags ?? []);
  const targetTags = new Set(target.migrationTags ?? []);
  const missingFromTarget = [...sourceTags].filter((t) => !targetTags.has(t));
  const extraInTarget = [...targetTags].filter((t) => !sourceTags.has(t));
  if (missingFromTarget.length > 0 || extraInTarget.length > 0) {
    mismatches.push({
      check: "migrationTags",
      reason: "migration tag sets differ",
      missingFromTarget,
      extraInTarget,
    });
  }

  return { ok: mismatches.length === 0, mismatches, warnings };
}

function formatResult(result, sourceLabel, targetLabel) {
  const lines = [];
  lines.push(`Comparing "${sourceLabel}" (source) vs "${targetLabel}" (target)`);

  if (result.mismatches.length === 0) {
    lines.push("No exact-match mismatches found.");
  } else {
    lines.push(`${result.mismatches.length} exact-match mismatch(es) - CUTOVER MUST NOT PROCEED:`);
    for (const m of result.mismatches) {
      lines.push(`  - ${m.check}: ${JSON.stringify(m)}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`${result.warnings.length} warning(s) (informational, not blocking):`);
    for (const w of result.warnings) {
      lines.push(`  - ${w.check}: ${w.reason}${"source" in w ? ` (source=${w.source}, target=${w.target})` : ""}`);
    }
  }

  return lines.join("\n");
}

function main() {
  const [sourcePath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath) {
    console.error(
      "Usage: node scripts/vps-migration/compare-snapshots.mjs <source-snapshot.json> <target-snapshot.json>\n" +
        "Both files must already exist - this script never connects to a database itself, " +
        "see scripts/vps-migration/README.md for how to produce them."
    );
    process.exit(1);
  }

  let source, target;
  try {
    source = JSON.parse(readFileSync(path.resolve(sourcePath), "utf8"));
  } catch (error) {
    console.error(`[compare-snapshots] Could not read/parse source snapshot "${sourcePath}": ${error.message}`);
    process.exit(1);
  }
  try {
    target = JSON.parse(readFileSync(path.resolve(targetPath), "utf8"));
  } catch (error) {
    console.error(`[compare-snapshots] Could not read/parse target snapshot "${targetPath}": ${error.message}`);
    process.exit(1);
  }

  const result = compareSnapshots(source, target);
  console.log(formatResult(result, source.label ?? sourcePath, target.label ?? targetPath));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
