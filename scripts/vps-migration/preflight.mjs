#!/usr/bin/env node
// Read-only VPS migration preflight check.
//
// Never connects to any database, never makes a network call, never writes
// anything anywhere. It only: parses env var NAMES/shapes it's given,
// reports presence/absence, and stats files already on disk. There is no
// DROP/TRUNCATE/DELETE/UPDATE/INSERT, no migration execution, and no
// production mutation possible from this file - see README.md in this
// directory for the intended usage and the explicit --ack-read-only gate
// below.
//
// Every exported function here is pure / dependency-injected (takes env,
// fs-like readers, etc. as arguments) specifically so it's unit-testable
// without touching a real filesystem or process.env - see
// preflight.vps-migration.test.ts. main() is the only part that reaches for
// the real process.env/fs, and only runs when this file is executed
// directly (`node scripts/vps-migration/preflight.mjs --ack-read-only`),
// never on import.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET", "VITE_APP_ID", "OAUTH_SERVER_URL"];

// Grouped so presence can be reported per-feature ("R2 public: configured")
// instead of var-by-var, without ever printing a value.
const OPTIONAL_ENV_GROUPS = {
  "R2 (public bucket)": ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL", "R2_ENDPOINT"],
  "R2 (private bucket)": ["R2_PRIVATE_ACCOUNT_ID", "R2_PRIVATE_ACCESS_KEY_ID", "R2_PRIVATE_SECRET_ACCESS_KEY", "R2_PRIVATE_ENDPOINT", "R2_PRIVATE_BUCKET_NAME"],
  "OAuth portal (client)": ["VITE_OAUTH_PORTAL_URL"],
  "Forge/OCR platform": ["BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"],
  "Discord OCR review webhook": ["DISCORD_OCR_REVIEW_WEBHOOK_URL"],
};

/**
 * Parses DATABASE_URL into its non-secret parts. Never returns the
 * password. Throws (with a message that itself never echoes the input
 * string) if the value isn't a parseable URL at all.
 */
export function describeDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    return { present: false };
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { present: true, parses: false };
  }
  return {
    present: true,
    parses: true,
    protocol: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    port: parsed.port || "(default)",
    database: parsed.pathname.replace(/^\//, "") || "(none)",
    hasUsername: parsed.username.length > 0,
    hasPassword: parsed.password.length > 0,
  };
}

/** Reports which of the hard-required env vars (per docs/VPS_ENVIRONMENT_INVENTORY.md) are missing - names only, never values. */
export function checkRequiredEnvVars(env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]);
  const present = REQUIRED_ENV_VARS.filter((name) => Boolean(env[name]));
  return { missing, present };
}

/** For each optional feature group, reports "configured" only if EVERY var in that group is set - a partially-configured group is flagged, never silently treated as ready. */
export function checkOptionalGroups(env) {
  return Object.entries(OPTIONAL_ENV_GROUPS).map(([groupName, varNames]) => {
    const setVars = varNames.filter((name) => Boolean(env[name]));
    return {
      group: groupName,
      configured: setVars.length === varNames.length,
      partiallyConfigured: setVars.length > 0 && setVars.length < varNames.length,
      missing: varNames.filter((name) => !env[name]),
    };
  });
}

/** Reports the running Node version and the pnpm version pinned in package.json's packageManager field - comparison only, never installs/switches anything. */
export function checkVersions(nodeVersion, packageJson) {
  const packageManager = packageJson.packageManager ?? null;
  const pinnedPnpm = packageManager?.startsWith("pnpm@")
    ? packageManager.slice("pnpm@".length).split("+")[0]
    : null;
  return { nodeVersion, pinnedPnpm };
}

/** Reports whether the expected build outputs exist, without reading their contents. */
export function checkBuildArtifacts(existsFn, distDir) {
  return {
    serverBundle: existsFn(path.join(distDir, "index.js")),
    clientIndex: existsFn(path.join(distDir, "public", "index.html")),
  };
}

/**
 * Cross-checks the migration SQL files actually on disk against the
 * migration journal's tracked tags. On this repo, two orphan files are
 * EXPECTED and already classified (not an open question) in
 * docs/VPS_MIGRATION_RUNBOOK.md's Database Compatibility Audit:
 * drizzle/0023_gifted_juggernaut.sql (legacy orphan; its schema is fully,
 * idempotently repaired by journal-tracked drizzle/0028_repair_episode_reader_schema.sql
 * - not a fresh-MariaDB blocker) and drizzle/0003_admin_seed.sql (an orphan
 * SEED file, not a schema migration - see the Runbook's Critical Security
 * Finding: it and drizzle/LOCAL_ADMIN_BOOTSTRAP.sql contain a hardcoded
 * admin credential that must be rotated, never re-added to the journal).
 * This function still reports every discrepancy it finds (it doesn't
 * special-case those two names) - a NEW, unexpected discrepancy is what
 * this check exists to catch. Never prints file contents, only file/tag
 * names, so it can never leak the credential from 0003_admin_seed.sql.
 */
export function checkMigrationJournalConsistency(sqlFileNames, journalEntries) {
  const journalTags = new Set(journalEntries.map((entry) => entry.tag));
  const sqlTags = sqlFileNames
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""));

  const filesNotInJournal = sqlTags.filter((tag) => !journalTags.has(tag));
  const journalTagsWithNoFile = [...journalTags].filter((tag) => !sqlTags.includes(tag));

  return {
    journalEntryCount: journalEntries.length,
    sqlFileCount: sqlTags.length,
    filesNotInJournal,
    journalTagsWithNoFile,
    consistent: filesNotInJournal.length === 0 && journalTagsWithNoFile.length === 0,
  };
}

function formatReport(sections) {
  const lines = [];
  for (const section of sections) {
    lines.push(`\n== ${section.title} ==`);
    for (const line of section.lines) lines.push(line);
  }
  return lines.join("\n");
}

function buildReport({ env, nodeVersion, packageJson, distExists, drizzleDir, drizzleFiles, journalEntries }) {
  const sections = [];

  const required = checkRequiredEnvVars(env);
  sections.push({
    title: "Required environment variables (names only)",
    lines: [
      `present: ${required.present.join(", ") || "(none)"}`,
      `MISSING: ${required.missing.join(", ") || "(none)"}`,
    ],
  });

  const dbInfo = describeDatabaseUrl(env.DATABASE_URL);
  sections.push({
    title: "DATABASE_URL (password never shown)",
    lines: dbInfo.present
      ? dbInfo.parses
        ? [
            `parses: yes`,
            `protocol: ${dbInfo.protocol}`,
            `host: ${dbInfo.host}`,
            `port: ${dbInfo.port}`,
            `database: ${dbInfo.database}`,
            `username set: ${dbInfo.hasUsername}`,
            `password set: ${dbInfo.hasPassword}`,
          ]
        : [`parses: NO - DATABASE_URL is set but is not a valid URL`]
      : [`DATABASE_URL is not set`],
  });

  const groups = checkOptionalGroups(env);
  sections.push({
    title: "Optional feature configuration (configured / not configured only)",
    lines: groups.map((g) => {
      if (g.configured) return `${g.group}: configured`;
      if (g.partiallyConfigured) return `${g.group}: PARTIALLY configured (missing: ${g.missing.join(", ")})`;
      return `${g.group}: not configured`;
    }),
  });

  const versions = checkVersions(nodeVersion, packageJson);
  sections.push({
    title: "Node / pnpm versions",
    lines: [
      `node: ${versions.nodeVersion}`,
      `pnpm pinned in package.json: ${versions.pinnedPnpm ?? "(not pinned)"}`,
    ],
  });

  sections.push({
    title: "Build artifacts",
    lines: [
      `dist/index.js: ${distExists.serverBundle ? "present" : "MISSING"}`,
      `dist/public/index.html: ${distExists.clientIndex ? "present" : "MISSING"}`,
    ],
  });

  const journalCheck = checkMigrationJournalConsistency(drizzleFiles, journalEntries);
  // The only orphan files this repo is known/expected to have - see
  // docs/VPS_MIGRATION_RUNBOOK.md's dedicated classification for each. Used
  // below purely to make the report's wording accurate (expected vs. a
  // genuinely new, uninvestigated discrepancy) - never changes the
  // underlying pure check's result. LOCAL_ADMIN_BOOTSTRAP is not numbered
  // like a migration (never meant to be journal-tracked at all - its own
  // header says "LOCAL/DEV-ONLY") but duplicates the same leaked credential
  // as 0003_admin_seed and is classified alongside it in the Runbook.
  const KNOWN_CLASSIFIED_ORPHANS = new Set(["0023_gifted_juggernaut", "0003_admin_seed", "LOCAL_ADMIN_BOOTSTRAP"]);
  const unexpectedOrphans = journalCheck.filesNotInJournal.filter((tag) => !KNOWN_CLASSIFIED_ORPHANS.has(tag));
  let consistencyLine;
  if (journalCheck.consistent) {
    consistencyLine = "consistent: yes";
  } else if (unexpectedOrphans.length === 0 && journalCheck.journalTagsWithNoFile.length === 0) {
    consistencyLine =
      "consistent: NO, but exactly matches the known/classified orphan files - see docs/VPS_MIGRATION_RUNBOOK.md §9 (0023_gifted_juggernaut.sql: legacy orphan, repaired by 0028, not a blocker; 0003_admin_seed.sql and LOCAL_ADMIN_BOOTSTRAP.sql: CRITICAL SECURITY FINDING, see Runbook §0/§9/§14 for required operator action). This is expected, not a new issue.";
  } else {
    consistencyLine =
      `consistent: NO - includes UNEXPECTED discrepancies beyond the known/classified orphans: ` +
      `${unexpectedOrphans.join(", ") || "(none)"}${journalCheck.journalTagsWithNoFile.length > 0 ? `, journal tags with no file: ${journalCheck.journalTagsWithNoFile.join(", ")}` : ""}. ` +
      `Investigate before trusting a fresh MariaDB migration run.`;
  }
  sections.push({
    title: `Migration files vs journal (${drizzleDir})`,
    lines: [
      `journal entries: ${journalCheck.journalEntryCount}`,
      `.sql files on disk: ${journalCheck.sqlFileCount}`,
      `files not tracked by journal: ${journalCheck.filesNotInJournal.join(", ") || "(none)"}`,
      `journal tags with no matching file: ${journalCheck.journalTagsWithNoFile.join(", ") || "(none)"}`,
      consistencyLine,
    ],
  });

  const anyMissing = required.missing.length > 0;
  return { report: formatReport(sections), hasBlockingIssue: anyMissing };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--ack-read-only")) {
    console.error(
      "[preflight] Refusing to run without --ack-read-only. This script never writes to " +
        "anything, but requires this explicit flag so it's never invoked by accident as " +
        "part of an automated pipeline without a human having read what it does. " +
        "See scripts/vps-migration/README.md."
    );
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const drizzleDir = path.join(repoRoot, "drizzle");
  const distDir = path.join(repoRoot, "dist");

  let packageJson = {};
  try {
    packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    console.warn("[preflight] Could not read package.json:", error.message);
  }

  let drizzleFiles = [];
  let journalEntries = [];
  try {
    drizzleFiles = readdirSync(drizzleDir);
    const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
    journalEntries = journal.entries ?? [];
  } catch (error) {
    console.warn("[preflight] Could not read drizzle/ migration files or journal:", error.message);
  }

  const { report, hasBlockingIssue } = buildReport({
    env: process.env,
    nodeVersion: process.version,
    packageJson,
    distExists: checkBuildArtifacts(existsSync, distDir),
    drizzleDir: path.relative(repoRoot, drizzleDir),
    drizzleFiles,
    journalEntries,
  });

  console.log(report);
  console.log(
    `\n[preflight] ${hasBlockingIssue ? "FAILED - required environment variables are missing." : "OK - no blocking issue found by this read-only check. This is not a substitute for the manual checklist in docs/VPS_MIGRATION_CHECKLIST.md."}`
  );
  process.exitCode = hasBlockingIssue ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
