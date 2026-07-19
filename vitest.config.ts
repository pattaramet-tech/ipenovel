import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    name: "unit",
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    // Blocks any test run (including this default project, which many
    // pre-existing test files still connect to a database through
    // DATABASE_URL for) from ever proceeding against a production-looking
    // DATABASE_URL. See vitest.setup.database-safety.ts and
    // docs/TEST_INFRASTRUCTURE.md PART B.
    globalSetup: ["./vitest.setup.database-safety.ts"],
    // This project is a mix of pure-logic tests (parallel-safe) and
    // ~80 not-yet-migrated legacy files that read/write a real database
    // through DATABASE_URL with no isolation of their own (see
    // docs/TEST_INFRASTRUCTURE.md's file-by-file audit) - Vitest's default
    // parallel file execution means two of those files can run against the
    // same shared database at the same time, which is a directly-evidenced
    // cause of this suite's historical flakiness (e.g.
    // novels-browse-pagination.test.ts reading ambient row counts while
    // another file concurrently inserts/deletes rows). Serializing file
    // execution here is a conservative, blast-radius-limiting fix - it
    // costs wall-clock time when a real DATABASE_URL is configured, but
    // costs nothing when it isn't (this sandbox's usual case). The correct
    // long-term fix is finishing the migration of DB-touching files to the
    // dedicated integration project (vitest.integration.config.ts), which
    // has proper per-file isolation - see the test-debt plan in
    // docs/TEST_INFRASTRUCTURE.md. Revisit this once that migration is done.
    fileParallelism: false,
  },
});
