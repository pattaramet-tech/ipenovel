/**
 * Request Logging Middleware for tRPC
 * Logs all API requests with structured information for debugging and monitoring
 */

import { nanoid } from "nanoid";

export interface RequestLogEntry {
  requestId: string;
  timestamp: string;
  procedure: string;
  method: string;
  userId?: number;
  status: "success" | "error" | "unauthorized";
  statusCode: number;
  duration: number;
  errorMessage?: string;
  errorCode?: string;
}

const requestLogs: RequestLogEntry[] = [];
const MAX_LOGS = 10000;

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return nanoid(8);
}

/**
 * Log a request
 */
export function logRequest(entry: RequestLogEntry) {
  requestLogs.push(entry);

  // Trim old logs
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.splice(0, requestLogs.length - MAX_LOGS);
  }

  // Log to console based on level
  const level = entry.status === "success" ? "info" : entry.status === "error" ? "error" : "warn";
  const message = `[${entry.requestId}] ${entry.procedure} (${entry.duration}ms) - ${entry.status}`;

  if (level === "error") {
    console.error(message, {
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
    });
  } else if (level === "warn") {
    console.warn(message);
  } else {
    console.log(message);
  }
}

/**
 * Get request logs
 */
export function getRequestLogs(filter?: {
  procedure?: string;
  userId?: number;
  status?: string;
  limit?: number;
}): RequestLogEntry[] {
  let filtered = [...requestLogs];

  if (filter?.procedure) {
    filtered = filtered.filter((l) => l.procedure.includes(filter.procedure!));
  }

  if (filter?.userId) {
    filtered = filtered.filter((l) => l.userId === filter.userId);
  }

  if (filter?.status) {
    filtered = filtered.filter((l) => l.status === filter.status);
  }

  // Return newest first
  filtered.reverse();

  if (filter?.limit) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

/**
 * Get error logs
 */
export function getErrorLogs(limit = 100): RequestLogEntry[] {
  return getRequestLogs({ status: "error", limit });
}

/**
 * Get slow requests (> 1 second)
 */
export function getSlowRequests(thresholdMs = 1000, limit = 50): RequestLogEntry[] {
  const slow = requestLogs.filter((l) => l.duration > thresholdMs);
  slow.reverse();
  return slow.slice(0, limit);
}

/**
 * Get request statistics
 */
export function getRequestStats() {
  const total = requestLogs.length;
  const errors = requestLogs.filter((l) => l.status === "error").length;
  const unauthorized = requestLogs.filter((l) => l.status === "unauthorized").length;
  const slow = requestLogs.filter((l) => l.duration > 1000).length;
  const avgDuration =
    total > 0 ? Math.round(requestLogs.reduce((sum, l) => sum + l.duration, 0) / total) : 0;

  return {
    total,
    errors,
    errorRate: total > 0 ? ((errors / total) * 100).toFixed(2) : "0.00",
    unauthorized,
    slow,
    avgDuration,
  };
}

/**
 * Clear logs (for testing)
 */
export function clearRequestLogs() {
  requestLogs.length = 0;
}

/**
 * Get logs for a specific request ID
 */
export function getRequestTrace(requestId: string): RequestLogEntry[] {
  return requestLogs.filter((l) => l.requestId === requestId);
}
