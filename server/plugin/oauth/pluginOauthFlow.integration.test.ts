import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "node:http";
import { inArray } from "drizzle-orm";

// IPE-PLUGIN-001B integration + security suite - the real OAuth 2.1 + PKCE
// flow against the real (test) MySQL, proving:
//   1. multiple ChatGPT accounts resolve ONLY their own IpeNovel identity,
//   2. forged / expired / revoked / wrong-audience / wrong-issuer /
//      insufficient-scope credentials all FAIL CLOSED.
//
// Uses the integration project's DATABASE_URL=TEST_DATABASE_URL wiring
// (vitest.integration.globalsetup.ts) - store.ts resolves connections
// through server/db.ts, whose override covers every plugin query.
const envSetup = vi.hoisted(() => {
  process.env.PLUGIN_FOUNDATION_ENABLED = "true";
  process.env.JWT_SECRET ??= "plugin-integration-test-secret-0123456789abcdef";
  process.env.VITE_APP_ID ??= "ipenovel-plugin-integration-app";
});
void envSetup;

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "../../_core/sdk";
import {
  pluginAccessGrants,
  pluginAuditLogs,
  pluginOAuthAuthorizations,
  pluginOAuthClients,
  pluginRefreshGrants,
} from "../../../drizzle/schema";
import { getTestDb } from "../../test-helpers/testDb";
import {
  createTestUser,
  deleteFixtures,
  uniqueTestTag,
  type TestUserFixture,
} from "../../test-helpers/fixtures";
import { registerPluginFoundationRoutes } from "./routes";
import {
  computePkceS256Challenge,
  generatePluginOpaqueToken,
  hashPluginSecret,
  PLUGIN_ACCESS_TOKEN_PREFIX,
  PLUGIN_REFRESH_TOKEN_PREFIX,
} from "../crypto";

const REDIRECT_URI = "https://chatgpt.example/callback";

let server: Server | undefined;
let baseUrl = "";

const createdUserIds: number[] = [];
const createdClientIds: string[] = [];

async function createTestPluginClient(): Promise<{ clientId: string; clientSecret: string }> {
  const db = getTestDb();
  const clientId = `plg_${uniqueTestTag("cli")}`;
  const clientSecret = generatePluginOpaqueToken();
  await db.insert(pluginOAuthClients).values({
    clientId,
    clientSecretHash: hashPluginSecret(clientSecret),
    name: `Test client ${clientId}`,
    redirectUris: JSON.stringify([REDIRECT_URI]),
    allowedScopes: "identity:read",
  });
  createdClientIds.push(clientId);
  return { clientId, clientSecret };
}

async function sessionCookie(user: TestUserFixture): Promise<string> {
  const token = await sdk.signSession({
    openId: user.openId,
    appId: process.env.VITE_APP_ID ?? "",
    name: `Plugin Test ${user.id}`,
  });
  return `${COOKIE_NAME}=${token}`;
}

/**
 * Drives the browser half of the flow (authorize GET -> consent POST) and
 * returns the authorization code. Mirrors exactly what a real browser does,
 * including the CSRF cookie.
 */
async function runAuthorizeAndConsent(
  user: TestUserFixture,
  client: { clientId: string },
  overrides: Partial<{ scope: string; decision: "approve" | "deny"; csrfToken: string }> = {}
): Promise<{ code: string | null; state: string; verifier: string; location: string | null; consentStatus: number }> {
  const verifier = generatePluginOpaqueToken();
  const challenge = computePkceS256Challenge(verifier);
  const state = uniqueTestTag("state");
  const cookie = await sessionCookie(user);
  const scope = overrides.scope ?? "identity:read";

  const authorizeUrl =
    `${baseUrl}/api/plugin/oauth/authorize?` +
    new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_mode: "query",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  const authorizeResponse = await fetch(authorizeUrl, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(authorizeResponse.status).toBe(200);
  const setCookie = authorizeResponse.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("plugin_oauth_consent_csrf=");
  const html = await authorizeResponse.text();
  const csrfMatch = /name="csrfToken" value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error(`no csrf token in consent page: ${html.slice(0, 200)}`);
  const csrfToken = overrides.csrfToken ?? csrfMatch[1];

  const consentResponse = await fetch(`${baseUrl}/api/plugin/oauth/authorize/consent`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${cookie}; plugin_oauth_consent_csrf=${csrfToken}`,
    },
    body: new URLSearchParams({
      state,
      csrfToken,
      decision: overrides.decision ?? "approve",
    }).toString(),
    redirect: "manual",
  });

  const location = consentResponse.headers.get("location");
  let code: string | null = null;
  if (location) {
    code = new URL(location).searchParams.get("code");
  }
  return { code, state, verifier, location, consentStatus: consentResponse.status };
}

async function exchangeCode(
  client: { clientId: string; clientSecret: string },
  input: { code: string; verifier: string; redirectUri?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/plugin/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri ?? REDIRECT_URI,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type TokenGrant = {
  accessToken: string;
  refreshToken: string;
  scope: string;
};

function expectGrant(body: Record<string, unknown>): TokenGrant {
  expect(body.error).toBeUndefined();
  expect(body.token_type).toBe("Bearer");
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  expect(typeof accessToken).toBe("string");
  expect(String(accessToken).startsWith(PLUGIN_ACCESS_TOKEN_PREFIX)).toBe(true);
  expect(String(refreshToken).startsWith(PLUGIN_REFRESH_TOKEN_PREFIX)).toBe(true);
  return {
    accessToken: String(accessToken),
    refreshToken: String(refreshToken),
    scope: String(body.scope),
  };
}

async function callMcp(
  accessToken: string | null,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${baseUrl}/api/plugin/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 202) return { status: 202, body: null };
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function whoami(accessToken: string): Promise<{ status: number; body: Record<string, unknown> | null; result: Record<string, unknown> | null }> {
  const { status, body } = await callMcp(accessToken, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "identity.whoami", arguments: {} },
  });
  const result =
    body && typeof body.result === "object" && body.result !== null
      ? ((body.result as Record<string, unknown>).structuredContent as Record<string, unknown> | undefined) ?? null
      : null;
  return { status, body, result };
}

async function fullGrantFor(
  user: TestUserFixture,
  client: { clientId: string; clientSecret: string }
): Promise<TokenGrant> {
  const consent = await runAuthorizeAndConsent(user, client);
  expect(consent.consentStatus).toBe(302);
  expect(consent.code).toBeTruthy();
  const exchange = await exchangeCode(client, { code: consent.code as string, verifier: consent.verifier });
  expect(exchange.status).toBe(200);
  return expectGrant(exchange.body);
}

/**
 * Directly inserts a plugin access-token row (for expiry/scope scenarios).
 * Every token needs a real parent authorization (FK), so one is created
 * here when the scenario does not go through the consent flow.
 */
async function insertDirectAccessToken(input: {
  userId: number;
  clientId: string;
  scope: string;
  expiresAt: Date;
}): Promise<string> {
  const db = getTestDb();
  const existing = await db
    .select({ id: pluginOAuthAuthorizations.id })
    .from(pluginOAuthAuthorizations)
    .where(inArray(pluginOAuthAuthorizations.clientId, [input.clientId]));
  let authorizationId = existing[0]?.id;
  if (!authorizationId) {
    const inserted = await db.insert(pluginOAuthAuthorizations).values({
      userId: input.userId,
      clientId: input.clientId,
      scope: "identity:read",
    });
    const header = Array.isArray(inserted) ? inserted[0] : inserted;
    authorizationId = (header as { insertId?: number }).insertId;
  }
  if (!authorizationId) throw new Error("failed to create parent authorization");
  const token = PLUGIN_ACCESS_TOKEN_PREFIX + generatePluginOpaqueToken();
  await db.insert(pluginAccessGrants).values({
    tokenHash: hashPluginSecret(token),
    authorizationId,
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    expiresAt: input.expiresAt,
  });
  return token;
}

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
  const db = getTestDb();
  if (createdClientIds.length > 0) {
    await db.delete(pluginAuditLogs).where(inArray(pluginAuditLogs.clientId, createdClientIds));
    await db.delete(pluginOAuthClients).where(inArray(pluginOAuthClients.clientId, createdClientIds));
  }
  if (createdUserIds.length > 0) {
    // Plugin rows cascade off users (consent/authorization/codes/tokens).
    await deleteFixtures({ userIds: [...createdUserIds] });
  }
  await new Promise<void>((resolve, reject) =>
    server ? server.close(error => (error ? reject(error) : resolve())) : resolve()
  );
});

describe("plugin OAuth 2.1 + PKCE flow (happy path)", () => {
  it("binds a consented authorization code to the session user and issues a scoped grant", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();

    const consent = await runAuthorizeAndConsent(user, client);
    expect(consent.consentStatus).toBe(302);
    expect(consent.code).toBeTruthy();
    expect(new URL(consent.location ?? "").searchParams.get("state")).toBe(consent.state);

    const exchange = await exchangeCode(client, { code: consent.code as string, verifier: consent.verifier });
    expect(exchange.status).toBe(200);
    const grant = expectGrant(exchange.body);
    expect(grant.scope).toBe("identity:read");

    // whoami resolves to the consenting user's identity.
    const { status, result } = await whoami(grant.accessToken);
    expect(status).toBe(200);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(user.id);
    expect(result!.scope).toBe("identity:read");
    expect(result!.clientId).toBe(client.clientId);
    expect(["user", "admin"]).toContain(result!.role);

    // The tools/list surface exposes ONLY the identity tool.
    const listing = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listing.status).toBe(200);
    const tools = (listing.body!.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(tools.map(tool => tool.name)).toEqual(["identity.whoami"]);
  });

  it("consumes an authorization code exactly once", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client);
    const first = await exchangeCode(client, { code: consent.code as string, verifier: consent.verifier });
    expect(first.status).toBe(200);

    const replay = await exchangeCode(client, { code: consent.code as string, verifier: consent.verifier });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });
});

describe("multi-account identity isolation", () => {
  it("resolves each ChatGPT account only to its own IpeNovel identity", async () => {
    const userA = await createTestUser({ name: "Account A" });
    const userB = await createTestUser({ name: "Account B" });
    createdUserIds.push(userA.id, userB.id);
    const clientA = await createTestPluginClient();
    const clientB = await createTestPluginClient();

    const grantA = await fullGrantFor(userA, clientA);
    const grantB = await fullGrantFor(userB, clientB);

    const whoA = await whoami(grantA.accessToken);
    const whoB = await whoami(grantB.accessToken);
    expect(whoA.result!.userId).toBe(userA.id);
    expect(whoA.result!.clientId).toBe(clientA.clientId);
    expect(whoB.result!.userId).toBe(userB.id);
    expect(whoB.result!.clientId).toBe(clientB.clientId);
    expect(whoA.result!.userId).not.toBe(whoB.result!.userId);

    // A's token carries no trace of B's identity anywhere in the payload.
    expect(JSON.stringify(whoA.body)).not.toContain(String(userB.id));
    expect(JSON.stringify(whoB.body)).not.toContain(String(userA.id));
  });
});

describe("credentials that must fail closed", () => {
  it("rejects a forged bearer token with 401 + WWW-Authenticate", async () => {
    const forged = PLUGIN_ACCESS_TOKEN_PREFIX + generatePluginOpaqueToken();
    const response = await fetch(`${baseUrl}/api/plugin/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${forged}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects bearer-less MCP calls with 401", async () => {
    const { status } = await callMcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("rejects an IpeNovel SESSION JWT used as a bearer token (wrong issuer/audience class)", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const cookie = await sessionCookie(user);
    const sessionJwt = cookie.split("=")[1];
    const { status } = await callMcp(sessionJwt, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("rejects a self-signed JWT with plugin-flavored claims (wrong issuer)", async () => {
    const { SignJWT } = await import("jose");
    const forged = await new SignJWT({ userId: 1, scopes: ["identity:read"] })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setIssuer("ipenovel-plugin")
      .setAudience("ipenovel-plugin-mcp")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET ?? ""));
    const { status } = await callMcp(forged, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("rejects an expired access token with 401", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const token = await insertDirectAccessToken({
      userId: user.id,
      clientId: client.clientId,
      scope: "identity:read",
      expiresAt: new Date(Date.now() - 1000),
    });
    const { status } = await callMcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("stops accepting tokens immediately after the client is disabled", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);

    const db = getTestDb();
    await db
      .update(pluginOAuthClients)
      .set({ status: "disabled" })
      .where(inArray(pluginOAuthClients.clientId, [client.clientId]));

    const { status } = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);

    await db
      .update(pluginOAuthClients)
      .set({ status: "active" })
      .where(inArray(pluginOAuthClients.clientId, [client.clientId]));
  });

  it("rejects tokens with insufficient scope at authorization (denied, not executed)", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const token = await insertDirectAccessToken({
      userId: user.id,
      clientId: client.clientId,
      scope: "",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { status, body } = await callMcp(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "identity.whoami", arguments: {} },
    });
    expect(status).toBe(200);
    const error = body!.error as { code: number; message: string; data?: { reason: string } };
    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe("INSUFFICIENT_SCOPE");
  });

  it("rejects unknown MCP methods and tool names", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);

    const unknownMethod = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 4, method: "novels/list" });
    expect((unknownMethod.body!.error as { code: number }).code).toBe(-32601);

    const unknownTool = await callMcp(grant.accessToken, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "workspace.list", arguments: {} },
    });
    const error = unknownTool.body!.error as { code: number; data?: { reason: string } };
    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe("UNKNOWN_CAPABILITY");
  });
});

describe("authorization-code binding failures", () => {
  it("rejects a wrong PKCE verifier", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client);
    const exchange = await exchangeCode(client, {
      code: consent.code as string,
      verifier: generatePluginOpaqueToken(),
    });
    expect(exchange.status).toBe(400);
    expect(exchange.body.error).toBe("invalid_grant");
  });

  it("rejects an exchange with a different client than the one the code was issued to (audience binding)", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const clientA = await createTestPluginClient();
    const clientB = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, clientA);
    const exchange = await exchangeCode(clientB, { code: consent.code as string, verifier: consent.verifier });
    expect(exchange.status).toBe(400);
    expect(exchange.body.error).toBe("invalid_grant");
    // ...and the code is burned: client A can no longer use it either.
    const byOwner = await exchangeCode(clientA, { code: consent.code as string, verifier: consent.verifier });
    expect(byOwner.status).toBe(400);
    expect(byOwner.body.error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri that does not match the authorize request", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client);
    const exchange = await exchangeCode(client, {
      code: consent.code as string,
      verifier: consent.verifier,
      redirectUri: "https://attacker.example/callback",
    });
    expect(exchange.status).toBe(400);
    expect(exchange.body.error).toBe("invalid_grant");
  });

  it("rejects a wrong client secret at token exchange", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client);
    const exchange = await exchangeCode(
      { clientId: client.clientId, clientSecret: generatePluginOpaqueToken() },
      { code: consent.code as string, verifier: consent.verifier }
    );
    expect(exchange.status).toBe(401);
    expect(exchange.body.error).toBe("invalid_client");
  });

  it("rejects consent replay (state already consumed)", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const first = await runAuthorizeAndConsent(user, client);
    expect(first.consentStatus).toBe(302);

    // A second POST for the same state (whatever the csrf source) must fail.
    const cookie = await sessionCookie(user);
    const replay = await fetch(`${baseUrl}/api/plugin/oauth/authorize/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ state: first.state, csrfToken: "whatever", decision: "approve" }).toString(),
      redirect: "manual",
    });
    expect(replay.status).toBe(400);
  });

  it("refuses a consent decision from a DIFFERENT session user (no cross-account approval)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    createdUserIds.push(userA.id, userB.id);
    const client = await createTestPluginClient();

    const verifier = generatePluginOpaqueToken();
    const state = uniqueTestTag("state");
    const cookieA = await sessionCookie(userA);
    const authorizeResponse = await fetch(
      `${baseUrl}/api/plugin/oauth/authorize?${new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        scope: "identity:read",
        state,
        code_challenge: computePkceS256Challenge(verifier),
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie: cookieA }, redirect: "manual" }
    );
    expect(authorizeResponse.status).toBe(200);
    const html = await authorizeResponse.text();
    const csrfToken = /name="csrfToken" value="([^"]+)"/.exec(html)![1];

    // User B tries to approve A's attempt.
    const cookieB = await sessionCookie(userB);
    const consentB = await fetch(`${baseUrl}/api/plugin/oauth/authorize/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${cookieB}; plugin_oauth_consent_csrf=${csrfToken}`,
      },
      body: new URLSearchParams({ state, csrfToken, decision: "approve" }).toString(),
      redirect: "manual",
    });
    expect(consentB.status).toBe(400);

    // ...and the attempt is burned - A can no longer approve it either.
    const consentA = await fetch(`${baseUrl}/api/plugin/oauth/authorize/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${cookieA}; plugin_oauth_consent_csrf=${csrfToken}`,
      },
      body: new URLSearchParams({ state, csrfToken, decision: "approve" }).toString(),
      redirect: "manual",
    });
    expect(consentA.status).toBe(400);
  });

  it("rejects a consent POST with a tampered CSRF token", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client, { csrfToken: generatePluginOpaqueToken() });
    expect(consent.consentStatus).toBe(400);
  });

  it("redirects a denied consent with access_denied and issues no code", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const consent = await runAuthorizeAndConsent(user, client, { decision: "deny" });
    expect(consent.consentStatus).toBe(302);
    const location = new URL(consent.location ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });
});

describe("refresh rotation + revocation", () => {
  it("rotates refresh tokens, inherits scope, and revokes the family on reuse", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${baseUrl}/api/plugin/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const rotated = await refresh(grant.refreshToken);
    expect(rotated.status).toBe(200);
    const newGrant = expectGrant(rotated.body);
    expect(newGrant.refreshToken).not.toBe(grant.refreshToken);
    expect(newGrant.scope).toBe("identity:read");
    expect(newGrant.accessToken).not.toBe(grant.accessToken);

    // The OLD refresh token presented again is reuse - the whole family dies.
    const reuse = await refresh(grant.refreshToken);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");

    // ...including the NEW access token from the rotated grant.
    const { status } = await callMcp(newGrant.accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("honors RFC 7009 revocation for access tokens (200, then 401)", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);

    const before = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(before.status).toBe(200);

    const revoke = await fetch(`${baseUrl}/api/plugin/oauth/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ token: grant.accessToken, token_type_hint: "access_token" }),
    });
    expect(revoke.status).toBe(200);

    const after = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(after.status).toBe(401);
  });

  it("revoking a refresh token kills the whole grant family", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);

    const revoke = await fetch(`${baseUrl}/api/plugin/oauth/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ token: grant.refreshToken, token_type_hint: "refresh_token" }),
    });
    expect(revoke.status).toBe(200);

    const { status } = await callMcp(grant.accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("returns 200 for revocation of an unknown token (RFC 7009 §2.2)", async () => {
    const client = await createTestPluginClient();
    const revoke = await fetch(`${baseUrl}/api/plugin/oauth/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ token: PLUGIN_ACCESS_TOKEN_PREFIX + generatePluginOpaqueToken() }),
    });
    expect(revoke.status).toBe(200);
  });
});

describe("plugin audit trail", () => {
  it("records the security decisions of a full flow with correlation ids", async () => {
    const user = await createTestUser();
    createdUserIds.push(user.id);
    const client = await createTestPluginClient();
    const grant = await fullGrantFor(user, client);
    await whoami(grant.accessToken);

    const db = getTestDb();
    const rows = await db
      .select({ eventType: pluginAuditLogs.eventType, correlationId: pluginAuditLogs.correlationId, actorUserId: pluginAuditLogs.actorUserId })
      .from(pluginAuditLogs)
      .where(inArray(pluginAuditLogs.clientId, [client.clientId]));
    const eventTypes = new Set(rows.map(row => row.eventType));
    expect(eventTypes).toContain("consent_approved");
    expect(eventTypes).toContain("token_issued");
    expect(eventTypes).toContain("mcp_tool_allowed");
    for (const row of rows) {
      expect(row.correlationId.startsWith("plg-")).toBe(true);
      expect(row.actorUserId).toBe(user.id);
    }

    // Refresh-token metadata rows must never contain token material.
    const refreshRows = await db
      .select({ metadata: pluginRefreshGrants.tokenHash })
      .from(pluginRefreshGrants)
      .where(inArray(pluginRefreshGrants.clientId, [client.clientId]));
    for (const row of refreshRows) {
      expect(row.metadata).toHaveLength(64);
      expect(row.metadata).not.toContain("plg_");
    }
  });
});
