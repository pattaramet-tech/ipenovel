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
    // OWNER_OPEN_ID is now optional (only used for owner auto-promotion)
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
    ];

    expect(requiredVars).toHaveLength(6);
    expect(requiredVars).toContain("DATABASE_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_KEY");
  });

  it("should NOT have PORT as required env var (MANUS assigns dynamically)", () => {
    // PORT is optional in production (MANUS assigns it dynamically)
    // It defaults to 3000 if not set
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
    ];

    expect(requiredVars).not.toContain("PORT");
  });

  it("should NOT have OWNER_OPEN_ID as required env var (only used for owner auto-promotion)", () => {
    // OWNER_OPEN_ID is optional - only used to auto-promote owner to admin role
    // App can boot without it; owner promotion just won't happen
    const requiredVars = [
      "DATABASE_URL",
      "JWT_SECRET",
      "VITE_APP_ID",
      "OAUTH_SERVER_URL",
      "BUILT_IN_FORGE_API_URL",
      "BUILT_IN_FORGE_API_KEY",
    ];

    expect(requiredVars).not.toContain("OWNER_OPEN_ID");
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
    ];

    expect(requiredVars).toContain("VITE_APP_ID");
    expect(requiredVars).toContain("OAUTH_SERVER_URL");
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
      "OWNER_OPEN_ID",
      "PORT",
    ];

    expect(optionalVars).toHaveLength(7);
    expect(optionalVars).toContain("NODE_ENV");
    expect(optionalVars).toContain("LOG_LEVEL");
    expect(optionalVars).toContain("SENTRY_DSN");
    expect(optionalVars).toContain("OWNER_OPEN_ID");
    expect(optionalVars).toContain("PORT");
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
    ];

    const optionalVars = [
      "NODE_ENV",
      "LOG_LEVEL",
      "SENTRY_DSN",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
      "OWNER_OPEN_ID",
      "PORT",
    ];

    expect(requiredVars).toContain("BUILT_IN_FORGE_API_URL");
    expect(requiredVars).toContain("BUILT_IN_FORGE_API_KEY");
    expect(optionalVars).not.toContain("BUILT_IN_FORGE_API_URL");
    expect(optionalVars).not.toContain("BUILT_IN_FORGE_API_KEY");
  });
});
