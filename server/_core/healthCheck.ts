/**
 * Health and Readiness Check Endpoints
 * For production monitoring and deployment verification
 */

import { getDb } from "../db";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  checks: {
    database: "ok" | "failed";
    memory: "ok" | "warning" | "critical";
  };
}

export interface ReadinessStatus {
  ready: boolean;
  timestamp: string;
  checks: {
    database: boolean;
    environment: boolean;
  };
  errors: string[];
}

const startTime = Date.now();

/**
 * Get health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const db = await getDb();
  const uptime = Date.now() - startTime;

  let databaseStatus: "ok" | "failed" = "failed";
  try {
    if (db) {
      // Try a simple query to verify database connectivity
      await (db as any).execute("SELECT 1");
      databaseStatus = "ok";
    }
  } catch (error) {
    databaseStatus = "failed";
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  const memoryStatus = heapUsedPercent > 90 ? "critical" : heapUsedPercent > 75 ? "warning" : "ok";

  const status =
    databaseStatus === "failed" || memoryStatus === "critical"
      ? "unhealthy"
      : memoryStatus === "warning"
        ? "degraded"
        : "healthy";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime,
    checks: {
      database: databaseStatus,
      memory: memoryStatus as "ok" | "warning" | "critical",
    },
  };
}

/**
 * Get readiness status
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const errors: string[] = [];
  let databaseReady = false;
  let environmentReady = true;

  // Check database
  try {
    const db = await getDb();
    if (!db) {
      errors.push("Database connection not available");
    } else {
      // Try a simple query
      await (db as any).execute("SELECT 1");
      databaseReady = true;
    }
  } catch (error) {
    errors.push(`Database check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check environment variables
  const requiredEnvVars = [
    "DATABASE_URL",
    "JWT_SECRET",
    "VITE_APP_ID",
    "OAUTH_SERVER_URL",
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      errors.push(`Missing environment variable: ${envVar}`);
      environmentReady = false;
    }
  }

  const ready = databaseReady && environmentReady && errors.length === 0;

  return {
    ready,
    timestamp: new Date().toISOString(),
    checks: {
      database: databaseReady,
      environment: environmentReady,
    },
    errors,
  };
}

/**
 * Log startup information
 */
export function logStartupInfo() {
  const env = process.env.NODE_ENV || "development";
  const nodeVersion = process.version;
  const platform = process.platform;

  console.log("=".repeat(60));
  console.log("Ipenovel V2 - Digital Novel Store");
  console.log("=".repeat(60));
  console.log(`Environment: ${env}`);
  console.log(`Node Version: ${nodeVersion}`);
  console.log(`Platform: ${platform}`);
  console.log(`Startup Time: ${new Date().toISOString()}`);
  console.log("=".repeat(60));
}

/**
 * Log startup warnings for missing optional config
 */
export function logStartupWarnings() {
  const warnings: string[] = [];

  // Check for optional but recommended config
  if (!process.env.SENTRY_DSN) {
    warnings.push("SENTRY_DSN not configured - error tracking disabled");
  }

  if (!process.env.LOG_LEVEL) {
    warnings.push("LOG_LEVEL not configured - using default");
  }

  if (warnings.length > 0) {
    console.warn("Startup Warnings:");
    warnings.forEach((w) => console.warn(`  - ${w}`));
  }
}
