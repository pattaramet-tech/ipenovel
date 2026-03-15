/**
 * Production Monitoring Utilities
 * Simple in-memory logging for request tracking, error tracking, and database monitoring
 * These logs can be exported or streamed to external services
 */

// ============ REQUEST LOGGING ============

export interface RequestLog {
  timestamp: string;
  procedure: string;
  userId?: number;
  duration: number;
  status: "success" | "error";
  error?: string;
}

const requestLogs: RequestLog[] = [];
const MAX_REQUEST_LOGS = 5000;

export function logRequest(log: RequestLog) {
  requestLogs.push(log);
  if (requestLogs.length > MAX_REQUEST_LOGS) {
    requestLogs.splice(0, requestLogs.length - MAX_REQUEST_LOGS);
  }
}

export function getRequestLogs(limit = 100): RequestLog[] {
  return requestLogs.slice(-limit);
}

// ============ ERROR TRACKING ============

export interface ErrorLog {
  timestamp: string;
  errorType: string;
  message: string;
  procedure?: string;
  userId?: number;
  severity: "low" | "medium" | "high" | "critical";
}

const errorLogs: ErrorLog[] = [];
const MAX_ERROR_LOGS = 2000;

export function trackError(log: ErrorLog) {
  errorLogs.push(log);
  if (errorLogs.length > MAX_ERROR_LOGS) {
    errorLogs.splice(0, errorLogs.length - MAX_ERROR_LOGS);
  }
  
  // Log critical errors to console
  if (log.severity === "critical") {
    console.error(`[CRITICAL] ${log.errorType}: ${log.message}`);
  }
}

export function getErrorLogs(limit = 100): ErrorLog[] {
  return errorLogs.slice(-limit);
}

export function getCriticalErrors(limit = 50): ErrorLog[] {
  return errorLogs.filter((e) => e.severity === "critical").slice(-limit);
}

// ============ DATABASE MONITORING ============

export interface DatabaseMetrics {
  timestamp: string;
  queryCount: number;
  avgDuration: number;
  slowQueries: number;
  errors: number;
}

const dbMetrics: DatabaseMetrics[] = [];
const MAX_DB_METRICS = 1000;

let queryCount = 0;
let totalDuration = 0;
let slowQueryCount = 0;
let queryErrors = 0;

export function recordQuery(durationMs: number, isError = false) {
  queryCount++;
  totalDuration += durationMs;
  if (durationMs > 1000) slowQueryCount++;
  if (isError) queryErrors++;
}

export function recordDatabaseMetrics() {
  const metrics: DatabaseMetrics = {
    timestamp: new Date().toISOString(),
    queryCount,
    avgDuration: queryCount > 0 ? Math.round(totalDuration / queryCount) : 0,
    slowQueries: slowQueryCount,
    errors: queryErrors,
  };
  
  dbMetrics.push(metrics);
  if (dbMetrics.length > MAX_DB_METRICS) {
    dbMetrics.splice(0, dbMetrics.length - MAX_DB_METRICS);
  }
  
  // Reset counters
  queryCount = 0;
  totalDuration = 0;
  slowQueryCount = 0;
  queryErrors = 0;
}

export function getDatabaseMetrics(limit = 100): DatabaseMetrics[] {
  return dbMetrics.slice(-limit);
}

// ============ MONITORING SUMMARY ============

export function getMonitoringSummary() {
  const recentRequests = requestLogs.slice(-100);
  const recentErrors = errorLogs.slice(-100);
  const recentMetrics = dbMetrics.slice(-10);
  
  const errorCount = recentErrors.length;
  const criticalCount = recentErrors.filter((e) => e.severity === "critical").length;
  const avgRequestDuration =
    recentRequests.length > 0
      ? Math.round(recentRequests.reduce((sum, r) => sum + r.duration, 0) / recentRequests.length)
      : 0;
  
  const latestDbMetrics = recentMetrics[recentMetrics.length - 1];
  
  return {
    requestsLast100: recentRequests.length,
    avgRequestDuration,
    errorsLast100: errorCount,
    criticalErrors: criticalCount,
    latestDbMetrics,
    timestamp: new Date().toISOString(),
  };
}

// ============ START PERIODIC RECORDING ============

export function startMonitoring(intervalSeconds = 60) {
  setInterval(() => {
    recordDatabaseMetrics();
  }, intervalSeconds * 1000);
}
