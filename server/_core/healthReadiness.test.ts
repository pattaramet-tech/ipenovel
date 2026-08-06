import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerHealthReadinessRoutes,
  pingDatabase,
  DB_PING_TIMEOUT_MS,
  type DatabasePing,
} from "./healthReadiness";
import { __setDbForTests } from "../db";

/**
 * Builds an app that mirrors the real registration order in
 * server/_core/index.ts closely enough to prove the ordering guarantee:
 * /healthz and /readyz registered first, then a stand-in canonical-domain
 * redirect (redirects everything) and a stand-in SPA fallback (200s
 * everything) registered after - exactly like the real
 * canonicalDomainRedirect/serveStatic that come later in index.ts.
 */
async function startTestServer(
  ping?: DatabasePing,
  timeoutMs?: number
): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.set("trust proxy", 1);
  registerHealthReadinessRoutes(app, ping, timeoutMs);
  app.use((req, res) => {
    res.redirect(301, "https://canonical.example.test" + req.originalUrl);
  });
  app.use((_req, res) => {
    res.status(200).type("html").send("<html>spa-fallback</html>");
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("registerHealthReadinessRoutes", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  it("GET /healthz responds 200 with a fixed body", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /healthz never calls the database ping function", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    await fetch(`${started.baseUrl}/healthz`);

    expect(ping).not.toHaveBeenCalled();
  });

  it("GET /readyz responds 200 when the database ping succeeds", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("GET /readyz responds 503 when the database ping fails", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("boom"));
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready" });
  });

  it("never leaks the raw ping error, connection string, or credentials in the /readyz response", async () => {
    const ping = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED mysql://dbuser:hunter2@db.internal.example:3306/prod"));
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);
    const bodyText = await res.text();

    expect(res.status).toBe(503);
    expect(bodyText).toBe(JSON.stringify({ status: "not_ready" }));
    expect(bodyText).not.toContain("mysql://");
    expect(bodyText).not.toContain("hunter2");
    expect(bodyText).not.toContain("dbuser");
    expect(bodyText).not.toContain("ECONNREFUSED");
  });

  it("sets Cache-Control: no-store on /healthz", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/healthz`);

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets Cache-Control: no-store on /readyz, including on a 503", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const started = await startTestServer(ping);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("/healthz and /readyz are answered directly, never redirected or caught by the SPA fallback registered after them", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    const health = await fetch(`${started.baseUrl}/healthz`, { redirect: "manual" });
    const healthBody = await health.json();
    const ready = await fetch(`${started.baseUrl}/readyz`, { redirect: "manual" });
    const readyBody = await ready.json();
    // Sanity check: the stand-in redirect middleware really does catch an
    // unrelated route, proving /healthz and /readyz are exempt only because
    // of registration order, not because the stand-in middleware is inert.
    const other = await fetch(`${started.baseUrl}/some-other-path`, { redirect: "manual" });

    expect(health.status).toBe(200);
    expect(healthBody).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(readyBody).toEqual({ status: "ready" });
    expect(other.status).toBe(301);
  });
});

// These use a small injected timeoutMs (registerHealthReadinessRoutes's
// third, test-only parameter) instead of fake timers: the route handler's
// own bound is real, the injected ping is a real never-settling Promise,
// and the request travels over a real socket, so a tiny real timeout is a
// simpler, more deterministic way to prove the bound fires than trying to
// intermix fake timers with real HTTP I/O. It is always orders of
// magnitude below the real 3s production default, so no test here ever
// waits anywhere near 3 real seconds.
describe("registerHealthReadinessRoutes - readiness timeout and ping de-duplication", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    vi.restoreAllMocks();
  });

  it("/readyz responds 503 within the configured timeout when the injected ping never resolves or rejects", async () => {
    const ping = vi.fn(() => new Promise<void>(() => {}));
    const TIMEOUT_MS = 30;
    const started = await startTestServer(ping, TIMEOUT_MS);
    server = started.server;

    const startedAt = Date.now();
    const res = await fetch(`${started.baseUrl}/readyz`);
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "not_ready" });
    // Generous upper bound to absorb real scheduling slack - just proves
    // the request answered promptly instead of hanging indefinitely.
    expect(elapsedMs).toBeLessThan(TIMEOUT_MS + 2000);
  });

  it("timeout response sets Cache-Control: no-store and never leaks timeout or error detail", async () => {
    const ping = vi.fn(() => new Promise<void>(() => {}));
    const started = await startTestServer(ping, 30);
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);
    const bodyText = await res.text();

    expect(res.status).toBe(503);
    expect(bodyText).toBe(JSON.stringify({ status: "not_ready" }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("concurrent /readyz requests while a ping is pending call the injected ping only once", async () => {
    let resolvePing!: () => void;
    const pendingPing = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    const ping = vi.fn(() => pendingPing);
    const started = await startTestServer(ping);
    server = started.server;

    const requests = [
      fetch(`${started.baseUrl}/readyz`),
      fetch(`${started.baseUrl}/readyz`),
      fetch(`${started.baseUrl}/readyz`),
    ];

    // Give all three requests a moment to actually reach the handler and
    // call into the shared in-flight ping before it resolves - a short
    // real wait used purely for request synchronization, not a timing
    // assertion, and nowhere near the 3s production timeout.
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePing();

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ready" });
    }
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("starts a new ping only after the previous one has resolved", async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const started = await startTestServer(ping);
    server = started.server;

    await fetch(`${started.baseUrl}/readyz`);
    await fetch(`${started.baseUrl}/readyz`);

    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("starts a new ping only after the previous one has rejected", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const started = await startTestServer(ping);
    server = started.server;

    await fetch(`${started.baseUrl}/readyz`);
    await fetch(`${started.baseUrl}/readyz`);

    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("logs a sanitized summary via safeErrorSummary - never the raw connection URL, username, password, or host", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ping = vi
      .fn()
      .mockRejectedValue(
        new Error("connect ETIMEDOUT mysql://readyzuser:sup3rSecret@readyz-db.internal.example:3306/prod")
      );
    const started = await startTestServer(ping);
    server = started.server;

    await fetch(`${started.baseUrl}/readyz`);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls[0].join(" ");
    expect(loggedText).not.toContain("mysql://");
    expect(loggedText).not.toContain("sup3rSecret");
    expect(loggedText).not.toContain("readyzuser");
    expect(loggedText).not.toContain("readyz-db.internal.example");
  });
});

// pingDatabase is the real, non-injected implementation used in production.
// It goes through Drizzle's documented `$client` field to reach the
// underlying mysql2 Pool directly, acquires its own dedicated
// PoolConnection via `pool.getConnection()`, and owns that connection's
// entire release-or-destroy lifecycle by hand - see pingDatabase's own
// docstring in healthReadiness.ts for why (mysql2's per-query `timeout`
// option does not destroy the connection on its own; only clears its own
// timer and reports the error). These mock a bare { getConnection } Pool
// and a { query, release, destroy } connection standing in for the real
// mysql2 objects, via the same __setDbForTests test hook server/db.ts
// already exposes for this purpose (see server/db.rawErrorLogging.test.ts).
// No real database or mysql2 connection is ever touched.
type MockConnection = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function createMockConnection(): MockConnection {
  return { query: vi.fn(), release: vi.fn(), destroy: vi.fn() };
}

function mockPoolWithConnection(connection: MockConnection): ReturnType<typeof vi.fn> {
  const getConnection = vi.fn((callback: (err: unknown, conn?: MockConnection) => void) =>
    callback(null, connection)
  );
  __setDbForTests({ $client: { getConnection } } as any);
  return getConnection;
}

describe("pingDatabase", () => {
  afterEach(() => {
    __setDbForTests(null);
  });

  it("on success: acquires one connection, queries SELECT 1 with the timeout option, releases it once, and never destroys it", async () => {
    const connection = createMockConnection();
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => callback(null));
    const getConnection = mockPoolWithConnection(connection);

    await expect(pingDatabase()).resolves.toBeUndefined();

    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(connection.query).toHaveBeenCalledTimes(1);
    const options = connection.query.mock.calls[0][0];
    expect(options.sql).toBe("SELECT 1");
    // The real mysql2 driver-level bound - see pingDatabase's docstring:
    // this only makes mysql2 report an error via the callback, it does not
    // destroy the connection by itself, which is exactly why this function
    // manages release/destroy itself instead of trusting the timeout alone.
    expect(options.timeout).toBe(DB_PING_TIMEOUT_MS);
    expect(DB_PING_TIMEOUT_MS).toBeLessThan(3000); // must stay under the HTTP-level READYZ_PING_TIMEOUT_MS
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it("on PROTOCOL_SEQUENCE_TIMEOUT: rejects, destroys the connection once, and never releases it", async () => {
    const connection = createMockConnection();
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => {
      const err = new Error("Query inactivity timeout");
      (err as any).code = "PROTOCOL_SEQUENCE_TIMEOUT";
      callback(err);
    });
    mockPoolWithConnection(connection);

    await expect(pingDatabase()).rejects.toMatchObject({ code: "PROTOCOL_SEQUENCE_TIMEOUT" });

    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("on a non-timeout query/network error: rejects and destroys the connection rather than returning a possibly-broken one to the pool", async () => {
    const connection = createMockConnection();
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) =>
      callback(new Error("connect ECONNREFUSED"))
    );
    mockPoolWithConnection(connection);

    await expect(pingDatabase()).rejects.toThrow();

    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("when getConnection() itself fails: rejects without ever calling query, release, or destroy on any connection", async () => {
    const getConnection = vi.fn((callback: (err: unknown, conn?: MockConnection) => void) =>
      callback(new Error("no connections available"))
    );
    __setDbForTests({ $client: { getConnection } } as any);

    await expect(pingDatabase()).rejects.toThrow();

    expect(getConnection).toHaveBeenCalledTimes(1);
  });

  it("when connection.query() throws synchronously: rejects and destroys the connection once", async () => {
    const connection = createMockConnection();
    connection.query.mockImplementation(() => {
      throw new Error("synchronous failure");
    });
    mockPoolWithConnection(connection);

    await expect(pingDatabase()).rejects.toThrow("synchronous failure");

    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("a callback that fires twice (error, then a late success) only settles the promise once and only cleans up the connection once", async () => {
    const connection = createMockConnection();
    let lateCallback: ((err: unknown) => void) | undefined;
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => {
      lateCallback = callback;
      callback(new Error("first callback: down"));
    });
    mockPoolWithConnection(connection);

    await expect(pingDatabase()).rejects.toThrow("first callback: down");

    // mysql2 shouldn't do this, but the settle-once guard must hold even if
    // a callback fires again after this promise already settled.
    lateCallback!(null);

    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("can be called again after a previous rejection - no leftover local state blocks a retry", async () => {
    const failingConnection = createMockConnection();
    failingConnection.query.mockImplementation((_options: any, callback: (err: unknown) => void) =>
      callback(new Error("down"))
    );
    const succeedingConnection = createMockConnection();
    succeedingConnection.query.mockImplementation((_options: any, callback: (err: unknown) => void) =>
      callback(null)
    );
    const getConnection = vi
      .fn()
      .mockImplementationOnce((callback: (err: unknown, conn: MockConnection) => void) =>
        callback(null, failingConnection)
      )
      .mockImplementationOnce((callback: (err: unknown, conn: MockConnection) => void) =>
        callback(null, succeedingConnection)
      );
    __setDbForTests({ $client: { getConnection } } as any);

    await expect(pingDatabase()).rejects.toThrow();
    await expect(pingDatabase()).resolves.toBeUndefined();

    expect(getConnection).toHaveBeenCalledTimes(2);
    expect(failingConnection.destroy).toHaveBeenCalledTimes(1);
    expect(succeedingConnection.release).toHaveBeenCalledTimes(1);
  });
});

// These exercise the full, real pipeline - registerHealthReadinessRoutes
// using its *default* ping (the real pingDatabase, not an injected mock
// function) - with only the mysql2 Pool/PoolConnection mocked via
// __setDbForTests, to prove the timeout/cleanup/dedup/recovery behavior
// holds end-to-end and not just for the injected-ping test double used
// above. Still no real database or mysql2 connection.
describe("registerHealthReadinessRoutes with the real pingDatabase (mocked mysql2 Pool/PoolConnection only)", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
    __setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("once mysql2 times out and calls back with an error, the connection is destroyed, the shared in-flight ping clears, and the next /readyz request acquires a fresh connection", async () => {
    const timedOutConnection = createMockConnection();
    timedOutConnection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => {
      // Stands in for mysql2's own internal timer firing - a short real
      // delay (not the real 2.5s bound, which is mysql2's own internal
      // timer and not under test here) is enough to prove our code reacts
      // correctly once that happens.
      setTimeout(() => {
        const err = new Error("Query inactivity timeout");
        (err as any).code = "PROTOCOL_SEQUENCE_TIMEOUT";
        callback(err);
      }, 15);
    });
    const freshConnection = createMockConnection();
    freshConnection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => callback(null));
    const getConnection = vi
      .fn()
      .mockImplementationOnce((callback: (err: unknown, conn: MockConnection) => void) =>
        callback(null, timedOutConnection)
      )
      .mockImplementationOnce((callback: (err: unknown, conn: MockConnection) => void) =>
        callback(null, freshConnection)
      );
    __setDbForTests({ $client: { getConnection } } as any);

    const started = await startTestServer();
    server = started.server;

    const first = await fetch(`${started.baseUrl}/readyz`);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ status: "not_ready" });
    expect(timedOutConnection.destroy).toHaveBeenCalledTimes(1);
    expect(timedOutConnection.release).not.toHaveBeenCalled();

    const second = await fetch(`${started.baseUrl}/readyz`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "ready" });

    expect(getConnection).toHaveBeenCalledTimes(2);
  });

  it("concurrent /readyz requests only acquire and query one connection while it is outstanding", async () => {
    const connection = createMockConnection();
    let resolveQuery!: (err: unknown) => void;
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => {
      resolveQuery = callback;
    });
    const getConnection = mockPoolWithConnection(connection);

    const started = await startTestServer();
    server = started.server;

    const requests = [
      fetch(`${started.baseUrl}/readyz`),
      fetch(`${started.baseUrl}/readyz`),
      fetch(`${started.baseUrl}/readyz`),
    ];

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(connection.query).toHaveBeenCalledTimes(1);
    resolveQuery(null);

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ready" });
    }
    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it("never leaks the connection URL, host, username, or password from a real mysql2-shaped error, in the response or the log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = createMockConnection();
    connection.query.mockImplementation((_options: any, callback: (err: unknown) => void) => {
      const err = new Error(
        "connect ETIMEDOUT mysql://readyzuser:sup3rSecret@readyz-db.internal.example:3306/prod"
      );
      (err as any).code = "PROTOCOL_CONNECTION_LOST";
      callback(err);
    });
    mockPoolWithConnection(connection);

    const started = await startTestServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/readyz`);
    const bodyText = await res.text();

    expect(res.status).toBe(503);
    expect(bodyText).toBe(JSON.stringify({ status: "not_ready" }));
    for (const secret of ["mysql://", "sup3rSecret", "readyzuser", "readyz-db.internal.example"]) {
      expect(bodyText).not.toContain(secret);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls[0].join(" ");
    for (const secret of ["mysql://", "sup3rSecret", "readyzuser", "readyz-db.internal.example"]) {
      expect(loggedText).not.toContain(secret);
    }
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });
});
