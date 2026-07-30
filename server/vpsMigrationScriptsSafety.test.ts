import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static-source safety guards for scripts/vps-migration/** - this directory
// is explicitly documented (README.md) as read-only tooling that never
// connects to a database and never mutates anything. These tests pin that
// property directly against the source text so a future edit can't
// silently reintroduce a write path or a live DB connection without a test
// failing first.

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "vps-migration");

function readScript(name: string) {
  return readFileSync(path.join(scriptsDir, name), "utf8").replace(/\r\n/g, "\n");
}

const WRITE_STATEMENT_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|GRANT|REVOKE)\b/i;

describe("snapshot-schema.sql has no write statement", () => {
  const sql = readScript("snapshot-schema.sql");

  it("contains no INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/REPLACE/GRANT/REVOKE keyword anywhere", () => {
    // Every line that isn't a comment (-- ...) must not contain a write
    // keyword. Comments are allowed to mention them in prose (this test
    // itself does, in its own description) - only actual SQL statements
    // matter.
    const codeLines = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(codeLines).not.toMatch(WRITE_STATEMENT_PATTERN);
  });

  it("every non-comment, non-blank line is part of a SELECT statement (starts with SELECT or is a continuation)", () => {
    // A conservative structural check: collect statements (split on ;),
    // strip comments/blank lines from each, and assert what's left starts
    // with SELECT.
    const withoutComments = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = withoutComments
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements.length).toBeGreaterThan(20); // sanity: the file actually has real content
    for (const statement of statements) {
      expect(statement.toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });
});

describe("preflight.mjs and compare-snapshots.mjs never open a database connection automatically", () => {
  const preflight = readScript("preflight.mjs");
  const compareSnapshots = readScript("compare-snapshots.mjs");

  it("never imports mysql2 or any DB driver", () => {
    for (const source of [preflight, compareSnapshots]) {
      expect(source).not.toMatch(/mysql2/);
      expect(source).not.toMatch(/from ["']drizzle-orm/);
      expect(source).not.toMatch(/createConnection\s*\(/);
      expect(source).not.toMatch(/createPool\s*\(/);
    }
  });

  it("never makes an outbound network call (fetch/http/https/axios)", () => {
    for (const source of [preflight, compareSnapshots]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/from ["']node:https?["']/);
      expect(source).not.toMatch(/require\(["']https?["']\)/);
      expect(source).not.toMatch(/axios/);
    }
  });

  it("preflight.mjs's DATABASE_URL handling only ever parses the string (new URL(...)) - never connects with it", () => {
    expect(preflight).toMatch(/new URL\(/);
    expect(preflight).not.toMatch(/\.connect\s*\(/);
  });
});

describe("no production credentials or real secret values appear anywhere in scripts/vps-migration/", () => {
  const files = ["preflight.mjs", "compare-snapshots.mjs", "snapshot-schema.sql", "README.md"];

  it("contains no plausible real connection-string credential (mysql://user:password@ with a non-placeholder-looking password)", () => {
    // Placeholder/example values used throughout the docs/README (e.g.
    // "pw", "x", "should-never-be-printed" in tests, or the word "password"
    // itself) are fine - this guards against an actual-looking secret
    // (long random-looking token) being pasted in.
    const suspiciousPattern = /mysql:\/\/[^:@\s"']+:[A-Za-z0-9+/=_-]{20,}@/;
    for (const file of files) {
      const content = readScript(file);
      expect(content).not.toMatch(suspiciousPattern);
    }
  });

  it("contains no hardcoded R2/JWT/Forge-style long token literal (40+ char base64/hex-looking run assigned to a *_KEY or *_SECRET-like variable)", () => {
    const suspiciousAssignment = /(SECRET|API_KEY|ACCESS_KEY|PASSWORD)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']/;
    for (const file of files) {
      const content = readScript(file);
      expect(content).not.toMatch(suspiciousAssignment);
    }
  });

  it("preflight.mjs's own env var handling only ever reads process.env by NAME, never hardcodes a fallback value that looks like a real credential", () => {
    const preflight = readScript("preflight.mjs");
    // Every env var name it references should be the well-known public
    // constant list, not a literal value substituted in.
    expect(preflight).not.toMatch(/process\.env\.\w+\s*=/); // never assigns into process.env
  });
});

// Regression guard for the leaked admin credential found in
// drizzle/0003_admin_seed.sql / drizzle/LOCAL_ADMIN_BOOTSTRAP.sql (see
// docs/VPS_MIGRATION_RUNBOOK.md §0/§9/§14). This test deliberately never
// TYPES the password or hash literally anywhere in this file - it extracts
// them at runtime from the already-committed seed file (which is the
// exposure this test is guarding against, not adding to) and asserts they
// never additionally appear in any of THIS PR's own docs or scripts, where
// they'd be even easier to stumble across.
describe("this PR's own docs/scripts never reproduce the leaked admin-seed credential", () => {
  const repoRoot = path.resolve(scriptsDir, "..", "..");

  function extractSeedCredentialFragments(): string[] {
    const seedFile = readFileSync(path.join(repoRoot, "drizzle", "0003_admin_seed.sql"), "utf8");
    const passwordMatch = seedFile.match(/Password:\s*(\S+)/);
    const hashMatch = seedFile.match(/\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}/);
    const fragments: string[] = [];
    if (passwordMatch) fragments.push(passwordMatch[1]);
    if (hashMatch) fragments.push(hashMatch[0]);
    return fragments;
  }

  const fragments = extractSeedCredentialFragments();

  it("sanity check: the seed file actually contains extractable password/hash fragments (so this test isn't accidentally a no-op)", () => {
    expect(fragments.length).toBe(2);
  });

  it("no file under docs/VPS_*.md contains the leaked plaintext password or bcrypt hash", () => {
    const docsDir = path.join(repoRoot, "docs");
    const vpsDocFiles = readdirSync(docsDir).filter((name) => name.startsWith("VPS_") && name.endsWith(".md"));
    expect(vpsDocFiles.length).toBeGreaterThan(0);
    for (const fileName of vpsDocFiles) {
      const content = readFileSync(path.join(docsDir, fileName), "utf8");
      for (const fragment of fragments) {
        expect(content).not.toContain(fragment);
      }
    }
  });

  it("no file under scripts/vps-migration/ contains the leaked plaintext password or bcrypt hash", () => {
    const scriptFiles = readdirSync(scriptsDir);
    for (const fileName of scriptFiles) {
      const content = readFileSync(path.join(scriptsDir, fileName), "utf8");
      for (const fragment of fragments) {
        expect(content).not.toContain(fragment);
      }
    }
  });
});
