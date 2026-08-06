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
async function startTestServer(ping: DatabasePing): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.set("trust proxy", 1);
  registerHealthReadinessRoutes(app, ping);
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
