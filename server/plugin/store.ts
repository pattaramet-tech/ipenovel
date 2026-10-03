import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  pluginAccessGrants,
  pluginAuditLogs,
  pluginOAuthAuthorizationCodes,
  pluginOAuthAuthorizations,
  pluginOAuthClients,
  pluginOAuthConsentAttempts,
  pluginRefreshGrants,
  users,
  type PluginOAuthAuthorization,
  type PluginOAuthClient,
  type PluginRefreshGrant,
} from "../../drizzle/schema";
import { assertAccountMergeClassifiedMutationAllowed, assertDatabaseAvailable, getDb } from "../db";

// Drizzle's mysql2 driver returns [ResultSetHeader, FieldPacket[]] for
// UPDATE/DELETE - the repo-wide extraction (see server/db.ts wallet claim).
function affectedRowCount(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

/**
 * The one connection gate for the whole plugin namespace: availability is
 * asserted (an outage propagates as a real infrastructure error, never as
 * "not found") and the null case collapses into the same fixed error.
 */
async function requirePluginDb() {
  await assertDatabaseAvailable();
  const db = await getDb();
  if (!db) {
    throw new Error("[plugin] Database is not available");
  }
  return db;
}

// IPE-PLUGIN-001B data access for the isolated plugin namespace.
//
// Every function takes an explicit `now: Date` so flow logic is fully
// deterministic under test (no hidden Date.now()). Connection resolution
// goes through server/db.ts's getDb() singleton, exactly like every other
// server feature, so the integration project's __setDbForTests override
// (applied by vitest.integration.globalsetup.ts AND the per-worker setup
// file) covers these queries too - a new connection singleton here would
// silently bypass that override and read/write the wrong database.

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function findActivePluginOAuthClient(
  clientId: string
): Promise<PluginOAuthClient | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select()
    .from(pluginOAuthClients)
    .where(and(eq(pluginOAuthClients.clientId, clientId), eq(pluginOAuthClients.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPluginOAuthClient(clientId: string): Promise<PluginOAuthClient | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select()
    .from(pluginOAuthClients)
    .where(eq(pluginOAuthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Consent attempts (one in-flight authorize request)
// ---------------------------------------------------------------------------

export type InsertPluginConsentAttempt = {
  userId: number;
  stateHash: string;
  csrfTokenHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
};

export async function createPluginConsentAttempt(
  input: InsertPluginConsentAttempt
): Promise<void> {
  const db = await requirePluginDb();
  await assertAccountMergeClassifiedMutationAllowed(input.userId, db);
  await db.insert(pluginOAuthConsentAttempts).values(input);
}

export async function findPluginConsentAttemptByStateHash(
  stateHash: string
): Promise<{ stateHash: string; userId: number; clientId: string; redirectUri: string; scope: string; codeChallenge: string; codeChallengeMethod: string; csrfTokenHash: string; expiresAt: Date; consumedAt: Date | null } | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select({
      stateHash: pluginOAuthConsentAttempts.stateHash,
      userId: pluginOAuthConsentAttempts.userId,
      clientId: pluginOAuthConsentAttempts.clientId,
      redirectUri: pluginOAuthConsentAttempts.redirectUri,
      scope: pluginOAuthConsentAttempts.scope,
      codeChallenge: pluginOAuthConsentAttempts.codeChallenge,
      codeChallengeMethod: pluginOAuthConsentAttempts.codeChallengeMethod,
      csrfTokenHash: pluginOAuthConsentAttempts.csrfTokenHash,
      expiresAt: pluginOAuthConsentAttempts.expiresAt,
      consumedAt: pluginOAuthConsentAttempts.consumedAt,
    })
    .from(pluginOAuthConsentAttempts)
    .where(eq(pluginOAuthConsentAttempts.stateHash, stateHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Single-use: a consumed attempt can never be read back as consumable. */
export async function consumePluginConsentAttempt(stateHash: string): Promise<void> {
  const db = await requirePluginDb();
  await db
    .update(pluginOAuthConsentAttempts)
    .set({ consumedAt: new Date() })
    .where(eq(pluginOAuthConsentAttempts.stateHash, stateHash));
}

// ---------------------------------------------------------------------------
// Authorizations ((user, client) consent records)
// ---------------------------------------------------------------------------

export async function findActivePluginAuthorization(
  userId: number,
  clientId: string
): Promise<PluginOAuthAuthorization | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select()
    .from(pluginOAuthAuthorizations)
    .where(
      and(
        eq(pluginOAuthAuthorizations.userId, userId),
        eq(pluginOAuthAuthorizations.clientId, clientId),
        eq(pluginOAuthAuthorizations.status, "active")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Finds the active (user, client) authorization or creates one whose scope
 * is exactly `scope`. Deliberately NO scope narrowing here: an existing
 * authorization whose granted scope does not already cover the request
 * makes this return null and the caller fails closed with invalid_scope -
 * widening happens only through a NEW explicit consent approval flow (see
 * oauth/service.ts upsertPluginAuthorizationScope), never silently.
 */
export async function findPluginAuthorizationWithScopes(
  userId: number,
  clientId: string,
  scope: string
): Promise<PluginOAuthAuthorization | null> {
  const existing = await findActivePluginAuthorization(userId, clientId);
  if (!existing) return null;
  const granted = new Set(existing.scope.split(/\s+/).filter(Boolean));
  const requested = scope.split(/\s+/).filter(Boolean);
  for (const item of requested) {
    if (!granted.has(item)) return null;
  }
  return existing;
}

/** Called after an explicit consent approval - may widen scope (new consent). */
export async function upsertPluginAuthorizationScope(input: {
  userId: number;
  clientId: string;
  scope: string;
  now: Date;
}): Promise<PluginOAuthAuthorization> {
  const db = await requirePluginDb();
  await assertAccountMergeClassifiedMutationAllowed(input.userId, db);
  const existing = await findActivePluginAuthorization(input.userId, input.clientId);
  if (existing) {
    const granted = new Set(existing.scope.split(/\s+/).filter(Boolean));
    for (const item of input.scope.split(/\s+/).filter(Boolean)) granted.add(item);
    const merged = Array.from(granted).sort().join(" ");
    await db
      .update(pluginOAuthAuthorizations)
      .set({ scope: merged, lastUsedAt: input.now })
      .where(eq(pluginOAuthAuthorizations.id, existing.id));
    const updated = await findActivePluginAuthorization(input.userId, input.clientId);
    if (!updated) throw new Error("[plugin] authorization vanished during scope upsert");
    return updated;
  }
  // MySQL drizzle has no .returning() - read the auto id from the insert
  // result header (same extraction fixtures.ts uses) and select the row.
  const result = await db
    .insert(pluginOAuthAuthorizations)
    .values({
      userId: input.userId,
      clientId: input.clientId,
      scope: input.scope,
      lastUsedAt: input.now,
    });
  const header = Array.isArray(result) ? result[0] : result;
  const insertId = (header as { insertId?: number } | undefined)?.insertId;
  if (!insertId) throw new Error("[plugin] failed to read authorization insert id");
  const rows = await db
    .select()
    .from(pluginOAuthAuthorizations)
    .where(eq(pluginOAuthAuthorizations.id, insertId))
    .limit(1);
  if (!rows[0]) throw new Error("[plugin] authorization vanished after insert");
  return rows[0];
}

export async function touchPluginAuthorizationLastUsed(
  authorizationId: number,
  now: Date
): Promise<void> {
  const db = await requirePluginDb();
  await db
    .update(pluginOAuthAuthorizations)
    .set({ lastUsedAt: now })
    .where(eq(pluginOAuthAuthorizations.id, authorizationId));
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export type InsertPluginAuthorizationCode = {
  codeHash: string;
  authorizationId: number;
  userId: number;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
};

export async function createPluginAuthorizationCode(
  input: InsertPluginAuthorizationCode
): Promise<void> {
  const db = await requirePluginDb();
  await assertAccountMergeClassifiedMutationAllowed(input.userId, db);
  await db.insert(pluginOAuthAuthorizationCodes).values(input);
}

export type ConsumedPluginAuthorizationCode = {
  id: number;
  authorizationId: number;
  userId: number;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
};

/**
 * Atomically claims a code: only ONE caller ever gets it. The conditional
 * UPDATE (consumedAt IS NULL AND expiresAt > now) is raced by MySQL's row
 * lock - the losing caller's UPDATE matches zero rows and fails closed
 * with null. Expired codes are also rejected here, in the same atomic step.
 */
export async function consumePluginAuthorizationCode(
  codeHash: string,
  now: Date
): Promise<ConsumedPluginAuthorizationCode | null> {
  const db = await requirePluginDb();
  const claimed = await db
    .update(pluginOAuthAuthorizationCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(pluginOAuthAuthorizationCodes.codeHash, codeHash),
        isNull(pluginOAuthAuthorizationCodes.consumedAt),
        sql`${pluginOAuthAuthorizationCodes.expiresAt} > ${now}`
      )
    )
    .limit(1);
  if (affectedRowCount(claimed) !== 1) {
    return null;
  }
  const rows = await db
    .select({
      id: pluginOAuthAuthorizationCodes.id,
      authorizationId: pluginOAuthAuthorizationCodes.authorizationId,
      userId: pluginOAuthAuthorizationCodes.userId,
      clientId: pluginOAuthAuthorizationCodes.clientId,
      redirectUri: pluginOAuthAuthorizationCodes.redirectUri,
      scope: pluginOAuthAuthorizationCodes.scope,
      codeChallenge: pluginOAuthAuthorizationCodes.codeChallenge,
      codeChallengeMethod: pluginOAuthAuthorizationCodes.codeChallengeMethod,
    })
    .from(pluginOAuthAuthorizationCodes)
    .where(eq(pluginOAuthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Access + refresh tokens
// ---------------------------------------------------------------------------

export type InsertPluginAccessToken = {
  tokenHash: string;
  authorizationId: number;
  userId: number;
  clientId: string;
  scope: string;
  expiresAt: Date;
};

export type InsertPluginRefreshToken = InsertPluginAccessToken & { rotatedAt?: Date };

export async function createPluginAccessToken(input: InsertPluginAccessToken): Promise<void> {
  const db = await requirePluginDb();
  await assertAccountMergeClassifiedMutationAllowed(input.userId, db);
  await db.insert(pluginAccessGrants).values(input);
}

export async function createPluginRefreshToken(input: InsertPluginRefreshToken): Promise<void> {
  const db = await requirePluginDb();
  await assertAccountMergeClassifiedMutationAllowed(input.userId, db);
  await db.insert(pluginRefreshGrants).values(input);
}

export type ValidPluginAccessToken = {
  tokenId: string;
  authorizationId: number;
  userId: number;
  clientId: string;
  scope: string;
  userExists: boolean;
};

/**
 * Resolves a bearer token hash to its live grant - joins users so a deleted
 * user's orphaned token can never authenticate, and joins the client so a
 * client disabled AFTER token issuance stops working immediately.
 */
export async function findValidPluginAccessToken(
  tokenHash: string,
  now: Date
): Promise<ValidPluginAccessToken | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select({
      tokenId: pluginAccessGrants.tokenHash,
      authorizationId: pluginAccessGrants.authorizationId,
      userId: pluginAccessGrants.userId,
      clientId: pluginAccessGrants.clientId,
      scope: pluginAccessGrants.scope,
      revokedAt: pluginAccessGrants.revokedAt,
      expiresAt: pluginAccessGrants.expiresAt,
      userOpenId: users.openId,
      clientStatus: pluginOAuthClients.status,
    })
    .from(pluginAccessGrants)
    .innerJoin(users, eq(users.id, pluginAccessGrants.userId))
    .leftJoin(
      pluginOAuthClients,
      eq(pluginOAuthClients.clientId, pluginAccessGrants.clientId)
    )
    .where(eq(pluginAccessGrants.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.userOpenId) return null;
  if (row.clientStatus !== "active") return null;
  return {
    tokenId: row.tokenId,
    authorizationId: row.authorizationId,
    userId: row.userId,
    clientId: row.clientId,
    scope: row.scope,
    userExists: true,
  };
}

export async function findPluginRefreshTokenByHash(
  tokenHash: string
): Promise<PluginRefreshGrant | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select()
    .from(pluginRefreshGrants)
    .where(eq(pluginRefreshGrants.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Revokes exactly one refresh token; returns true only for the first revoker. */
export async function revokePluginRefreshToken(
  id: number,
  now: Date
): Promise<boolean> {
  const db = await requirePluginDb();
  const result = await db
    .update(pluginRefreshGrants)
    .set({ revokedAt: now })
    .where(and(eq(pluginRefreshGrants.id, id), isNull(pluginRefreshGrants.revokedAt)))
    .limit(1);
  return affectedRowCount(result) === 1;
}

export async function revokePluginAccessToken(
  tokenHash: string,
  now: Date
): Promise<void> {
  const db = await requirePluginDb();
  await db
    .update(pluginAccessGrants)
    .set({ revokedAt: now })
    .where(and(eq(pluginAccessGrants.tokenHash, tokenHash), isNull(pluginAccessGrants.revokedAt)));
}

/**
 * Grant-family revocation: every access + refresh token under one
 * authorization stops working. Used by refresh-reuse detection (a replayed
 * rotated token is treated as a stolen grant) and by RFC 7009 refresh
 * revocation.
 */
export async function revokeAllTokensForAuthorization(
  authorizationId: number,
  now: Date
): Promise<void> {
  const db = await requirePluginDb();
  await db
    .update(pluginAccessGrants)
    .set({ revokedAt: now })
    .where(
      and(eq(pluginAccessGrants.authorizationId, authorizationId), isNull(pluginAccessGrants.revokedAt))
    );
  await db
    .update(pluginRefreshGrants)
    .set({ revokedAt: now })
    .where(
      and(eq(pluginRefreshGrants.authorizationId, authorizationId), isNull(pluginRefreshGrants.revokedAt))
    );
}

// ---------------------------------------------------------------------------
// Audit + hygiene
// ---------------------------------------------------------------------------

export async function insertPluginAuditLog(input: {
  eventType: string;
  actorUserId: number | null;
  clientId: string | null;
  correlationId: string;
  safeMetadata: string;
  createdAt: Date;
}): Promise<void> {
  const db = await requirePluginDb();
  await db.insert(pluginAuditLogs).values(input);
}

/** Minimal identity display fields for identity.whoami - nothing else. */
export async function findPluginUserDisplay(
  userId: number
): Promise<{ name: string | null; role: "user" | "admin" } | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select({ name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Any access-token row by hash (no validity gate) - RFC 7009 revoke support. */
export async function findPluginAccessTokenOwnerByHash(
  tokenHash: string
): Promise<{ userId: number; clientId: string } | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select({ userId: pluginAccessGrants.userId, clientId: pluginAccessGrants.clientId })
    .from(pluginAccessGrants)
    .where(eq(pluginAccessGrants.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export type PluginSweepResult = {
  expiredCodes: number;
  expiredConsentAttempts: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
};

/**
 * Deletes expired one-time artifacts and expired (non-revoked) tokens.
 * Revoked rows are kept for their audit value until expiry, then swept.
 */
export async function deleteExpiredPluginAuthArtifacts(now: Date): Promise<PluginSweepResult> {
  const db = await requirePluginDb();
  const expiredCodes = await db
    .delete(pluginOAuthAuthorizationCodes)
    .where(lt(pluginOAuthAuthorizationCodes.expiresAt, now));
  const expiredConsentAttempts = await db
    .delete(pluginOAuthConsentAttempts)
    .where(lt(pluginOAuthConsentAttempts.expiresAt, now));
  const expiredAccessTokens = await db
    .delete(pluginAccessGrants)
    .where(lt(pluginAccessGrants.expiresAt, now));
  const expiredRefreshTokens = await db
    .delete(pluginRefreshGrants)
    .where(
      or(
        lt(pluginRefreshGrants.expiresAt, now),
        and(sql`${pluginRefreshGrants.rotatedAt} IS NOT NULL`, lt(pluginRefreshGrants.rotatedAt, now))
      )
    );
  return {
    expiredCodes: affectedRowCount(expiredCodes),
    expiredConsentAttempts: affectedRowCount(expiredConsentAttempts),
    expiredAccessTokens: affectedRowCount(expiredAccessTokens),
    expiredRefreshTokens: affectedRowCount(expiredRefreshTokens),
  };
}
