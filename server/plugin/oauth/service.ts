import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  PLUGIN_AUTHORIZATION_CODE_PREFIX,
  PLUGIN_ACCESS_TOKEN_PREFIX,
  PLUGIN_REFRESH_TOKEN_PREFIX,
  generatePluginOpaqueToken,
  hashPluginSecret,
  hashesEqual,
  verifyPkceS256,
} from "../crypto";
import { parsePluginScopes, type PluginAuditSink, type PluginPermissionScope } from "../controlPlane";
import { pluginOAuthError } from "../errors";
import {
  consumePluginAuthorizationCode,
  consumePluginConsentAttempt,
  createPluginAccessToken,
  createPluginAuthorizationCode,
  createPluginConsentAttempt,
  createPluginRefreshToken,
  findActivePluginOAuthClient,
  findPluginAccessTokenOwnerByHash,
  findPluginConsentAttemptByStateHash,
  findPluginRefreshTokenByIdForUpdate,
  findPluginRefreshTokenByHash,
  findValidPluginAccessToken,
  revokeAllTokensForAuthorization,
  revokePluginAccessToken,
  revokePluginRefreshToken,
  runPluginTransaction,
  touchPluginAuthorizationLastUsed,
  upsertPluginAuthorizationScope,
  type PluginDbExecutor,
} from "../store";
// IPE-PLUGIN-001B OAuth 2.1 authorization-code + PKCE flow logic.
//
// Every function here is deliberately take-explicit-input / return-plain-
// data so the HTTP layer (oauth/routes.ts) stays thin and the security
// decisions are unit-testable without a server. TTLs, scope parsing, PKCE
// verification, and single-use semantics all live HERE, not in routes.

export const PLUGIN_AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const PLUGIN_CONSENT_ATTEMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const PLUGIN_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const PLUGIN_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const PLUGIN_SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export const PLUGIN_SUPPORTED_CODE_CHALLENGE_METHODS = ["S256"] as const;

/** Space-separated scope string for a grant - canonical, sorted, deduped. */
function canonicalScopeString(scopes: readonly PluginPermissionScope[]): string {
  return Array.from(new Set(scopes)).sort().join(" ");
}

function isSafeRedirectUri(uri: string): boolean {
  // Structural guard on TOP of exact-match registration: only https (or
  // http loopback for local dev, per RFC 8252 §7.3) can ever be registered.
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:") {
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    }
    return false;
  } catch {
    return false;
  }
}

export function parseRegisteredRedirectUris(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 1: authorize (browser, session-authenticated)
// ---------------------------------------------------------------------------

export type PluginAuthorizeInput = {
  clientId: string | undefined;
  redirectUri: string | undefined;
  /** RFC 6749 §3.1.1 - only the exact literal "code" is accepted. */
  responseType: string | undefined;
  responseMode: string | undefined;
  state: string | undefined;
  scope: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  userId: number;
  now: Date;
};

export type PluginConsentAttemptCreated = {
  state: string;
  csrfToken: string;
  clientName: string;
  scopes: readonly PluginPermissionScope[];
};

/**
 * Validates one authorize request and records the single-use consent
 * attempt it is bound to. Fails closed with invalid_request/invalid_scope/
 * invalid_client before anything is persisted. The `state` and CSRF token
 * are returned in cleartext ONCE (they go to the browser); only their
 * hashes are stored.
 */
export async function beginPluginAuthorization(
  input: PluginAuthorizeInput
): Promise<PluginConsentAttemptCreated> {
  if (!input.clientId || !input.redirectUri || !input.state || !input.scope || !input.codeChallenge) {
    throw pluginOAuthError("invalid_request");
  }
  // RFC 6749 §3.1.1: response_type is REQUIRED and this server only ever
  // issues authorization codes - missing, "token" (implicit flow, dead since
  // OAuth 2.1), or any other value fails closed BEFORE any consent attempt
  // is persisted, so a rejected authorize leaves nothing behind.
  if (input.responseType !== "code") {
    throw pluginOAuthError("invalid_request");
  }
  if (input.responseMode !== undefined && input.responseMode !== "query") {
    throw pluginOAuthError("invalid_request");
  }
  if (input.codeChallengeMethod !== "S256") {
    // RFC 7636: method omitted defaults to "plain", which OAuth 2.1 drops -
    // only explicit S256 is accepted, ever.
    throw pluginOAuthError("invalid_request");
  }
  if (input.codeChallenge.length < 43 || input.codeChallenge.length > 128) {
    throw pluginOAuthError("invalid_request");
  }
  if (input.state.length < 16 || input.state.length > 255) {
    throw pluginOAuthError("invalid_request");
  }

  const requestedScopes = parsePluginScopes(input.scope);
  if (requestedScopes.length === 0) {
    throw pluginOAuthError("invalid_scope");
  }
  if (!isSafeRedirectUri(input.redirectUri)) {
    throw pluginOAuthError("invalid_request");
  }

  const client = await findActivePluginOAuthClient(input.clientId);
  if (!client) {
    throw pluginOAuthError("invalid_client", 401);
  }
  const registered = parseRegisteredRedirectUris(client.redirectUris);
  if (!registered.includes(input.redirectUri)) {
    // Exact byte-match against the registered list - never a prefix,
    // never a derived origin.
    throw pluginOAuthError("invalid_request");
  }
  const clientAllowed = new Set(parsePluginScopes(client.allowedScopes));
  for (const scope of requestedScopes) {
    if (!clientAllowed.has(scope)) {
      throw pluginOAuthError("invalid_scope");
    }
  }

  const state = input.state;
  const csrfToken = generatePluginOpaqueToken();
  await createPluginConsentAttempt({
    userId: input.userId,
    stateHash: hashPluginSecret(state),
    csrfTokenHash: hashPluginSecret(csrfToken),
    clientId: client.clientId,
    redirectUri: input.redirectUri,
    scope: canonicalScopeString(requestedScopes),
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: new Date(input.now.getTime() + PLUGIN_CONSENT_ATTEMPT_TTL_MS),
  });

  return {
    state,
    csrfToken,
    clientName: client.name,
    scopes: requestedScopes,
  };
}

// ---------------------------------------------------------------------------
// Step 2: consent decision (browser POST, session + CSRF)
// ---------------------------------------------------------------------------

export type PluginConsentDecisionInput = {
  state: string | undefined;
  csrfToken: string | undefined;
  decision: string | undefined;
  userId: number;
  now: Date;
  auditSink: PluginAuditSink;
};

export type PluginConsentOutcome =
  | { kind: "approved"; redirectUrl: string }
  | { kind: "denied"; redirectUrl: string };

/**
 * Applies the user's consent decision for one state-bound attempt.
 * Single-use by consume-on-read: the attempt row is consumed whether the
 * decision is approve, deny, or invalid - a replayed consent POST can never
 * mint a second code.
 */
export async function decidePluginConsent(
  input: PluginConsentDecisionInput
): Promise<PluginConsentOutcome> {
  const correlationId = `plg-${randomUUID()}`;
  const audit = (eventType: string, actorUserId: number | null, clientId: string | null, metadata: Record<string, unknown>) =>
    input.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType,
      actorUserId,
      clientId,
      correlationId,
      safeMetadata: JSON.stringify(metadata),
      createdAt: input.now.toISOString(),
    });

  if (!input.state || !input.csrfToken || (input.decision !== "approve" && input.decision !== "deny")) {
    throw pluginOAuthError("invalid_request");
  }

  const stateHash = hashPluginSecret(input.state);
  // The claim IS the authority: one conditional UPDATE (consumedAt IS NULL)
  // flips the attempt, and the affected-row count decides the sole winner.
  // A concurrent duplicate decision matches zero rows and fails closed
  // BEFORE any validation result can be reused - exactly one consent
  // decision per attempt, no matter how many race.
  const claimed = await consumePluginConsentAttempt(stateHash);
  if (!claimed) {
    await audit("consent_rejected", input.userId, null, { reason: "attempt_missing_or_consumed" });
    throw pluginOAuthError("invalid_grant");
  }
  const attempt = await findPluginConsentAttemptByStateHash(stateHash);

  if (!attempt) {
    // Claimed but unreadable (expired-row sweep race) - the attempt is
    // burned either way; fail closed.
    await audit("consent_rejected", input.userId, null, { reason: "attempt_missing_or_consumed" });
    throw pluginOAuthError("invalid_grant");
  }
  if (attempt.userId !== input.userId) {
    // A consent decision is bound to the session that started it - a second
    // account approving (or denying) someone else's request must fail closed.
    await audit("consent_rejected", input.userId, attempt.clientId, { reason: "user_mismatch" });
    throw pluginOAuthError("invalid_grant");
  }
  if (attempt.expiresAt.getTime() <= input.now.getTime()) {
    await audit("consent_rejected", input.userId, attempt.clientId, { reason: "attempt_expired" });
    throw pluginOAuthError("invalid_grant");
  }
  if (!hashesEqual(hashPluginSecret(input.csrfToken), attempt.csrfTokenHash)) {
    await audit("consent_rejected", input.userId, attempt.clientId, { reason: "csrf_mismatch" });
    throw pluginOAuthError("invalid_grant");
  }

  const redirectUrl = new URL(attempt.redirectUri);
  if (input.decision === "deny") {
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set("state", input.state);
    await audit("consent_denied", input.userId, attempt.clientId, { scope: attempt.scope });
    return { kind: "denied", redirectUrl: redirectUrl.toString() };
  }

  const client = await findActivePluginOAuthClient(attempt.clientId);
  if (!client) {
    await audit("consent_rejected", input.userId, attempt.clientId, { reason: "client_inactive" });
    throw pluginOAuthError("invalid_client", 401);
  }

  const authorization = await upsertPluginAuthorizationScope({
    userId: attempt.userId,
    clientId: attempt.clientId,
    scope: attempt.scope,
    now: input.now,
  });

  const code = PLUGIN_AUTHORIZATION_CODE_PREFIX + generatePluginOpaqueToken();
  await createPluginAuthorizationCode({
    codeHash: hashPluginSecret(code),
    authorizationId: authorization.id,
    userId: attempt.userId,
    clientId: attempt.clientId,
    redirectUri: attempt.redirectUri,
    scope: attempt.scope,
    codeChallenge: attempt.codeChallenge,
    codeChallengeMethod: attempt.codeChallengeMethod,
    expiresAt: new Date(input.now.getTime() + PLUGIN_AUTHORIZATION_CODE_TTL_MS),
  });

  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", input.state);
  await audit("consent_approved", input.userId, attempt.clientId, {
    scope: attempt.scope,
    authorizationId: authorization.id,
  });
  return { kind: "approved", redirectUrl: redirectUrl.toString() };
}

// ---------------------------------------------------------------------------
// Step 3: token exchange / refresh / revoke (confidential client)
// ---------------------------------------------------------------------------

export type PluginClientAuth = {
  clientId: string;
  clientSecret: string;
};

/**
 * Extracts client credentials from HTTP Basic (RFC 6749 §2.3.1) or the
 * JSON/urlencoded body. Both transports carry the same pair; body wins only
 * when no Authorization header exists (never both-mixed).
 */
export function extractPluginClientCredentials(req: Request, bodyClientId: unknown, bodyClientSecret: unknown): PluginClientAuth | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator <= 0) return null;
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    } catch {
      return null;
    }
  }
  if (typeof bodyClientId === "string" && typeof bodyClientSecret === "string" && bodyClientId.length > 0) {
    return { clientId: bodyClientId, clientSecret: bodyClientSecret };
  }
  return null;
}

async function authenticatePluginClient(
  auth: PluginClientAuth | null
): Promise<{ clientId: string }> {
  if (!auth) throw pluginOAuthError("invalid_client", 401);
  const client = await findActivePluginOAuthClient(auth.clientId);
  if (!client) throw pluginOAuthError("invalid_client", 401);
  if (!hashesEqual(hashPluginSecret(auth.clientSecret), client.clientSecretHash)) {
    throw pluginOAuthError("invalid_client", 401);
  }
  return { clientId: client.clientId };
}

export type PluginTokenExchangeInput = {
  body: Record<string, unknown>;
  clientAuth: PluginClientAuth | null;
  now: Date;
  auditSink: PluginAuditSink;
};

export type PluginTokenGrant = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
};

async function issueGrant(
  input: {
    authorizationId: number;
    userId: number;
    clientId: string;
    scope: string;
    now: Date;
  },
  exec?: PluginDbExecutor
): Promise<PluginTokenGrant> {
  const accessToken = PLUGIN_ACCESS_TOKEN_PREFIX + generatePluginOpaqueToken();
  const refreshToken = PLUGIN_REFRESH_TOKEN_PREFIX + generatePluginOpaqueToken();
  // Persisted BEFORE the response is built - a grant that is not durably
  // stored must never be handed to a client. Under runPluginTransaction both
  // inserts land in the rotation's transaction, so a concurrent reuse
  // detection that flips the family afterwards covers them too.
  await createPluginAccessToken(
    {
      tokenHash: hashPluginSecret(accessToken),
      authorizationId: input.authorizationId,
      userId: input.userId,
      clientId: input.clientId,
      scope: input.scope,
      expiresAt: new Date(input.now.getTime() + PLUGIN_ACCESS_TOKEN_TTL_MS),
    },
    exec
  );
  await createPluginRefreshToken(
    {
      tokenHash: hashPluginSecret(refreshToken),
      authorizationId: input.authorizationId,
      userId: input.userId,
      clientId: input.clientId,
      scope: input.scope,
      expiresAt: new Date(input.now.getTime() + PLUGIN_REFRESH_TOKEN_TTL_MS),
    },
    exec
  );
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: Math.floor(PLUGIN_ACCESS_TOKEN_TTL_MS / 1000),
    scope: input.scope,
  };
}

export async function exchangePluginAuthorizationCode(
  input: PluginTokenExchangeInput
): Promise<PluginTokenGrant> {
  const client = await authenticatePluginClient(input.clientAuth);
  const correlationId = `plg-${randomUUID()}`;
  const audit = (eventType: string, actorUserId: number | null, metadata: Record<string, unknown>) =>
    input.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType,
      actorUserId,
      clientId: client.clientId,
      correlationId,
      safeMetadata: JSON.stringify(metadata),
      createdAt: input.now.toISOString(),
    });

  if (input.body.grant_type !== "authorization_code") {
    throw pluginOAuthError(
      input.body.grant_type === undefined ? "invalid_request" : "unsupported_grant_type"
    );
  }
  const code = typeof input.body.code === "string" ? input.body.code : null;
  const redirectUri = typeof input.body.redirect_uri === "string" ? input.body.redirect_uri : null;
  const codeVerifier = typeof input.body.code_verifier === "string" ? input.body.code_verifier : null;
  if (!code || !codeVerifier || !redirectUri) {
    throw pluginOAuthError("invalid_request");
  }

  // Atomic single-use claim - a replayed/expired code never gets past here.
  const claimed = await consumePluginAuthorizationCode(hashPluginSecret(code), input.now);
  if (!claimed) {
    await audit("token_exchange_rejected", null, { reason: "code_unclaimable" });
    throw pluginOAuthError("invalid_grant");
  }
  if (claimed.clientId !== client.clientId) {
    await audit("token_exchange_rejected", claimed.userId, { reason: "client_mismatch" });
    throw pluginOAuthError("invalid_grant");
  }
  if (claimed.redirectUri !== redirectUri) {
    await audit("token_exchange_rejected", claimed.userId, { reason: "redirect_mismatch" });
    throw pluginOAuthError("invalid_grant");
  }
  if (claimed.codeChallengeMethod !== "S256" || !verifyPkceS256({ codeVerifier, codeChallenge: claimed.codeChallenge })) {
    await audit("token_exchange_rejected", claimed.userId, { reason: "pkce_failed" });
    throw pluginOAuthError("invalid_grant");
  }

  await touchPluginAuthorizationLastUsed(claimed.authorizationId, input.now);
  const grant = await issueGrant({
    authorizationId: claimed.authorizationId,
    userId: claimed.userId,
    clientId: claimed.clientId,
    scope: claimed.scope,
    now: input.now,
  });
  await audit("token_issued", claimed.userId, { grant: "authorization_code", scope: claimed.scope });
  return grant;
}

export async function refreshPluginTokens(
  input: PluginTokenExchangeInput
): Promise<PluginTokenGrant> {
  const client = await authenticatePluginClient(input.clientAuth);
  const correlationId = `plg-${randomUUID()}`;
  const audit = (eventType: string, actorUserId: number | null, metadata: Record<string, unknown>) =>
    input.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType,
      actorUserId,
      clientId: client.clientId,
      correlationId,
      safeMetadata: JSON.stringify(metadata),
      createdAt: input.now.toISOString(),
    });

  if (input.body.grant_type !== "refresh_token") {
    throw pluginOAuthError("unsupported_grant_type");
  }
  const refreshToken = typeof input.body.refresh_token === "string" ? input.body.refresh_token : null;
  if (!refreshToken) throw pluginOAuthError("invalid_request");

  const stored = await findPluginRefreshTokenByHash(hashPluginSecret(refreshToken));
  if (!stored) {
    await audit("token_refresh_rejected", null, { reason: "unknown_refresh_token" });
    throw pluginOAuthError("invalid_grant");
  }
  if (stored.clientId !== client.clientId) {
    await audit("token_refresh_rejected", stored.userId, { reason: "client_mismatch" });
    throw pluginOAuthError("invalid_grant");
  }

  // The ENTIRE rotation is one serialized critical section: lock the refresh
  // row FOR UPDATE, re-check, rotate conditionally, and issue the successor
  // grant INSIDE the same transaction. A concurrent request presenting the
  // same token blocks on the row lock, then observes revokedAt set and runs
  // reuse detection against the COMMITTED family - which by then contains
  // the winner's fresh access+refresh pair, so the loser's grant-family
  // revocation kills the winner's new tokens too. No interleaving exists
  // where a winner's in-flight grant survives a detected reuse.
  const outcome = await runPluginTransaction(async tx => {
    const locked = await findPluginRefreshTokenByIdForUpdate(stored.id, tx);
    // The row cannot vanish (refresh grants have no delete path outside the
    // sweeper, and the sweeper only removes expired/rotated rows) - but a
    // null here must fail closed exactly like an unknown token.
    if (!locked) return { kind: "rejected" as const, actorUserId: null, reason: "unknown_refresh_token" };
    if (locked.clientId !== client.clientId) {
      return { kind: "rejected" as const, actorUserId: locked.userId, reason: "client_mismatch" };
    }
    // Reuse detection FIRST: a rotated-or-revoked token being presented
    // again is treated as a stolen grant - the whole (user, client) family
    // dies, including anything the winner issued moments ago.
    if (locked.revokedAt !== null) {
      await revokeAllTokensForAuthorization(locked.authorizationId, input.now, tx);
      return { kind: "reuse" as const, actorUserId: locked.userId, authorizationId: locked.authorizationId };
    }
    if (locked.expiresAt.getTime() <= input.now.getTime()) {
      return { kind: "expired" as const, actorUserId: locked.userId };
    }
    // Belt-and-braces conditional rotate under the lock: only the first
    // caller flips a live row, and the successor grant commits with it.
    const rotated = await revokePluginRefreshToken(locked.id, input.now, tx);
    if (!rotated) {
      await revokeAllTokensForAuthorization(locked.authorizationId, input.now, tx);
      return { kind: "reuse" as const, actorUserId: locked.userId, authorizationId: locked.authorizationId };
    }
    // Scope is inherited verbatim - a refresh can never broaden (or narrow) it.
    const grant = await issueGrant(
      {
        authorizationId: locked.authorizationId,
        userId: locked.userId,
        clientId: locked.clientId,
        scope: locked.scope,
        now: input.now,
      },
      tx
    );
    return { kind: "granted" as const, actorUserId: locked.userId, authorizationId: locked.authorizationId, grant };
  });

  switch (outcome.kind) {
    case "rejected":
      await audit("token_refresh_rejected", outcome.actorUserId, { reason: outcome.reason });
      throw pluginOAuthError("invalid_grant");
    case "expired":
      await audit("token_refresh_rejected", outcome.actorUserId, { reason: "refresh_expired" });
      throw pluginOAuthError("invalid_grant");
    case "reuse":
      await audit("refresh_reuse_detected", outcome.actorUserId, {
        authorizationId: outcome.authorizationId,
        action: "grant_family_revoked",
      });
      throw pluginOAuthError("invalid_grant");
    case "granted":
      await touchPluginAuthorizationLastUsed(outcome.authorizationId, input.now);
      await audit("token_refreshed", outcome.actorUserId, {
        authorizationId: outcome.authorizationId,
        scope: outcome.grant.scope,
      });
      return outcome.grant;
  }
}

export type PluginRevocationOutcome = { revoked: boolean };

export async function revokePluginToken(
  input: PluginTokenExchangeInput
): Promise<PluginRevocationOutcome> {
  const client = await authenticatePluginClient(input.clientAuth);
  const correlationId = `plg-${randomUUID()}`;
  const audit = (eventType: string, actorUserId: number | null, metadata: Record<string, unknown>) =>
    input.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType,
      actorUserId,
      clientId: client.clientId,
      correlationId,
      safeMetadata: JSON.stringify(metadata),
      createdAt: input.now.toISOString(),
    });

  const token = typeof input.body.token === "string" ? input.body.token : null;
  if (!token) throw pluginOAuthError("invalid_request");
  const tokenTypeHint = typeof input.body.token_type_hint === "string" ? input.body.token_type_hint : null;
  if (tokenTypeHint !== null && tokenTypeHint !== "access_token" && tokenTypeHint !== "refresh_token") {
    throw pluginOAuthError("unsupported_token_type");
  }

  // Try the hinted type first, then fall back to the other (RFC 7009 §2.1).
  const tokenHash = hashPluginSecret(token);
  const tryRefreshFirst = tokenTypeHint !== "access_token";
  if (tryRefreshFirst) {
    const stored = await findPluginRefreshTokenByHash(tokenHash);
    if (stored && stored.clientId === client.clientId) {
      // Refresh revocation kills the whole grant family (access + refresh) -
      // the conservative reading of RFC 7009 §2.1's SHOULD.
      await revokeAllTokensForAuthorization(stored.authorizationId, input.now);
      await audit("token_revoked", stored.userId, { kind: "refresh_token", authorizationId: stored.authorizationId });
      return { revoked: true };
    }
  }
  const access = await findAnyPluginAccessTokenByHash(tokenHash);
  if (access && access.clientId === client.clientId) {
    await revokePluginAccessToken(tokenHash, input.now);
    await audit("token_revoked", access.userId, { kind: "access_token" });
    return { revoked: true };
  }
  if (!tryRefreshFirst) {
    const stored = await findPluginRefreshTokenByHash(tokenHash);
    if (stored && stored.clientId === client.clientId) {
      await revokeAllTokensForAuthorization(stored.authorizationId, input.now);
      await audit("token_revoked", stored.userId, { kind: "refresh_token", authorizationId: stored.authorizationId });
      return { revoked: true };
    }
  }

  // RFC 7009 §2.2: an unknown/foreign token is still a 200 - revocation
  // must not confirm to a caller whether a token exists.
  await audit("token_revoked_noop", null, {});
  return { revoked: false };
}

async function findAnyPluginAccessTokenByHash(tokenHash: string): Promise<{ userId: number; clientId: string } | null> {
  const live = await findValidPluginAccessToken(tokenHash, new Date());
  if (live) return { userId: live.userId, clientId: live.clientId };
  // An expired or already-revoked token is still revocable (idempotent) -
  // look the row up without the validity gate so revoke stays a no-op
  // success rather than a silent miss.
  return findPluginAccessTokenOwnerByHash(tokenHash);
}

// ---------------------------------------------------------------------------
// Bearer authentication (MCP edge)
// ---------------------------------------------------------------------------

export type PluginBearerPrincipal = {
  tokenId: string;
  authorizationId: number;
  userId: number;
  clientId: string;
  scopes: readonly PluginPermissionScope[];
  authenticated: true;
};

/**
 * Resolves the Authorization: Bearer header to a live token principal.
 * Returns null for EVERY failure mode - missing header, wrong scheme,
 * unknown/forged value, expired, revoked, disabled client, deleted user -
 * all of which are the same "401, no details" outcome at the HTTP layer.
 * A session JWT (or any other JWT) presented here simply hashes to a
 * tokenHash that does not exist - opaque tokens give no oracle about WHY.
 */
export async function authenticatePluginBearer(
  authorizationHeader: unknown,
  now: Date
): Promise<PluginBearerPrincipal | null> {
  if (typeof authorizationHeader !== "string" || !authorizationHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authorizationHeader.slice(7).trim();
  if (token.length === 0 || token.length > 512) return null;
  const principal = await findValidPluginAccessToken(hashPluginSecret(token), now);
  if (!principal) return null;
  return {
    tokenId: principal.tokenId,
    authorizationId: principal.authorizationId,
    userId: principal.userId,
    clientId: principal.clientId,
    scopes: parsePluginScopes(principal.scope),
    authenticated: true,
  };
}
