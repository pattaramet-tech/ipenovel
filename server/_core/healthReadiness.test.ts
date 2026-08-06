import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerHealthReadinessRoutes, pingDatabase, type DatabasePing } from "./healthReadiness";
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
  ping: DatabasePing,
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
// These exercise it directly (via server/db.ts's existing __setDbForTests
// test hook, the same one used by server/db.rawErrorLogging.test.ts) so a
// mock database client stands in for a real connection - no real database is
// ever touched.
describe("pingDatabase", () => {
  afterEach(() => {
    __setDbForTests(null);
  });

  it("issues a real SELECT 1 query - a client existing is not enough on its own", async () => {
    const execute = vi.fn().mockResolvedValue([[{ 1: 1 }]]);
    __setDbForTests({ execute } as any);

    await expect(pingDatabase()).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    // drizzle's `sql` tagged template returns a SQL object (not a plain
    // string) whose raw text lives in queryChunks - inspect that directly
    // rather than relying on toString().
    expect(JSON.stringify((execute.mock.calls[0][0] as any).queryChunks)).toMatch(/select\s+1/i);
  });

  it("rejects when the query itself fails, even though the client exists", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    __setDbForTests({ execute } as any);

    await expect(pingDatabase()).rejects.toThrow();
  });
});
