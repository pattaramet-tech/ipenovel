// Define required and optional environment variables
// Note: PORT is optional in production (MANUS assigns it dynamically)
// Note: OWNER_OPEN_ID is optional - only used for auto-promoting owner to admin role
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'VITE_APP_ID',
  'OAUTH_SERVER_URL',
  'BUILT_IN_FORGE_API_URL',
  'BUILT_IN_FORGE_API_KEY',
] as const;

const OPTIONAL_ENV_VARS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'SENTRY_DSN',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'OWNER_OPEN_ID',
] as const;

/**
 * Validate all required environment variables on startup.
 * Throws an error with a clear message if any required var is missing.
 * This ensures production deployments fail fast with broken config.
 */
export function validateEnvironment(): void {
  const missingVars: string[] = [];

  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar] || process.env[envVar]?.trim() === '') {
      missingVars.push(envVar);
    }
  }

  if (missingVars.length > 0) {
    const errorMessage = [
      'ERROR: Missing or empty required environment variables:',
      ...missingVars.map(v => `  - ${v}`),
      '',
      'Production startup FAILED. Ensure all required env vars are set and non-empty.',
      '',
      'Required environment variables:',
      '  DATABASE_URL - MySQL connection string',
      '  JWT_SECRET - Session cookie signing secret',
      '  VITE_APP_ID - Manus OAuth application ID',
      '  OAUTH_SERVER_URL - Manus OAuth backend base URL',
      '  BUILT_IN_FORGE_API_URL - Manus built-in APIs URL (for storage, LLM, etc)',
      '  BUILT_IN_FORGE_API_KEY - Bearer token for Manus built-in APIs',
      '',
      'Optional environment variables:',
      '  PORT - Server port number (defaults to 3000 if not set)',
      '  OWNER_OPEN_ID - Owner\'s Manus OpenID for auto-promoting owner to admin role',
    ].join('\n');

    console.error(errorMessage);
    process.exit(1);
  }
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  port: parseInt(process.env.PORT ?? "3000", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  sentryDsn: process.env.SENTRY_DSN,
};
