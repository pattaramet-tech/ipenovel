import { describe, expect, it } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import {
  assertProductionStagingDatabaseIsolation,
  PRODUCTION_STAGING_ENVIRONMENT,
} from "./productionStagingSafety";

const stagingUrl =
  "mysql://staging_user:secret@staging-db.internal:3306/ipenovel_staging";
const productionUrl = "mysql://prod_user:secret@prod-db.internal:3306/ipenovel";

function safeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: PRODUCTION_STAGING_ENVIRONMENT,
    DATABASE_URL: stagingUrl,
    PRODUCTION_STAGING_DB_FINGERPRINT: databaseIdentityFingerprint(stagingUrl),
    PRODUCTION_DB_FINGERPRINT: databaseIdentityFingerprint(productionUrl),
    ...overrides,
  };
}

describe("production staging database isolation", () => {
  it("is inert outside production-staging", () => {
    expect(() =>
      assertProductionStagingDatabaseIsolation({
        DEPLOYMENT_ENVIRONMENT: "production",
      })
    ).not.toThrow();
  });

  it("accepts the explicitly approved isolated staging database", () => {
    expect(() =>
      assertProductionStagingDatabaseIsolation(safeEnv())
    ).not.toThrow();
  });

  it("fails closed when staging and Production fingerprints are identical", () => {
    const productionFingerprint = databaseIdentityFingerprint(productionUrl);
    expect(() =>
      assertProductionStagingDatabaseIsolation(
        safeEnv({
          PRODUCTION_STAGING_DB_FINGERPRINT: productionFingerprint,
          PRODUCTION_DB_FINGERPRINT: productionFingerprint,
        })
      )
    ).toThrow(/must differ/);
  });

  it("fails before migrations when DATABASE_URL resolves to Production", () => {
    expect(() =>
      assertProductionStagingDatabaseIsolation(
        safeEnv({
          DATABASE_URL: productionUrl,
        })
      )
    ).toThrow(/Production database identity/);
  });

  it("fails when DATABASE_URL is not the approved staging database", () => {
    expect(() =>
      assertProductionStagingDatabaseIsolation(
        safeEnv({
          DATABASE_URL: "mysql://user:secret@other-db.internal:3306/other",
        })
      )
    ).toThrow(/does not match the approved staging database identity/);
  });

  it("does not include credentials or database URLs in errors", () => {
    let message = "";
    try {
      assertProductionStagingDatabaseIsolation(
        safeEnv({ DATABASE_URL: "not a url with password=hunter2" })
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("staging_user");
    expect(message).not.toContain("prod_user");
    expect(message).not.toContain("mysql://");
  });
});
