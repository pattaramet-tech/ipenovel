import {
  databaseIdentityFingerprint,
  normalizeDatabaseIdentityFingerprint,
} from "../../scripts/lib/databaseIdentity.mjs";

export const PRODUCTION_STAGING_ENVIRONMENT = "production-staging";

export interface ProductionStagingSafetyEnv {
  DEPLOYMENT_ENVIRONMENT?: string;
  DATABASE_URL?: string;
  PRODUCTION_STAGING_DB_FINGERPRINT?: string;
  PRODUCTION_DB_FINGERPRINT?: string;
}

export function assertProductionStagingDatabaseIsolation(
  env: ProductionStagingSafetyEnv = process.env
): void {
  const environment = env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  if (environment !== PRODUCTION_STAGING_ENVIRONMENT) return;

  if (!env.DATABASE_URL?.trim()) {
    throw new Error(
      "[staging-safety] DATABASE_URL is required for production-staging."
    );
  }

  const expectedStaging = normalizeDatabaseIdentityFingerprint(
    env.PRODUCTION_STAGING_DB_FINGERPRINT
  );
  const production = normalizeDatabaseIdentityFingerprint(
    env.PRODUCTION_DB_FINGERPRINT
  );

  if (!expectedStaging) {
    throw new Error(
      "[staging-safety] PRODUCTION_STAGING_DB_FINGERPRINT is missing or invalid."
    );
  }
  if (!production) {
    throw new Error(
      "[staging-safety] PRODUCTION_DB_FINGERPRINT is missing or invalid."
    );
  }
  if (expectedStaging === production) {
    throw new Error(
      "[staging-safety] staging and Production database fingerprints must differ."
    );
  }

  let actual: string;
  try {
    actual = databaseIdentityFingerprint(env.DATABASE_URL);
  } catch {
    throw new Error(
      "[staging-safety] could not derive a safe database identity from DATABASE_URL."
    );
  }

  if (actual === production) {
    throw new Error(
      "[staging-safety] DATABASE_URL resolves to the Production database identity; refusing startup before migrations."
    );
  }
  if (actual !== expectedStaging) {
    throw new Error(
      "[staging-safety] DATABASE_URL does not match the approved staging database identity; refusing startup before migrations."
    );
  }

  console.log(
    "[staging-safety] Isolated production-staging database identity verified before migrations."
  );
}
