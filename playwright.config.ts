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
