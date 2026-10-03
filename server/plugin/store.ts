import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  novels,
  pluginAccessGrants,
  pluginAuditLogs,
  pluginOAuthAuthorizationCodes,
  pluginOAuthAuthorizations,
  pluginOAuthClients,
  pluginOAuthConsentAttempts,
  pluginRefreshGrants,
  users,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceMembers,
  workspaceNovels,
  workspaceWorkspaces,
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
        gt(pluginOAuthAuthorizationCodes.expiresAt, now)
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

// ---------------------------------------------------------------------------
// IPE-PLUGIN-001C tenant read surface.
//
// The server-side tenant boundary: EVERY query below derives visibility from
// the token's bound users.id via workspaceWorkspaces.ownerUserId OR an
// active workspaceMembers row, and carries that predicate INSIDE its WHERE
// (never a separate check-then-read), so a membership revoked mid-flight is
// reflected on the very next call. Visibility mirrors the app's own read
// models exactly: workspace must be status='active' AND deletedAt IS NULL;
// workspaceNovels must be status='active'; packs are
// workspaceEditorialWorkItems (new_episode + package saleMode) whose kanban
// card is 'active' on the workspace's 'editorial' board (status='active');
// chapters are the tabs of the LATEST draft version of the pack. Cross-
// tenant ids simply match no row (NOT_FOUND at the tool layer) - there is
// no existence oracle. Tables are read straight from drizzle/schema (no
// server/workspace/* import - enforced by the isolation static test).
// ---------------------------------------------------------------------------

/** Owner-or-active-member + active + not-soft-deleted workspace predicate. */
function pluginWorkspaceVisibleCondition(userId: number) {
  // The membership arm is a self-contained EXISTS (never a join reference):
  // this predicate is reused on queries that do not carry a workspaceMembers
  // join, so it must be valid on its own anywhere workspaceWorkspaces is.
  return and(
    eq(workspaceWorkspaces.status, "active"),
    isNull(workspaceWorkspaces.deletedAt),
    or(
      eq(workspaceWorkspaces.ownerUserId, userId),
      sql`exists (
        select 1 from ${workspaceMembers} visibleMembership
        where visibleMembership.workspaceId = ${workspaceWorkspaces.id}
          and visibleMembership.userId = ${userId}
          and visibleMembership.status = 'active'
      )`
    )
  );
}

export type PluginVisibleWorkspace = {
  workspaceId: number;
  name: string;
  ownerUserId: number;
  /** Effective read role: the member row's role, or "owner" for the owner. */
  viewerRole: "owner" | "editor" | "reviewer" | "viewer";
};

const pluginWorkspaceSelection = {
  workspaceId: workspaceWorkspaces.id,
  name: workspaceWorkspaces.name,
  ownerUserId: workspaceWorkspaces.ownerUserId,
  memberRole: workspaceMembers.role,
};

function pluginWorkspaceRow(row: {
  workspaceId: number;
  name: string;
  ownerUserId: number;
  memberRole: "owner" | "editor" | "reviewer" | "viewer" | null;
}): PluginVisibleWorkspace {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    ownerUserId: row.ownerUserId,
    viewerRole: row.memberRole ?? "owner",
  };
}

export async function listPluginVisibleWorkspaces(
  userId: number
): Promise<PluginVisibleWorkspace[]> {
  const db = await requirePluginDb();
  const rows = await db
    .select(pluginWorkspaceSelection)
    .from(workspaceWorkspaces)
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaceWorkspaces.id),
        eq(workspaceMembers.userId, userId)
      )
    )
    .where(pluginWorkspaceVisibleCondition(userId))
    .orderBy(workspaceWorkspaces.id);
  return rows.map(pluginWorkspaceRow);
}

export async function findPluginVisibleWorkspace(
  workspaceId: number,
  userId: number
): Promise<PluginVisibleWorkspace | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select(pluginWorkspaceSelection)
    .from(workspaceWorkspaces)
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaceWorkspaces.id),
        eq(workspaceMembers.userId, userId)
      )
    )
    .where(and(eq(workspaceWorkspaces.id, workspaceId), pluginWorkspaceVisibleCondition(userId)))
    .limit(1);
  return rows[0] ? pluginWorkspaceRow(rows[0]) : null;
}

export type PluginWorkspaceNovel = {
  workspaceNovelId: number;
  novelId: number;
  title: string;
  slug: string;
  publicationStatus: "published" | "archived";
  storyStatus: "ongoing" | "finished";
};

const pluginNovelSelection = {
  workspaceNovelId: workspaceNovels.id,
  novelId: novels.id,
  title: novels.title,
  slug: novels.slug,
  publicationStatus: novels.publicationStatus,
  storyStatus: novels.storyStatus,
};

function pluginNovelCondition(workspaceId: number, userId: number) {
  // Tenancy rides on the workspaceWorkspaces join above; the WHERE only
  // narrows the resource itself.
  return and(
    eq(workspaceNovels.workspaceId, workspaceId),
    eq(workspaceNovels.status, "active"),
    eq(workspaceWorkspaces.id, workspaceId),
    pluginWorkspaceVisibleCondition(userId)
  );
}

export async function listPluginWorkspaceNovels(
  workspaceId: number,
  userId: number
): Promise<PluginWorkspaceNovel[]> {
  const db = await requirePluginDb();
  return await db
    .select(pluginNovelSelection)
    .from(workspaceNovels)
    .innerJoin(
      workspaceWorkspaces,
      and(
        eq(workspaceWorkspaces.id, workspaceNovels.workspaceId),
        pluginWorkspaceVisibleCondition(userId)
      )
    )
    .innerJoin(novels, eq(novels.id, workspaceNovels.novelId))
    .where(pluginNovelCondition(workspaceId, userId))
    .orderBy(workspaceNovels.id);
}

export async function findPluginWorkspaceNovel(
  workspaceId: number,
  novelId: number,
  userId: number
): Promise<PluginWorkspaceNovel | null> {
  const db = await requirePluginDb();
  const rows = await db
    .select(pluginNovelSelection)
    .from(workspaceNovels)
    .innerJoin(
      workspaceWorkspaces,
      and(
        eq(workspaceWorkspaces.id, workspaceNovels.workspaceId),
        pluginWorkspaceVisibleCondition(userId)
      )
    )
    .innerJoin(novels, eq(novels.id, workspaceNovels.novelId))
    .where(and(pluginNovelCondition(workspaceId, userId), eq(workspaceNovels.novelId, novelId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Editorial episode pack = new_episode work item with package saleMode. */
function pluginPackCondition() {
  return and(
    eq(workspaceEditorialWorkItems.workItemType, "new_episode"),
    eq(workspaceEditorialWorkItems.saleMode, "package"),
    eq(workspaceKanbanCards.status, "active"),
    eq(workspaceKanbanBoards.slug, "editorial"),
    eq(workspaceKanbanBoards.status, "active")
  );
}

export type PluginWorkspacePack = {
  packId: number;
  workspaceNovelId: number;
  novelId: number;
  itemKey: string;
  episodeNumber: string | null;
  episodeTitle: string | null;
  price: string | null;
  isFree: boolean | null;
  /** Kanban column key of the pack card (new/pending_check/... workflow stage). */
  stage: string | null;
};

const pluginPackSelection = {
  packId: workspaceEditorialWorkItems.id,
  workspaceNovelId: workspaceEditorialWorkItems.workspaceNovelId,
  novelId: novels.id,
  itemKey: workspaceEditorialWorkItems.itemKey,
  episodeNumber: workspaceEditorialWorkItems.episodeNumber,
  episodeTitle: workspaceEditorialWorkItems.episodeTitle,
  price: workspaceEditorialWorkItems.price,
  isFree: workspaceEditorialWorkItems.isFree,
  stage: workspaceKanbanColumns.key,
};

type PluginDb = Awaited<ReturnType<typeof requirePluginDb>>;

function pluginPackQuery(db: PluginDb, userId: number) {
  return db
    .select(pluginPackSelection)
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceNovels, eq(workspaceNovels.id, workspaceEditorialWorkItems.workspaceNovelId))
    .innerJoin(novels, eq(novels.id, workspaceNovels.novelId))
    .innerJoin(workspaceKanbanCards, eq(workspaceKanbanCards.id, workspaceEditorialWorkItems.cardId))
    .innerJoin(
      workspaceKanbanBoards,
      and(
        eq(workspaceKanbanBoards.id, workspaceKanbanCards.boardId),
        eq(workspaceKanbanBoards.workspaceId, workspaceNovels.workspaceId)
      )
    )
    .leftJoin(workspaceKanbanColumns, eq(workspaceKanbanColumns.id, workspaceKanbanCards.columnId))
    .innerJoin(
      workspaceWorkspaces,
      and(
        eq(workspaceWorkspaces.id, workspaceNovels.workspaceId),
        pluginWorkspaceVisibleCondition(userId)
      )
    );
}

export async function listPluginWorkspacePacks(
  workspaceId: number,
  userId: number
): Promise<PluginWorkspacePack[]> {
  const db = await requirePluginDb();
  return await pluginPackQuery(db, userId)
    .where(
      and(
        eq(workspaceNovels.workspaceId, workspaceId),
        pluginPackCondition()
      )
    )
    .orderBy(workspaceEditorialWorkItems.id);
}

export async function findPluginWorkspacePack(
  workspaceId: number,
  packId: number,
  userId: number
): Promise<PluginWorkspacePack | null> {
  const db = await requirePluginDb();
  const rows = await pluginPackQuery(db, userId)
    .where(
      and(
        eq(workspaceNovels.workspaceId, workspaceId),
        eq(workspaceEditorialWorkItems.id, packId),
        pluginPackCondition()
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export type PluginPackChapter = {
  chapterId: number;
  packId: number;
  sourceTabId: string;
  tabOrder: number;
  title: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
};

const pluginChapterSelection = {
  chapterId: workspaceEditorialDraftTabs.id,
  packId: workspaceEditorialDrafts.workItemId,
  sourceTabId: workspaceEditorialDraftTabs.sourceTabId,
  tabOrder: workspaceEditorialDraftTabs.tabOrder,
  title: workspaceEditorialDraftTabs.title,
  chapterNumber: workspaceEditorialDraftTabs.chapterNumber,
  chapterTitle: workspaceEditorialDraftTabs.chapterTitle,
};

/**
 * Chapter tabs of the LATEST draft version of one visible pack. The pack's
 * own tenancy predicate is joined INSIDE these queries, so a stale/foreign
 * packId or chapterId matches no rows at all. (The latest-version and pack
 * predicates are applied by each caller's WHERE - drizzle allows only one
 * where() per builder.)
 */
function pluginChapterQuery(db: PluginDb, userId: number) {
  return db    .select(pluginChapterSelection)
    .from(workspaceEditorialDraftTabs)
    .innerJoin(
      workspaceEditorialDrafts,
      eq(workspaceEditorialDrafts.id, workspaceEditorialDraftTabs.draftId)
    )
    .innerJoin(
      workspaceEditorialWorkItems,
      eq(workspaceEditorialWorkItems.id, workspaceEditorialDrafts.workItemId)
    )
    .innerJoin(workspaceNovels, eq(workspaceNovels.id, workspaceEditorialWorkItems.workspaceNovelId))
    .innerJoin(workspaceKanbanCards, eq(workspaceKanbanCards.id, workspaceEditorialWorkItems.cardId))
    .innerJoin(
      workspaceKanbanBoards,
      and(
        eq(workspaceKanbanBoards.id, workspaceKanbanCards.boardId),
        eq(workspaceKanbanBoards.workspaceId, workspaceNovels.workspaceId)
      )
    )
    .innerJoin(
      workspaceWorkspaces,
      and(
        eq(workspaceWorkspaces.id, workspaceKanbanBoards.workspaceId),
        pluginWorkspaceVisibleCondition(userId)
      )
    );
}

export async function listPluginPackChapters(
  workspaceId: number,
  packId: number,
  userId: number
): Promise<PluginPackChapter[]> {
  const db = await requirePluginDb();
  const latestDraftVersion = sql`(
    select max(latestVersions.version) from ${workspaceEditorialDrafts} latestVersions
    where latestVersions.workItemId = ${workspaceEditorialDrafts.workItemId}
  )`;
  return await pluginChapterQuery(db, userId)
    .where(
      and(
        eq(workspaceWorkspaces.id, workspaceId),
        eq(workspaceEditorialWorkItems.id, packId),
        pluginPackCondition(),
        eq(workspaceEditorialDrafts.version, latestDraftVersion)
      )
    )
    .orderBy(workspaceEditorialDraftTabs.tabOrder);
}

export async function findPluginPackChapter(
  workspaceId: number,
  chapterId: number,
  userId: number
): Promise<PluginPackChapter | null> {
  const db = await requirePluginDb();
  const latestDraftVersion = sql`(
    select max(latestVersions.version) from ${workspaceEditorialDrafts} latestVersions
    where latestVersions.workItemId = ${workspaceEditorialDrafts.workItemId}
  )`;
  const rows = await pluginChapterQuery(db, userId)
    .where(
      and(
        eq(workspaceWorkspaces.id, workspaceId),
        eq(workspaceEditorialDraftTabs.id, chapterId),
        pluginPackCondition(),
        eq(workspaceEditorialDrafts.version, latestDraftVersion)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
