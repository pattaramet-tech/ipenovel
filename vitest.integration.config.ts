import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

// The integration project: real-database tests only. See
// docs/TEST_INFRASTRUCTURE.md for the full design rationale.
//
// fileParallelism: false forces every integration test FILE to run one at a
// time (Vitest 2.1.9 docs: "Setting this to false will override maxWorkers
// and minWorkers options to 1") - files sharing one test database must
// never race each other. sequence.concurrent: false additionally stops
// individual `it()` blocks within a single file from being scheduled
// concurrently (relevant for any file that opts into `describe.concurrent`/
// `it.concurrent` - this project-level default keeps that off even if an
// individual file forgets to).
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
    name: "integration",
    environment: "node",
    include: ["server/**/*.integration.test.ts"],
    globalSetup: ["./vitest.integration.globalsetup.ts"],
    // Runs inside each worker's own module registry, unlike globalSetup -
    // see vitest.integration.setupfile.ts for why both are needed.
    setupFiles: ["./vitest.integration.setupfile.ts"],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    // Integration tests do real network I/O (a live MySQL round trip per
    // query) - the default 5s test timeout is tuned for pure/unit tests.
    // This is a considered, evidence-based increase (real I/O is
    // legitimately slower than in-process assertions), not a blind bump to
    // paper over a hang - see docs/TEST_INFRASTRUCTURE.md PART F for the
    // "don't just raise timeouts" rule this still has to justify itself
    // against.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
