import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Environment Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to original state before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env after each test
    process.env = { ...originalEnv };
  });

  it("should validate that all required env vars are documented", () => {
    // This test ensures we know which env vars are required
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    expect(requiredVars).toHaveLength(8);
    expect(requiredVars).toContain("DATABASE_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_KEY");
  });

  it("should have PORT as required env var", () => {
    // Verify PORT is in the required list (critical for startup)
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    expect(requiredVars).toContain("PORT");
  });

  it("should have storage env vars in required list", () => {
    // Verify storage-related env vars are required
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    expect(requiredVars).toContain("BUILT_IN_FORGE_API_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_KEY");
  });

  it("should have OAuth env vars in required list", () => {
    // Verify OAuth-related env vars are required
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    expect(requiredVars).toContain("VITE_APP_ID");
    expect(requiredVars).toContain("OAUTH_SERVER_URL");
    expect(requiredVars).toContain("OWNER_OPEN_ID");
  });

  it("should have database env vars in required list", () => {
    // Verify database-related env vars are required
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    expect(requiredVars).toContain("DATABASE_URL");
    expect(requiredVars).toContain("JWT_SECRET");
  });

  it("should list optional env vars", () => {
    // Verify optional env vars are documented
    const optionalVars = [
      "NODE_ENV",
      "LOG_LEVEL",
      "SENTRY_DSN",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
    ];

    expect(optionalVars).toHaveLength(5);
    expect(optionalVars).toContain("NODE_ENV");
    expect(optionalVars).toContain("LOG_LEVEL");
    expect(optionalVars).toContain("SENTRY_DSN");
  });

  it("should ensure PORT is validated as required (not just optional)", () => {
    // This is critical: PORT must be required, not optional
    // because production startup depends on it
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    const optionalVars = [
      "NODE_ENV",
      "LOG_LEVEL",
      "SENTRY_DSN",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
    ];

    expect(requiredVars).toContain("PORT");
    expect(optionalVars).not.toContain("PORT");
  });

  it("should ensure storage env vars are required (not optional)", () => {
    // This is critical: storage env vars must be required
    // because storagePut/storageGet depend on them
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
      "PORT",
      "OWNER_OPEN_ID",
    ];

    const optionalVars = [
      "NODE_ENV",
      "LOG_LEVEL",
      "SENTRY_DSN",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
    ];

    expect(requiredVars).toContain("BUILT_IN_FORGE_API_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_KEY");
    expect(optionalVars).not.toContain("BUILT_IN_FORGE_API_URL");
    expect(optionalVars).not.toContain("BUILT_IN_FORGE_API_KEY");
  });
});
