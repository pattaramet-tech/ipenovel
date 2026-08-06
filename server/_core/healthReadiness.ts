/**
 * Coolify-facing liveness/readiness endpoints. Deliberately unauthenticated
 * (Coolify's health checker has no credentials) and deliberately minimal -
 * neither response body may leak environment, host, commit SHA, database
 * name, or error detail. See registerHealthReadinessRoutes's call site in
 * index.ts for why these must be mounted before the canonical-domain
 * redirect, body parsers, OAuth routes, tRPC, and the SPA static fallback.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

/** Real readiness ping: a live read-only query, not just "did the client construct". */
export async function pingDatabase(): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("[readyz] database connection is not available");
  }
  // `getDb()` returning a client only means `drizzle(...)` didn't throw -
  // mysql2's lazy connection means that succeeds even against an unreachable
  // host. A real query is the only way to know the database can actually be
  // read from right now.
  await (db as any).execute(sql`SELECT 1`);
}

export type DatabasePing = () => Promise<void>;

// Coolify polls /readyz frequently; on a real outage every poll would
// otherwise log at warning level. One line per minute is enough to see the
// outage in logs without flooding them.
const READY_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastReadyFailureLoggedAt = 0;

function logReadyFailureThrottled(error: unknown): void {
  const now = Date.now();
  if (now - lastReadyFailureLoggedAt < READY_FAILURE_LOG_INTERVAL_MS) return;
  lastReadyFailureLoggedAt = now;
  console.warn(`[readyz] database not ready: ${safeErrorSummary(error)}`);
}

/**
 * Registers GET /healthz (process-only liveness, never touches the
 * database) and GET /readyz (real read-only database query). `ping` is
 * injectable so unit tests can exercise both the success and failure paths
 * without a real database connection; production callers should omit it and
 * get the real `pingDatabase`.
 */
export function registerHealthReadinessRoutes(app: Express, ping: DatabasePing = pingDatabase): void {
  app.get("/healthz", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      await ping();
      res.status(200).json({ status: "ready" });
    } catch (error) {
      logReadyFailureThrottled(error);
      res.status(503).json({ status: "not_ready" });
    }
  });
}
