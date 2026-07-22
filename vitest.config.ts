import { defineConfig, configDefaults } from "vitest/config";
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
    // client/** added for pure client-logic modules (no DOM harness needed):
    // client/src/components/dailyCheckinPresentation.ts and
    // client/src/pages/checkoutOutcome.ts deliberately keep their decision
    // logic outside React so it can be tested directly. This also finally
    // runs client/src/pages/{PaymentPage,PointsPage}.test.ts, which existed
    // but were never picked up by any config - all of them pass.
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "client/**/*.test.ts"],
    // *.integration.test.ts also matches the pattern above (it ends in
    // .test.ts) - excluded explicitly so the unit project (no TEST_DATABASE_URL
    // requirement, no live-DB safety checks) never picks up a file that
    // belongs exclusively to the integration project
    // (vitest.integration.config.ts). Discovered when adding the first-ever
    // integration test file broke `pnpm test:unit` - see
    // docs/TEST_INFRASTRUCTURE.md's "Post-incident redesign" section.
    exclude: [...configDefaults.exclude, "server/**/*.integration.test.ts"],
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
