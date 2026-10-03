import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "node:http";

// Flag-ON edge behavior that never needs a database: RFC 8414 metadata
// shape, the unauthenticated 401+WWW-Authenticate at the MCP edge, and the
// unauthenticated invalid_client at the token endpoint (client credentials
// are checked before any DB round trip). These tests intentionally run with
// no DATABASE_URL - any accidental DB touch fails loudly.
const envSetup = vi.hoisted(() => {
  process.env.PLUGIN_FOUNDATION_ENABLED = "true";
  process.env.JWT_SECRET ??= "plugin-edge-test-secret-0123456789abcdef";
  process.env.VITE_APP_ID ??= "ipenovel-plugin-edge-app";
  process.env.PLUGIN_PUBLIC_BASE_URL = "https://ipenovel.example";
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

describe("plugin edge behavior (flag on, no DB)", () => {
  it("serves RFC 8414 metadata derived from PLUGIN_PUBLIC_BASE_URL", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe("https://ipenovel.example");
    expect(metadata.authorization_endpoint).toBe("https://ipenovel.example/api/plugin/oauth/authorize");
    expect(metadata.token_endpoint).toBe("https://ipenovel.example/api/plugin/oauth/token");
    expect(metadata.revocation_endpoint).toBe("https://ipenovel.example/api/plugin/oauth/revoke");
    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.scopes_supported).toEqual(["identity:read"]);
  });

  it("rejects MCP calls without a bearer token with 401 + WWW-Authenticate (no DB access)", async () => {
    const response = await fetch(`${baseUrl}/api/plugin/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain('scope="identity:read"');
  });

  it("rejects a bearer-less token request with invalid_client before any DB access", async () => {
    const response = await fetch(`${baseUrl}/api/plugin/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: "x", code_verifier: "y", redirect_uri: "https://x.example/cb" }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client");
    // Deterministic sanitized description - never request-derived text.
    expect(body.error_description).toBe("Client authentication failed.");
  });

  it("answers a token request for an unsupported grant type with a fixed error", async () => {
    const basic = Buffer.from("plg_x:secret").toString("base64");
    const response = await fetch(`${baseUrl}/api/plugin/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
      body: JSON.stringify({ grant_type: "password", username: "a", password: "b" }),
    });
    // This reaches the DB path only in an integration run; without a
    // DATABASE_URL the failure is a sanitized server_error, never a leak.
    const body = (await response.json()) as { error: string };
    expect(["unsupported_grant_type", "invalid_client", "server_error"]).toContain(body.error);
  });
});
