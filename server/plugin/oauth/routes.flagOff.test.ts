import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "node:http";

// The flag-off contract: with PLUGIN_FOUNDATION_ENABLED anything other than
// the exact literal "true", every /api/plugin/* route must be
// indistinguishable from not existing (404) - and no database access may
// happen on the way there (these tests run with no DATABASE_URL at all, so
// any accidental DB touch fails loudly instead of passing). ENV is built
// once at import time, so the flag is pinned BEFORE any import below runs
// (vi.hoisted hoists above the transformed module's static imports).
const envSetup = vi.hoisted(() => {
  process.env.PLUGIN_FOUNDATION_ENABLED = "unset-on-purpose";
  process.env.JWT_SECRET ??= "plugin-flagoff-test-secret-0123456789abcdef";
  process.env.VITE_APP_ID ??= "ipenovel-plugin-flagoff-app";
  process.env.PLUGIN_PUBLIC_BASE_URL = "https://plugin-flagoff.example";
});
void envSetup;

import { registerPluginFoundationRoutes } from "./routes";

let server: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  const app: Express = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  registerPluginFoundationRoutes(app);
  await new Promise<void>(resolve => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server ? server.close(error => (error ? reject(error) : resolve())) : resolve()
  );
});

describe("plugin routes with the foundation flag off", () => {
  it.each([
    "/api/plugin/oauth/authorize",
    "/api/plugin/oauth/token",
    "/api/plugin/oauth/revoke",
    "/api/plugin/oauth/authorize/consent",
    "/.well-known/oauth-authorization-server",
    "/api/plugin/mcp",
  ])("answers 404 for %s", async route => {
    const method = route === "/api/plugin/oauth/authorize" || route === "/.well-known/oauth-authorization-server" ? "GET" : "POST";
    const response = await fetch(`${baseUrl}${route}`, { method });
    expect(response.status).toBe(404);
  });

  it("answers 404 even for a fully well-formed authorize request", async () => {
    const query = new URLSearchParams({
      client_id: "plg_some_client",
      redirect_uri: "https://chatgpt.example/callback",
      scope: "identity:read",
      state: "0123456789abcdef",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const response = await fetch(`${baseUrl}/api/plugin/oauth/authorize?${query}`);
    expect(response.status).toBe(404);
  });
});
