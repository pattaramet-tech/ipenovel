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
    // Dummy, non-secret private-R2 config so server/_core/env.ts's
    // module-level ENV const (read once, at import time - see comments on
    // OCR_ENABLED elsewhere in this project) resolves isR2PrivateConfigured()
    // to true for the integration project. Every test file that exercises
    // this path mocks @aws-sdk/client-s3 / @aws-sdk/s3-request-presigner
    // itself - no real network call is ever made using these values.
    //
    // OCR_ENABLED: "false" - several integration test files (see
    // server/checkout-after-slip-upload-diagnosis.integration.test.ts,
    // server/couponOwnership.integration.test.ts,
    // server/paymentSlipPrivateR2.integration.test.ts) explicitly assert
    // `process.env.OCR_ENABLED === "false"` as a precondition, so their
    // slip-based checkout paths deterministically fall to manual review
    // instead of depending on a real OCR/LLM call. This is TEST config
    // only, scoped to the integration vitest project - it has no effect on
    // Production or Preview, and this project deliberately never relies on
    // Coolify (or any other external source) to set it for tests to pass.
    env: {
      R2_PRIVATE_ACCOUNT_ID: "test-account",
      R2_PRIVATE_ACCESS_KEY_ID: "test-access-key-id",
      R2_PRIVATE_SECRET_ACCESS_KEY: "test-secret-access-key",
      R2_PRIVATE_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
      R2_PRIVATE_BUCKET_NAME: "test-private-bucket",
      R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "900",
      OCR_ENABLED: "false",
    },
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
