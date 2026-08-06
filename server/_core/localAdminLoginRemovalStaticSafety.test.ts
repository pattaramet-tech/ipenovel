import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static source-text regression guards for the removal of the local
 * (email/password) admin login mechanism - see
 * security/remove-local-admin-password-login. These pin the removal
 * directly against the source tree/text so a future edit (or a bad merge)
 * can't silently reintroduce the removed seed files, route, procedure,
 * synthetic session shape, or a hardcoded credential without a test
 * failing first. Deliberately never types a real credential, password, or
 * hash anywhere in this file - every check here is structural (file
 * existence, a generic bcrypt-hash SHAPE, a generic seed-comment SHAPE),
 * never a comparison against an actual leaked value.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// Directories that are never meant to be scanned for hand-written
// application source: build output, dependencies, VCS internals, sibling
// git worktrees, and .manus/ - Manus's own local tool-generated working
// directory (query-history cache etc.), entirely separate from this
// repository's own tracked application source.
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", ".manus", ".worktrees", "build", ".vite"]);

function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("the two local-admin seed files no longer exist", () => {
  it("drizzle/0003_admin_seed.sql is not present on disk", () => {
    expect(existsSync(path.join(repoRoot, "drizzle", "0003_admin_seed.sql"))).toBe(false);
  });

  it("drizzle/LOCAL_ADMIN_BOOTSTRAP.sql is not present on disk", () => {
    expect(existsSync(path.join(repoRoot, "drizzle", "LOCAL_ADMIN_BOOTSTRAP.sql"))).toBe(false);
  });

  it("neither file is (or ever was) referenced by the migration journal, and must never become one", () => {
    const journal = JSON.parse(readSource("drizzle/meta/_journal.json"));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    expect(tags).not.toContain("0003_admin_seed");
    expect(tags).not.toContain("LOCAL_ADMIN_BOOTSTRAP");
  });

  it("the standalone root-level scripts that seeded/updated the local admin's password are also deleted", () => {
    expect(existsSync(path.join(repoRoot, "seed-admin.mjs"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "update-admin-password.mjs"))).toBe(false);
  });
});

describe("/admin/login route no longer exists", () => {
  it("client/src/App.tsx never routes /admin/login to anything", () => {
    const appSource = readSource("client/src/App.tsx");
    expect(appSource).not.toMatch(/["'`]\/admin\/login["'`]/);
    expect(appSource).not.toMatch(/AdminLoginPage/);
  });

  it("client/src/pages/AdminLoginPage.tsx and its test file are both deleted", () => {
    expect(existsSync(path.join(repoRoot, "client", "src", "pages", "AdminLoginPage.tsx"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "client", "src", "pages", "AdminLoginPage.test.ts"))).toBe(false);
  });

  it("every former /admin/login redirect target in the client now points at the literal /login page instead - checks for an actual quoted string literal, never flagging a mere explanatory comment mentioning the old path by name", () => {
    for (const relFile of [
      "client/src/_core/hooks/unauthorizedRedirect.ts",
      "client/src/_core/hooks/globalUnauthorizedRedirect.ts",
      "client/src/_core/hooks/useAuth.ts",
      "client/src/components/AdminLayout.tsx",
    ]) {
      const source = readSource(relFile);
      expect(source, `${relFile} still has a quoted "/admin/login" string literal`).not.toMatch(/["'`]\/admin\/login["'`]/);
    }
  });
});

describe("admin.login tRPC procedure no longer exists", () => {
  it("server/routers.ts defines no admin.login procedure, never imports bcryptjs, and never mints a synthetic admin-<id> session", () => {
    const routersSource = readSource("server/routers.ts");
    expect(routersSource).not.toMatch(/\blogin\s*:\s*publicProcedure/);
    expect(routersSource).not.toMatch(/bcryptjs/);
    expect(routersSource).not.toMatch(/getAdminByEmail/);
    expect(routersSource).not.toMatch(/`admin-\$\{/);
  });

  it("server/db.ts no longer exports getAdminByEmail", () => {
    const dbSource = readSource("server/db.ts");
    expect(dbSource).not.toMatch(/export\s+(async\s+)?function\s+getAdminByEmail/);
  });

  it("the admin.login-specific test file is deleted", () => {
    expect(existsSync(path.join(repoRoot, "server", "admin.login.databaseUnavailable.test.ts"))).toBe(false);
  });
});

describe("synthetic \"admin-<numeric id>\" session shape is rejected outright, never resolved to a user", () => {
  const sdkSource = readSource("server/_core/sdk.ts");

  it("sdk.ts matches only the exact legacy shape (admin-<digits>) via a precise regex - never a startsWith(\"admin-\") prefix check, which would also swallow an unrelated real openId like \"admin-editor\"", () => {
    expect(sdkSource).toMatch(/\/\^admin-\\d\+\$\/\.test\(session\.openId\)/);
    expect(sdkSource).not.toMatch(/session\.openId\.startsWith\(["']admin-["']\)/);
  });

  it("the recognizing branch throws unconditionally - it never calls getUserById or returns a user for this shape", () => {
    const branchStart = sdkSource.indexOf("if (/^admin-\\d+$/.test(session.openId))");
    expect(branchStart).toBeGreaterThan(-1);
    const branchEnd = sdkSource.indexOf("\n\n", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = sdkSource.slice(branchStart, branchEnd);

    expect(branch).toMatch(/throw new AnonymousCredentialError/);
    expect(branch).not.toMatch(/getUserById/);
    expect(branch).not.toMatch(/\breturn user\b/);
  });
});

describe(".manus/db/ (Manus's own local query/cache history, which was found to contain real connection details) is git-ignored", () => {
  it(".gitignore has a rule covering .manus/db/ - reads only .gitignore itself, never any file under .manus/db/", () => {
    const gitignore = readSource(".gitignore");
    expect(gitignore).toMatch(/^\.manus\/db\/?\s*$/m);
  });

  it("no file under .manus/db/ is tracked by git anymore", () => {
    const result = execFileSync("git", ["ls-files", ".manus/db/**"], { cwd: repoRoot, encoding: "utf8" });
    // Only ever asserts emptiness - never logs/prints the (would-be) file
    // list, so even a future regression here can't leak a filename/path.
    expect(result.trim()).toBe("");
  });
});

describe("no hardcoded local-admin-shaped credential remains anywhere in current source", () => {
  const SCAN_ROOTS = ["client", "server", "drizzle", "scripts", "shared", "docs"];
  const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".sql", ".md", ".json"];
  const THIS_FILE = path.resolve(fileURLToPath(import.meta.url));
  // Excludes this file itself - it necessarily contains the word
  // "bcryptjs" and the pattern names/prose below, as the very thing it
  // checks the REST of the source tree for the absence of.
  const filesToScan = SCAN_ROOTS.flatMap((root) => collectFiles(path.join(repoRoot, root), SCAN_EXTENSIONS)).filter(
    (file) => path.resolve(file) !== THIS_FILE
  );

  it("sanity check: the scan actually covers a real, non-trivial number of files (so the checks below aren't accidentally a no-op)", () => {
    expect(filesToScan.length).toBeGreaterThan(50);
  });

  it("no bcrypt-hash-SHAPED string ($2a$/$2b$/$2y$ + cost + a 53-char salt+hash run) appears anywhere in scanned source - never compared against any real value, just the generic shape", () => {
    const BCRYPT_HASH_PATTERN = /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}/;
    for (const file of filesToScan) {
      const content = readFileSync(file, "utf8");
      expect(content, `unexpected bcrypt-hash-shaped string in ${path.relative(repoRoot, file)}`).not.toMatch(
        BCRYPT_HASH_PATTERN
      );
    }
  });

  it("no SQL file contains a \"-- Password: <value>\" style comment - the exact authoring pattern the deleted seed files used", () => {
    const SEED_STYLE_PASSWORD_COMMENT = /--\s*Password:\s*\S+/i;
    for (const file of filesToScan.filter((f) => f.endsWith(".sql"))) {
      const content = readFileSync(file, "utf8");
      expect(
        content,
        `SQL-comment-style plaintext password found in ${path.relative(repoRoot, file)}`
      ).not.toMatch(SEED_STYLE_PASSWORD_COMMENT);
    }
  });

  it("no .ts/.tsx/.js/.mjs source file imports bcryptjs - its only caller was the removed admin.login procedure", () => {
    for (const file of filesToScan.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
      const content = readFileSync(file, "utf8");
      expect(content, `unexpected bcryptjs reference in ${path.relative(repoRoot, file)}`).not.toMatch(/bcryptjs/);
    }
  });
});
