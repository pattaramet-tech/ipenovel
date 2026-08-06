/**
 * Coolify-facing liveness/readiness endpoints. Deliberately unauthenticated
 * (Coolify's health checker has no credentials) and deliberately minimal -
 * neither response body may leak environment, host, commit SHA, database
 * name, or error detail. See registerHealthReadinessRoutes's call site in
 * index.ts for why these must be mounted before the canonical-domain
 * redirect, body parsers, OAuth routes, tRPC, and the SPA static fallback.
 */
import type { Express, Request, Response } from "express";
import type { Pool as CallbackMySql2Pool, PoolConnection, QueryError } from "mysql2";
import { getDb } from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

// Bounds the actual mysql2 operation, not just our own wrapper promise -
// see pingDatabase()'s docstring for why a client-side race alone isn't
// enough. Must stay below READYZ_PING_TIMEOUT_MS so the database itself
// gives up and settles before the HTTP layer's own bound would otherwise
// have to step in.
export const DB_PING_TIMEOUT_MS = 2500;

/**
 * Real readiness ping: a live read-only query, not just "did the client
 * construct" - and, critically, one that is guaranteed to settle on its
 * own within DB_PING_TIMEOUT_MS, on a connection this function fully owns
 * and cleans up itself.
 *
 * This deliberately bypasses Drizzle's `db.execute(sql\`...\`)` (no
 * per-query timeout parameter) and goes through Drizzle's own documented
 * `$client` field (see MySql2Database & { $client } in
 * drizzle-orm/mysql2/driver.d.ts) to reach the underlying mysql2 driver
 * instance directly - `drizzle(DATABASE_URL)` always constructs this via
 * mysql2's own `createPool()` (see drizzle-orm/mysql2/driver.js), so
 * `$client` is a real, callback-style mysql2 `Pool`, confirmed against the
 * mysql2@3.22.5 / drizzle-orm@0.44.7 versions this repo has installed.
 *
 * mysql2's per-query `timeout` option (every operation accepts one) is an
 * inactivity timeout enforced by the client itself, not the MySQL
 * protocol - but per mysql2's own source
 * (mysql2/lib/commands/query.js's `_handleTimeoutError`), firing it only
 * clears mysql2's own internal timer and invokes the callback with a
 * `PROTOCOL_SEQUENCE_TIMEOUT` error; it does *not* destroy the connection
 * or remove it from the pool. Calling `Pool#query()` directly and trusting
 * the timeout alone would let a connection whose server-side query may
 * still be running go straight back into the pool and be handed to the
 * next caller.
 *
 * So this function acquires its own dedicated `PoolConnection` via
 * `pool.getConnection()` (public API - mysql2/typings/mysql/lib/Pool.d.ts)
 * and owns its entire lifecycle by hand:
 *   - success -> `connection.release()` (return it to the pool - safe,
 *     since the query actually completed)
 *   - timeout, any other query/network error, or a synchronous throw from
 *     `connection.query()` -> `connection.destroy()` (public API -
 *     mysql2/typings/mysql/lib/Connection.d.ts, and confirmed against
 *     mysql2/lib/pool_connection.js's runtime `destroy()` to actually
 *     remove the connection from the pool's tracking, not just close the
 *     socket) - never released, so a connection whose state is unknown
 *     (query still in flight server-side, response arrived but not read,
 *     etc.) can never be handed to a later caller.
 *   - `getConnection()` itself failing -> reject directly; there is no
 *     connection to query, release, or destroy.
 * A single `settled` guard makes resolve/reject and the release-or-destroy
 * choice happen exactly once, so a callback that fires twice or arrives
 * late after the timeout already settled this promise can never run
 * cleanup twice or both release *and* destroy the same connection.
 */
export async function pingDatabase(): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("[readyz] database connection is not available");
  }
  const pool = (db as any).$client as CallbackMySql2Pool;

  const connection = await new Promise<PoolConnection>((resolve, reject) => {
    pool.getConnection((err, conn) => {
      if (err) reject(err);
      else resolve(conn);
    });
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    function settleOnce(outcome: () => void, destroyConnection: boolean): void {
      if (settled) return;
      settled = true;
      // Success releases the connection back to the pool; every other
      // outcome destroys it rather than risk returning a connection whose
      // state is no longer known-good.
      if (destroyConnection) connection.destroy();
      else connection.release();
      outcome();
    }

    try {
      connection.query({ sql: "SELECT 1", timeout: DB_PING_TIMEOUT_MS }, (err: QueryError | null) => {
        if (err) settleOnce(() => reject(err), true);
        else settleOnce(resolve, false);
      });
    } catch (err) {
      // A synchronous throw from connection.query() itself, rather than an
      // async callback error - the connection's state is equally unknown.
      settleOnce(() => reject(err), true);
    }
  });
}

export type DatabasePing = () => Promise<void>;

// Bounds how long a single /readyz request waits on the database before
// answering. Without this, a stuck connection or network partition means
// the request (and every one of Coolify's re-probes piling up behind it)
// hangs indefinitely instead of failing fast. Exported only so the test
// file can inject a much smaller value - production always uses this
// default.
export const READYZ_PING_TIMEOUT_MS = 3000;

const READYZ_TIMED_OUT = Symbol("readyz-ping-timed-out");

/**
 * Registers GET /healthz (process-only liveness, never touches the
 * database) and GET /readyz (a real, time-bounded read-only database
 * query). `ping` and `timeoutMs` are both injectable so unit tests can
 * exercise success, failure, and timeout paths deterministically and
 * without a real database connection; production callers should omit both
 * and get the real `pingDatabase` bounded by `READYZ_PING_TIMEOUT_MS`.
 *
 * The in-flight ping promise and the log-throttle timestamp both live in
 * this function's own closure (not module scope) so that two separate
 * calls to registerHealthReadinessRoutes - e.g. two independent test app
 * instances in the same process - never share state with each other.
 */
export function registerHealthReadinessRoutes(
  app: Express,
  ping: DatabasePing = pingDatabase,
  timeoutMs: number = READYZ_PING_TIMEOUT_MS
): void {
  app.get("/healthz", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ status: "ok" });
  });

  // Coolify polls /readyz frequently; on a real outage every poll would
  // otherwise log at warning level. One line per minute is enough to see
  // the outage in logs without flooding them.
  const READY_FAILURE_LOG_INTERVAL_MS = 60_000;
  let lastReadyFailureLoggedAt = 0;

  function logReadyFailureThrottled(error: unknown): void {
    const now = Date.now();
    if (now - lastReadyFailureLoggedAt < READY_FAILURE_LOG_INTERVAL_MS) return;
    lastReadyFailureLoggedAt = now;
    console.warn(`[readyz] database not ready: ${safeErrorSummary(error)}`);
  }

  // The single outstanding database ping, shared across every
  // concurrently-arriving /readyz request - never more than one real ping
  // runs at a time. Cleared only once the underlying ping itself resolves
  // or rejects, independent of any individual request's own timeout, so a
  // request that times out waiting on it does *not* cause a second ping to
  // be started while the first is still outstanding.
  let inFlightPing: Promise<void> | null = null;

  function getOrStartPing(): Promise<void> {
    if (!inFlightPing) {
      // Wrapping in Promise.resolve().then(...) also converts a
      // synchronous throw from ping() into an ordinary rejection, so every
      // failure mode (reject, throw, hang) is handled identically below.
      inFlightPing = Promise.resolve()
        .then(() => ping())
        .finally(() => {
          inFlightPing = null;
        });
    }
    return inFlightPing;
  }

  app.get("/readyz", async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");

    const pingPromise = getOrStartPing();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof READYZ_TIMED_OUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(READYZ_TIMED_OUT), timeoutMs);
    });

    try {
      const outcome = await Promise.race([pingPromise.then(() => "ready" as const), timeoutPromise]);
      if (outcome === READYZ_TIMED_OUT) {
        logReadyFailureThrottled(new Error("[readyz] database ping timed out"));
        res.status(503).json({ status: "not_ready" });
        return;
      }
      res.status(200).json({ status: "ready" });
    } catch (error) {
      logReadyFailureThrottled(error);
      res.status(503).json({ status: "not_ready" });
    } finally {
      // Always clear the per-request timer, whichever side of the race
      // won - otherwise a fast ping leaves a dangling timeoutMs timer.
      clearTimeout(timeoutHandle);
    }
  });
}
