import { defineConfig } from "vitest/config";
import path from "node:path";

/** Isolated release gate only: intentionally no app/global integration setup,
 * .env loader, ordinary integration tests, production fixtures or migrations. */
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  test: {
    name: "isolated-legacy-slip-repair",
    environment: "node",
    include: [
      "server/legacySlipRepairMariaDb.integration.test.ts",
      "server/legacySlipRepairLinux.integration.test.ts",
    ],
    globalSetup: [],
    setupFiles: [],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    clearMocks: true,
  },
});
