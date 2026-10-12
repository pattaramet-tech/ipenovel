import { defineConfig, devices } from "@playwright/test";
import {
  adminAuthStatePath,
  assertSafeE2ETarget,
  authStatePath,
  e2eBaseUrl,
  hasAdminAuthState,
  hasAuthState,
} from "./e2e/support/env";

assertSafeE2ETarget();

const sharedUse = {
  ...devices["Desktop Chrome"],
  baseURL: e2eBaseUrl,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  video: "retain-on-failure" as const,
};

export default defineConfig({
  testDir: "./e2e",
  // IPE-069R5L-R4G-R1 Finding 1: the run-wide navbar evidence directory is
  // claimed inside globalSetup — the sanctioned Playwright lifecycle hook
  // that runs EXACTLY once per actual test invocation and never for --list.
  // The claim publishes IPE069_RUN_ID / IPE069_RUN_EVIDENCE_DIR via
  // process.env, which every worker and Playwright retry inherits, so all
  // Guest/User/Admin evidence lands in ONE directory.
  globalSetup: "./e2e/support/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/playwright",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: { baseURL: e2eBaseUrl },
  projects: [
    {
      name: "public",
      grep: /@public/,
      use: sharedUse,
    },
    {
      // IPE-069R5C: authenticated LOCAL fixture tests (disposable seeded
      // sessions on a local dev server). Never runs against remote targets —
      // the spec file additionally guards with its own local-only skip.
      name: "local-fixture",
      grep: /@local-fixture/,
      use: { ...sharedUse, trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "auth",
      grep: /@auth/,
      use: {
        ...sharedUse,
        storageState: hasAuthState ? authStatePath : undefined,
      },
    },
    {
      name: "admin",
      grep: /@admin/,
      use: {
        ...sharedUse,
        storageState: hasAdminAuthState ? adminAuthStatePath : undefined,
      },
    },
    {
      name: "mutation",
      grep: /@mutation/,
      use: {
        ...sharedUse,
        storageState: hasAuthState ? authStatePath : undefined,
      },
    },
  ],
});
