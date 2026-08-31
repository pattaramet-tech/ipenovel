import { createHash } from "node:crypto";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hasStrongIdentifier,
} from "./services/slipIdentifierService";
import { claimSlip, describeClaimFailure } from "./services/slipClaimService";
import { computeSlipFileHash } from "./services/slipFileHashService";
import { fileHashFromExtractedData } from "./services/legacySlipCompatibilityService";
import { eq, and, or, desc, asc, inArray, isNull, isNotNull, gte, lte, count, sql, gt, lt, ne, like } from "drizzle-orm";

/**
 * Raised when a wallet top-up cannot claim its slip's strong identifiers.
 *
 * Carries a stable `code` so callers can map it to an admin-facing message
 * (SLIP_ALREADY_CLAIMED / NO_STRONG_IDENTIFIER) without string-matching, and
 * so an anti-replay refusal is never confused with a database fault.
 */
export class WalletSlipClaimError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WalletSlipClaimError";
    this.code = code;
  }
}
import { alias } from "drizzle-orm/mysql-core";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  authIdentities,
  novels,
  episodes,
  episodePurchases,
  readingProgress,
  categories,
  novelCategories,
  carts,
  cartItems,
  orders,
  orderItems,
  payments,
  purchases,
  coupons,
  couponUsages,
  pointsTransactions,
  wishlists,
  banners,
  settings,
  orderHistory,
  walletAccounts,
  walletTransactions,
  walletTopups,
  topupLogs,
  sportsCompetitions,
  sportsTeams,
  sportsCompetitionTeams,
  sportsMatches,
  sportsMatchVotes,
  sportsMatchRewards,
  dailyCheckins,
  dailyCheckinCampaigns,
  dailyCheckinRewardGrants,
  accountRecoveryRequests,
  accountRecoveryAuditLogs,
  accountMergeCases,
  accountMergeAuditLogs,
  accountMergeFinancialReconciliations,
  accountMergeDataReconciliations,
  adminUserAuditLogs,
  paymentSlipClaims,
  Novel,
  couponUsages as couponUsagesTable,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { pickRandom } from "./utils/random";
import { getBangkokBusinessDate, getNextBangkokDayStart, getPreviousBangkokBusinessDate } from "./_core/timezone";
import { getEffectiveDailyCheckinConfig } from "./_core/dailyCheckinConfig";
import { isDuplicateKeyError } from "./helpers/databaseErrorClassifier";
import { safeErrorSummary } from "../scripts/lib/safeErrorSummary.mjs";
import { formatMoney, moneyAdd } from "./helpers/moneyNormalizer";
import {
  resolveDailyCheckinRuntimeMode,
  type DailyCheckinRuntimeMode,
} from "./services/dailyCheckinRewardModeService";
import {
  buildSportsMatchCatalogView,
  normalizeSportsCatalogCode,
  resolveSportsTeamReference,
  validateSportsRewardConfig,
  type SportsRewardKind,
  type SportsTeamLookup,
} from "./services/sportsVoteDomain";

/**
 * referenceType for a Daily Check-in point reward in the pointsTransactions
 * ledger. 13 characters, comfortably inside varchar(50), and consistent with
 * the existing snake_case conventions ("order", "sports_vote"). Combined with
 * referenceId = dailyCheckins.id it traces a ledger row back to the exact
 * check-in that produced it, and it is indexed by
 * pointsTransactions_referenceType_referenceId_idx.
 */
export const DAILY_CHECKIN_POINTS_REFERENCE_TYPE = "daily_checkin";

let _db: ReturnType<typeof drizzle> | null = null;

// Test-only dependency-injection hook - lets integration test setup point
// every production function in this file (claimDailyCheckin,
// validateAndApplyCoupon's callers, etc.) at a real TEST_DATABASE_URL
// connection without getDb() ever reading or writing process.env.DATABASE_URL.
// This exists specifically so vitest.integration.globalsetup.ts can satisfy
// "no test/reset/seed/cleanup/migration command may touch DATABASE_URL"
// while still exercising real production code paths against a real
// database, rather than reimplementing business logic in test files. See
// docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md. Never called by production code -
// grep confirms the only callers are test setup/teardown.
let _dbOverrideForTests: ReturnType<typeof drizzle> | null = null;

export function __setDbForTests(db: ReturnType<typeof drizzle> | null): void {
  _dbOverrideForTests = db;
}

export async function getDb() {
  if (_dbOverrideForTests) return _dbOverrideForTests;
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", safeErrorSummary(error));
      _db = null;
    }
  }
  return _db;
}

/**
 * Throws a plain, sanitized Error when the database connection is
 * unavailable (DATABASE_URL unset, or the drizzle client failed to
 * initialize) - never DATABASE_URL, host, username, or password, and never
 * an AnonymousCredentialError. A database outage is an infrastructure
 * failure, not "no session" or "invalid credentials" - callers in
 * server/_core/sdk.ts's authenticateRequest and server/_core/oauth.ts's
 * OAuth callback all call this before any user lookup so an outage
 * propagates as a real error instead of being silently misread as "no such
 * user" (every *Db lookup function in this file already returns
 * undefined/null when the database is unavailable - that fallback is
 * intentionally left unchanged for their many other, non-auth callers).
 */
export async function assertDatabaseAvailable(): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("[Database] Database connection is not available");
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", safeErrorSummary(error));
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * `tx` is an optional in-flight transaction executor (see
 * server/services/googleIdentityService.ts's resolveGoogleIdentity) - when
 * provided, the read runs on that SAME connection/transaction instead of a
 * fresh pooled one, so it can see rows the transaction itself has written
 * but not yet committed. Every existing call site passes only `userId`, so
 * this is fully backward compatible.
 */
export async function getUserById(userId: number, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/** Exact-match email lookup, any role - used by the admin coupon-owner
 *  picker (admin.coupons.findUserByEmail) to find a candidate user by the
 *  email an admin already knows, before ownerUserId is independently
 *  re-verified server-side at create/update time. */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============ GOOGLE OAUTH / AUTH IDENTITIES ============
// Backs the Google OpenID Connect login/connect feature flag - active
// whenever AUTH_PROVIDER is exactly "google" (full cutover) or "transition"
// (both Manus and Google active together, plus explicit account-connect -
// see server/_core/env.ts's isGoogleAuthActive()). See
// server/services/googleIdentityService.ts for the account-linking policy
// these are composed into (both the login flow's resolveGoogleIdentity and
// the connect flow's connectGoogleIdentityToUser), and drizzle/schema.ts's
// authIdentities table doc comment for the schema rationale. Every function
// below accepts an optional `tx` (an in-flight transaction executor) so
// resolveGoogleIdentity/connectGoogleIdentityToUser can each run their
// entire decision as one atomic transaction - matching the
// `const db = tx || await getDb();` composability pattern already used
// throughout this file (see e.g. approveWalletTopup and its callees).

/** Looks up a linked identity by (provider, providerSubject) - the unique
 *  index authIdentities_provider_providerSubject_unique backs this query
 *  and is resolveGoogleIdentity's first, authoritative check ("has this
 *  exact external account already been linked to someone"). */
export async function getAuthIdentity(provider: string, providerSubject: string, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return undefined;
  const result = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerSubject, providerSubject)))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Looks up whatever identity a GIVEN user already has for a provider - the
 * `authIdentities_userId_provider_unique` index (one identity per provider
 * per user) backs this query. Used by the explicit Google-connect flow
 * (server/services/googleIdentityService.ts's connectGoogleIdentityToUser)
 * to detect "this account already has a DIFFERENT Google identity linked"
 * (conflict case D) before attempting to insert a second one - a case the
 * unique index would also catch at INSERT time, but pre-checking lets the
 * caller return a precise, distinguishable outcome instead of an opaque
 * duplicate-key error.
 */
export async function getAuthIdentityByUserAndProvider(userId: number, provider: string, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return undefined;
  const result = await db
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, provider)))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Finds every existing user whose stored email matches `normalizedEmail`
 * case-insensitively, regardless of how that email happens to be cased in
 * the database today. `normalizedEmail` must already be trim()med and
 * lowercased by the caller (see googleIdentityService.ts) - this function
 * does not re-normalize its input, only the stored column, via an explicit
 * `LOWER(TRIM(...))` on the SQL side rather than trusting the table's
 * collation to already be case-insensitive (never verified against a real
 * MariaDB/MySQL instance for this schema - see
 * docs/VPS_MIGRATION_RUNBOOK.md's Database Compatibility Audit).
 *
 * This is the ONE lookup the fail-closed multiple-accounts-per-email check
 * in resolveGoogleIdentity depends on - it must never silently miss a
 * match (which risks creating a duplicate account for the same real
 * person) or silently return a partial result. Deliberately defeats
 * users_email_idx (a function-wrapped predicate can't use a plain btree
 * index) - an accepted, documented trade-off at this table's current size;
 * users_email_idx still serves getUserByEmail's plain exact-match lookup.
 */
export async function findUsersByNormalizedEmail(normalizedEmail: string, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return [];
  return await db
    .select()
    .from(users)
    .where(sql`LOWER(TRIM(${users.email})) = ${normalizedEmail}`);
}

/**
 * Links a Google identity to an EXISTING user - never creates or modifies
 * a `users` row itself (callers update `lastSignedIn`/`name`/`loginMethod`
 * separately - see touchExistingUser in googleIdentityService.ts). Throws
 * (never silently no-ops) on a unique-constraint violation - callers
 * distinguish "a genuine conflict" from "lost a concurrent race for the
 * exact same link" via isDuplicateKeyError and re-read instead of
 * retrying the insert.
 */
export async function linkGoogleIdentity(
  params: { userId: number; providerSubject: string; email: string },
  tx?: any
): Promise<void> {
  const db = tx ?? (await getDb());
  if (!db) throw new Error("Database not available");
  await db.insert(authIdentities).values({
    userId: params.userId,
    provider: "google",
    providerSubject: params.providerSubject,
    emailAtLink: params.email,
  });
}

const GOOGLE_OPENID_PREFIX = "google:";

/**
 * Deterministically derives a `users.openId` value for a brand-new Google
 * user from the provider's `sub` claim alone (never the email - an
 * account's email can change, and openId must not).
 *
 * `users.openId` is `varchar(64)` (see drizzle/schema.ts) and this
 * migration round deliberately does NOT widen it. Google's `sub` claim can
 * be up to 255 characters, so `google:<raw-sub>` (up to 262 chars) would
 * silently truncate or fail to insert for some real Google accounts.
 * Instead this hashes the sub with SHA-256 and base64url-encodes the
 * digest (43 characters for any input, fixed-length regardless of the raw
 * sub's length) - `"google:"` (7 chars) + 43 chars = 50 chars, always
 * comfortably under the 64-char column limit, and deterministic (the same
 * sub always hashes to the same openId, so a repeat login for the same
 * Google account resolves to the same user via
 * getUserByOpenId/authenticateRequest - but note the actual repeat-login
 * path in resolveGoogleIdentity never recomputes this at all; it finds
 * the existing authIdentities row by raw providerSubject first and reuses
 * that row's stored userId, so this function is only ever called once per
 * real person, the moment their account is first created). The raw,
 * un-hashed sub is still stored in full in authIdentities.providerSubject
 * - this hash is only ever used for the openId/session-identity value,
 * never as a substitute for the real provider subject anywhere else.
 */
export function computeGoogleOpenId(providerSubject: string): string {
  const digest = createHash("sha256").update(providerSubject, "utf8").digest("base64url");
  return `${GOOGLE_OPENID_PREFIX}${digest}`;
}

/**
 * Creates a brand-new user for a Google identity that matched no existing
 * account by identity OR by email, plus its authIdentities row, as two
 * inserts on the SAME executor (so both are visible to each other and to
 * the rest of the caller's transaction before anything commits). Mints a
 * stable, app-owned `openId` via computeGoogleOpenId above - distinct by
 * construction from every Manus-issued openId (which are never prefixed
 * this way) and from the `admin-<id>` synthetic form local admin sessions
 * use (see server/_core/sdk.ts's authenticateRequest) - so a Google user's
 * session verifies through the exact same, unmodified authenticateRequest
 * code path as any other non-admin user.
 */
export async function createGoogleUserWithIdentity(
  params: { providerSubject: string; email: string; name: string | null },
  tx?: any
) {
  const db = tx ?? (await getDb());
  if (!db) throw new Error("Database not available");

  const openId = computeGoogleOpenId(params.providerSubject);
  const now = new Date();
  const values: InsertUser = {
    openId,
    name: params.name,
    email: params.email,
    loginMethod: "google",
    lastSignedIn: now,
  };
  // Same owner-auto-admin rule upsertUser already applies for every other
  // provider - preserved here so OWNER_OPEN_ID keeps working regardless of
  // which login path the owner's account was created/re-created through.
  if (openId === ENV.ownerOpenId) {
    values.role = "admin";
  }

  const insertResult = await db.insert(users).values(values);
  const insertedId = extractInsertId(insertResult);
  if (!insertedId) {
    throw new Error("Failed to extract inserted user ID from database result");
  }

  // Read back on the SAME executor - a fresh getDb() connection would not
  // see this row until the enclosing transaction commits.
  const createdRows = await db.select().from(users).where(eq(users.id, insertedId)).limit(1);
  const createdUser = createdRows.length > 0 ? createdRows[0] : undefined;
  if (!createdUser) {
    throw new Error("Failed to load newly created Google user");
  }

  await db.insert(authIdentities).values({
    userId: createdUser.id,
    provider: "google",
    providerSubject: params.providerSubject,
    emailAtLink: params.email,
  });

  return createdUser;
}

// ============ NOVELS & EPISODES ============

export async function getAllNovels(limit?: number, offset?: number) {
  const db = await getDb();
  if (!db) return [];
  // Only return published novels for public pages
  let query: any = db.select().from(novels).where(eq(novels.publicationStatus, "published")).orderBy(desc(novels.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

/**
 * id + updatedAt only, published novels only, for the /sitemap.xml route
 * (see server/_core/sitemap.ts) - never episodes, never draft/archived
 * novels. Capped well above any realistic current catalog size as a safety
 * net against an unbounded response if the catalog grows unexpectedly;
 * revisit (paginated/split sitemap) if the catalog ever approaches it.
 */
export async function getPublishedNovelsForSitemap(limitCap: number = 5000) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: novels.id, updatedAt: novels.updatedAt })
    .from(novels)
    .where(eq(novels.publicationStatus, "published"))
    .orderBy(desc(novels.updatedAt))
    .limit(limitCap);
}

/**
 * Lean, SEO-only lookup for a single novel - id/title/description/cover/
 * author/publicationStatus, never episodes, never content. Used by
 * server/services/serverSeoRenderer.ts to inject <head> metadata into the
 * initial HTML response for /novels/:id. Returns the row regardless of
 * publicationStatus (including archived/draft) so the caller can decide
 * what a non-published novel's metadata should look like - this function
 * itself makes no visibility/authorization decision, same as how
 * getNovelById(id, publicOnly) already separates fetching from the
 * public/admin visibility rule.
 */
export async function getNovelSeoData(novelId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db
    .select({
      id: novels.id,
      title: novels.title,
      description: novels.description,
      coverImageUrl: novels.coverImageUrl,
      author: novels.author,
      publicationStatus: novels.publicationStatus,
    })
    .from(novels)
    .where(eq(novels.id, novelId))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Get all novels for admin (including archived)
 * Used by admin pages to manage all novels
 */
export async function getAllNovelsForAdmin(limit?: number, offset?: number) {
  const db = await getDb();
  if (!db) return [];
  // Return ALL novels (published and archived) for admin management
  let query: any = db.select().from(novels).orderBy(desc(novels.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

/**
 * Search novels for the admin novel-picker (e.g. Import Episodes page).
 * Matches title/slug/author by partial text, and novel id by exact number
 * when the query is numeric - id matches are ranked first, then
 * exact/prefix title matches, then everything else by newest first.
 * Also includes archived novels (admin-only), unlike the public list.
 */
export async function searchNovelsForAdmin(query?: string, limit: number = 30) {
  const db = await getDb();
  if (!db) return [];

  const trimmed = (query ?? "").trim();
  const numericId = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;

  let dbQuery: any = db.select().from(novels);

  if (trimmed) {
    const likePattern = `%${trimmed}%`;
    const conditions = [
      like(novels.title, likePattern),
      like(novels.slug, likePattern),
      like(novels.author, likePattern),
    ];
    if (numericId !== null) {
      conditions.push(eq(novels.id, numericId));
    }
    dbQuery = dbQuery.where(or(...conditions));
    dbQuery = dbQuery.orderBy(
      sql`CASE
        WHEN ${novels.id} = ${numericId ?? -1} THEN 0
        WHEN ${novels.title} = ${trimmed} THEN 1
        WHEN ${novels.title} LIKE ${trimmed + "%"} THEN 2
        WHEN ${novels.slug} LIKE ${trimmed + "%"} THEN 3
        ELSE 4
      END`,
      desc(novels.createdAt)
    );
  } else {
    dbQuery = dbQuery.orderBy(desc(novels.createdAt));
  }

  const results = await dbQuery.limit(limit);
  if (results.length === 0) return [];

  const novelIds = results.map((n: any) => n.id);
  const episodeCounts = await db
    .select({ novelId: episodes.novelId, episodeCount: count() })
    .from(episodes)
    .where(inArray(episodes.novelId, novelIds))
    .groupBy(episodes.novelId);

  const countByNovelId = new Map(episodeCounts.map((row: any) => [row.novelId, row.episodeCount]));

  return results.map((n: any) => ({
    ...n,
    episodeCount: countByNovelId.get(n.id) ?? 0,
  }));
}

export async function getNovelById(novelId: number, publicOnly: boolean = true) {
  const db = await getDb();
  if (!db) return undefined;
  // For public access, only return published novels
  // For admin access (publicOnly=false), return all novels
  const query = publicOnly
    ? db.select().from(novels).where(
        and(eq(novels.id, novelId), eq(novels.publicationStatus, "published"))
      )
    : db.select().from(novels).where(eq(novels.id, novelId));
  const result = await query.limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getNovelBySlug(slug: string, publicOnly: boolean = true) {
  const db = await getDb();
  if (!db) return undefined;
  // For public access, only return published novels
  // For admin access (publicOnly=false), return all novels
  const query = publicOnly
    ? db.select().from(novels).where(
        and(eq(novels.slug, slug), eq(novels.publicationStatus, "published"))
      )
    : db.select().from(novels).where(eq(novels.slug, slug));
  const result = await query.limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getEpisodesByNovelId(novelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(episodes).where(eq(episodes.novelId, novelId)).orderBy(asc(episodes.episodeNumber));
}

/**
 * Lightweight, id/episodeNumber/title-only batch lookup for episodes -
 * never selects `content`/`fileUrl`/etc. Used where a caller needs to
 * resolve many episode ids to display labels (e.g. myNovels.list) without
 * either an N+1 loop of getEpisodeById() calls or shipping every episode's
 * full content over the wire for a page that never displays it.
 */
export async function getEpisodesByIdsLite(episodeIds: number[]) {
  const db = await getDb();
  if (!db || episodeIds.length === 0) return [];
  return db
    .select({
      id: episodes.id,
      novelId: episodes.novelId,
      episodeNumber: episodes.episodeNumber,
      title: episodes.title,
    })
    .from(episodes)
    .where(inArray(episodes.id, episodeIds));
}

/**
 * Lightweight, card-display-only batch lookup for novels (id/title/cover/
 * status) - never the full `SELECT *` row. Same N+1-avoidance rationale as
 * getEpisodesByIdsLite above.
 */
export async function getNovelsByIdsLite(novelIds: number[]) {
  const db = await getDb();
  if (!db || novelIds.length === 0) return [];
  return db
    .select({
      id: novels.id,
      title: novels.title,
      coverImageUrl: novels.coverImageUrl,
      publicationStatus: novels.publicationStatus,
      storyStatus: novels.storyStatus,
    })
    .from(novels)
    .where(inArray(novels.id, novelIds));
}

export async function getEpisodeById(episodeId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const result = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getAllCategories() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(categories).orderBy(asc(categories.name));
}

export async function getCategoriesByNovelId(novelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ category: categories })
    .from(novelCategories)
    .innerJoin(categories, eq(novelCategories.categoryId, categories.id))
    .where(eq(novelCategories.novelId, novelId));
}

/**
 * Episode counts for one novel, via a single grouped aggregate query -
 * never fetches the episode rows themselves (let alone `content`). Used by
 * the admin novel-manage page, which otherwise has no reason to load any
 * episode data up front.
 */
export async function getNovelEpisodeStats(novelId: number) {
  const empty = { episodeCount: 0, packageCount: 0, chapterCount: 0, publishedCount: 0, draftCount: 0 };
  const db = await getDb();
  if (!db) return empty;

  const rows = await db
    .select({
      saleMode: episodes.saleMode,
      isPublished: episodes.isPublished,
      count: count(),
    })
    .from(episodes)
    .where(eq(episodes.novelId, novelId))
    .groupBy(episodes.saleMode, episodes.isPublished);

  return rows.reduce((stats: typeof empty, row: any) => {
    const n = Number(row.count) || 0;
    stats.episodeCount += n;
    if (row.saleMode === "package") stats.packageCount += n;
    else stats.chapterCount += n;
    if (row.isPublished) stats.publishedCount += n;
    else stats.draftCount += n;
    return stats;
  }, { ...empty });
}

// ============ NOVEL CRUD ============

export async function createNovel(data: {
  title: string;
  author?: string;
  description?: string;
  coverImageUrl?: string;
  publicationStatus?: "published" | "archived";
  storyStatus?: "ongoing" | "finished";
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Generate slug: strip non-ASCII (e.g., Thai) chars, fallback to timestamp-based slug
  let rawSlug = data.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!rawSlug) rawSlug = `novel-${Date.now()}`;
  // Ensure uniqueness
  const slug = await generateUniqueSlug(data.title);
  const result = await db.insert(novels).values({
    title: data.title,
    author: data.author || "",
    description: data.description || "",
    coverImageUrl: data.coverImageUrl || "",
    slug,
    publicationStatus: data.publicationStatus || "published",
    storyStatus: data.storyStatus || "ongoing",
  });
  // Extract insertId from Drizzle MySQL result
  let insertedId: number | undefined;
  if (typeof result === 'object' && result !== null) {
    insertedId = (result as any).insertId;
    if (!insertedId && Array.isArray(result) && result[0]) {
      insertedId = (result[0] as any).insertId;
    }
    if (!insertedId && (result as any).meta) {
      insertedId = (result as any).meta.insertId;
    }
  }
  if (!insertedId) {
    throw new Error("Failed to extract inserted novel ID from database result");
  }
  return { id: insertedId } as any;
}

export async function updateNovel(novelId: number, data: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(novels).set(data).where(eq(novels.id, novelId));
}

export async function deleteNovel(novelId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(novels).where(eq(novels.id, novelId));
}

// ============ EPISODE CRUD ============

export async function getAllEpisodes() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(episodes).orderBy(desc(episodes.createdAt));
}

export interface AdminEpisodesListParams {
  page?: number;
  pageSize?: number;
  novelId?: number;
  search?: string;
  sortBy?: "createdAt" | "updatedAt" | "episodeNumber" | "title" | "sortOrder";
  sortOrder?: "asc" | "desc";
  saleMode?: "chapter" | "package";
  isPublished?: boolean;
}

/**
 * Lightweight, paginated episode list for the admin episodes page.
 * Deliberately never selects `content` (mediumtext, up to ~16MB per row for
 * package episodes) - that's what made the old unpaginated getAllEpisodes()
 * query/response so large that the page felt like it (or the session) had
 * hung. Use getEpisodeById() for the full row (content/fileUrl) when a
 * single episode is opened for editing.
 */
export async function getAdminEpisodesList(params: AdminEpisodesListParams = {}) {
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
  const page = Math.max(1, params.page ?? 1);

  const db = await getDb();
  if (!db) {
    return { episodes: [], total: 0, page, pageSize, totalPages: 0 };
  }

  const offset = (page - 1) * pageSize;

  const conditions = [];
  if (params.novelId) conditions.push(eq(episodes.novelId, params.novelId));
  if (params.saleMode) conditions.push(eq(episodes.saleMode, params.saleMode));
  if (params.isPublished !== undefined) conditions.push(eq(episodes.isPublished, params.isPublished));
  if (params.search?.trim()) {
    const pattern = `%${params.search.trim()}%`;
    conditions.push(or(like(episodes.title, pattern), like(episodes.episodeNumber, pattern)));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumns = {
    createdAt: episodes.createdAt,
    updatedAt: episodes.updatedAt,
    episodeNumber: episodes.episodeNumber,
    title: episodes.title,
    sortOrder: episodes.sortOrder,
  } as const;
  const sortColumn = sortColumns[params.sortBy ?? "createdAt"] ?? episodes.createdAt;
  const orderFn = params.sortOrder === "asc" ? asc : desc;

  let listQuery: any = db
    .select({
      id: episodes.id,
      novelId: episodes.novelId,
      novelTitle: novels.title,
      episodeNumber: episodes.episodeNumber,
      title: episodes.title,
      description: episodes.description,
      price: episodes.price,
      isFree: episodes.isFree,
      saleMode: episodes.saleMode,
      isPublished: episodes.isPublished,
      publishedAt: episodes.publishedAt,
      sortOrder: episodes.sortOrder,
      wordCount: episodes.wordCount,
      createdAt: episodes.createdAt,
      updatedAt: episodes.updatedAt,
      hasContent: sql<boolean>`(${episodes.content} IS NOT NULL AND ${episodes.content} != '')`,
      contentLength: sql<number>`COALESCE(LENGTH(${episodes.content}), 0)`,
      hasLegacyFile: sql<boolean>`(${episodes.fileUrl} IS NOT NULL AND ${episodes.fileUrl} != '')`,
    })
    .from(episodes)
    .leftJoin(novels, eq(episodes.novelId, novels.id));
  if (whereClause) listQuery = listQuery.where(whereClause);
  listQuery = listQuery.orderBy(orderFn(sortColumn)).limit(pageSize).offset(offset);

  let countQuery: any = db.select({ total: count() }).from(episodes);
  if (whereClause) countQuery = countQuery.where(whereClause);

  const [rows, countRows] = await Promise.all([listQuery, countQuery]);
  const total = Number(countRows[0]?.total) || 0;

  return {
    episodes: rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function createEpisode(data: {
  novelId: number;
  episodeNumber: string;
  title: string;
  price: string;
  isFree?: boolean;
  fileUrl?: string;
  content?: string;
  contentFormat?: string;
  saleMode?: "chapter" | "package";
  description?: string;
  isPublished?: boolean;
  publishedAt?: Date;
  sortOrder?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!data.episodeNumber || !data.episodeNumber.trim()) {
    throw new Error("Episode number is required");
  }

  // Auto-calculate wordCount if content provided
  const wordCount = data.content ? Math.round(data.content.split(/\s+/).length) : null;

  const result = await db.insert(episodes).values({
    novelId: data.novelId,
    episodeNumber: data.episodeNumber.trim(),
    title: data.title,
    price: data.price,
    isFree: data.isFree || false,
    fileUrl: data.fileUrl || "",
    content: data.content || null,
    contentFormat: data.contentFormat || "plain_text",
    saleMode: data.saleMode || "chapter",
    description: data.description || null,
    isPublished: data.isPublished !== false,
    publishedAt: data.publishedAt || null,
    sortOrder: data.sortOrder || null,
    wordCount: wordCount,
  });
  // Extract insertId from Drizzle MySQL result
  let insertedId: number | undefined;
  if (typeof result === 'object' && result !== null) {
    insertedId = (result as any).insertId;
    if (!insertedId && Array.isArray(result) && result[0]) {
      insertedId = (result[0] as any).insertId;
    }
    if (!insertedId && (result as any).meta) {
      insertedId = (result as any).meta.insertId;
    }
  }
  if (!insertedId) {
    throw new Error("Failed to extract inserted episode ID from database result");
  }
  return { id: insertedId } as any;
}

export async function updateEpisode(episodeId: number, data: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Auto-calculate wordCount if content is being updated
  if (data.content !== undefined) {
    data.wordCount = data.content ? Math.round(data.content.split(/\s+/).length) : null;
  }

  await db.update(episodes).set(data).where(eq(episodes.id, episodeId));
}

export async function deleteEpisode(episodeId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(episodes).where(eq(episodes.id, episodeId));
}

// ============ READING PROGRESS ============

export async function getReadingProgress(userId: number, episodeId: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.episodeId, episodeId)))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Fetch reading progress for many episodes at once, keyed by episodeId, for
 * list views (bookshelf/library pages) that show a "continue reading" hint
 * per purchased episode without one query per row.
 */
export async function getReadingProgressBatch(userId: number, episodeIds: number[]) {
  const db = await getDb();
  if (!db || episodeIds.length === 0) return new Map<number, typeof readingProgress.$inferSelect>();

  const rows = await db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), inArray(readingProgress.episodeId, episodeIds)));

  return new Map(rows.map((row) => [row.episodeId, row]));
}

/**
 * Insert or update a user's reading progress for an episode. Caller is
 * responsible for verifying the user actually has read access to the
 * episode first (see readerService.canReadEpisode) - this function itself
 * does not check entitlement.
 */
export async function upsertReadingProgress(data: {
  userId: number;
  novelId: number;
  episodeId: number;
  progressPercent: number;
  scrollPosition?: number;
  currentChapterNumber?: string | null;
  currentChapterTitle?: string | null;
  anchorKey?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const clampedPercent = Math.max(0, Math.min(100, Math.round(data.progressPercent)));

  await withAccountMergeClassifiedMutationGuard(data.userId, undefined, async (guardedDb) => {
    await guardedDb
      .insert(readingProgress)
      .values({
        userId: data.userId,
        novelId: data.novelId,
        episodeId: data.episodeId,
        progressPercent: clampedPercent,
        scrollPosition: Math.max(0, Math.round(data.scrollPosition ?? 0)),
        currentChapterNumber: data.currentChapterNumber ?? null,
        currentChapterTitle: data.currentChapterTitle ?? null,
        anchorKey: data.anchorKey ?? null,
        lastReadAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          progressPercent: clampedPercent,
          scrollPosition: Math.max(0, Math.round(data.scrollPosition ?? 0)),
          currentChapterNumber: data.currentChapterNumber ?? null,
          currentChapterTitle: data.currentChapterTitle ?? null,
          anchorKey: data.anchorKey ?? null,
          lastReadAt: new Date(),
        },
      });
  });
}

// ============ CATEGORY CRUD ============

export async function createCategory(data: {
  name: string;
  description?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(categories).values({
    name: data.name,
    slug: data.name.toLowerCase().replace(/\s+/g, "-"),
    description: data.description || "",
  });
  return result;
}

export async function updateCategory(categoryId: number, data: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(categories).set(data).where(eq(categories.id, categoryId));
}

export async function deleteCategory(categoryId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(categories).where(eq(categories.id, categoryId));
}

// ============ CART ============

export async function getOrCreateCart(userId: number) {
  const database = await getDb();
  if (!database) return undefined;

  const existing = await database.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];

  // Only the create path is a classified mutation. Re-check after acquiring
  // the Source guard because another request may have created the singleton
  // cart while this one waited for the users-row lock.
  return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    const afterLock = await guardedDb.select().from(carts).where(eq(carts.userId, userId)).limit(1);
    if (afterLock.length > 0) return afterLock[0];
    const newCart: any = await guardedDb.insert(carts).values({ userId });
    const header = Array.isArray(newCart) ? newCart[0] : newCart;
    const cartId = Number(header?.insertId);
    return { id: cartId, userId, createdAt: new Date(), updatedAt: new Date() };
  });
}

export async function getCartItems(cartId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return [];
  return db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
}

/**
 * Locks the current user's cart row for the duration of a checkout
 * transaction (SELECT ... FOR UPDATE), so a concurrent checkout.create call
 * for the same cart blocks until this transaction commits or rolls back,
 * and a retry against an already-cleared cart sees the post-commit state
 * rather than racing it. Always called with an explicit transaction - never
 * falls back to a bare connection, since locking outside a transaction
 * would release the lock immediately and defeat the purpose.
 *
 * Returns the cart's id, or null if the user has no cart row at all - the
 * caller should treat that exactly like an empty cart, not as an error.
 */
export async function lockCartForCheckout(userId: number, tx: any): Promise<number | null> {
  // mysql2's raw .execute() resolves to a [rows, fields] tuple, not the bare
  // rows array - unwrap it the same way runMigrationsWithLogging.ts does
  // for the same driver-level shape.
  const rawResult: any = await tx.execute(sql`SELECT id FROM carts WHERE userId = ${userId} FOR UPDATE`);
  const cartRows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  if (!cartRows || cartRows.length === 0) return null;
  return cartRows[0].id as number;
}

/**
 * Locks and returns the cart's items (SELECT ... FOR UPDATE) - the re-read
 * checkout.create must use immediately after lockCartForCheckout, instead
 * of a plain getCartItems, to decide whether the cart is actually empty.
 *
 * Same reasoning as lockCouponForUsage below: locking the `carts` row does
 * not make a later PLAIN SELECT against the separate `cartItems` table
 * current. Under TiDB's pessimistic-transaction model, a non-locking SELECT
 * is served from the transaction's start_ts (fixed before this statement
 * even waited on the cart row's lock) - only a locking read (FOR UPDATE) is
 * guaranteed to observe the latest committed value, which is what actually
 * matters here: whether the cart was already cleared by the transaction
 * this one just waited behind. A plain re-read can still see the
 * pre-clearing rows and let a second Order be created from the same cart
 * even though the row lock itself worked exactly as intended. (Standard
 * InnoDB REPEATABLE READ does not exhibit this - its first non-locking read
 * in a transaction establishes a fresh snapshot at that point - but this
 * function is the correct fix on both engines: it is never wrong to make a
 * decision-critical read a locking read once its row lock prerequisite is
 * already held.)
 */
export async function getCartItemsForUpdate(cartId: number, tx: any) {
  const rawResult: any = await tx.execute(sql`SELECT * FROM cartItems WHERE cartId = ${cartId} FOR UPDATE`);
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return rows || [];
}

async function getCartOwnerUserId(cartId: number, database: any): Promise<number | undefined> {
  const rows = await database.select({ userId: carts.userId }).from(carts).where(eq(carts.id, cartId)).limit(1);
  return rows[0]?.userId;
}

export async function addToCart(cartId: number, episodeId: number, novelId: number, price: string) {
  const database = await getDb();
  if (!database) return undefined;
  const userId = await getCartOwnerUserId(cartId, database);
  if (!userId) throw new Error("Cart not found");

  return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    const lockedOwner = await getCartOwnerUserId(cartId, guardedDb);
    if (lockedOwner !== userId) throw new Error("Cart owner changed while mutation was waiting for account lock");
    return guardedDb.insert(cartItems).values({
      cartId,
      episodeId,
      novelId,
      price: price as any,
    });
  });
}

export async function removeFromCart(cartItemId: number) {
  const database = await getDb();
  if (!database) return;
  const ownerRows = await database
    .select({ userId: carts.userId })
    .from(cartItems)
    .innerJoin(carts, eq(cartItems.cartId, carts.id))
    .where(eq(cartItems.id, cartItemId))
    .limit(1);
  const userId = ownerRows[0]?.userId;
  if (!userId) return;

  await withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    await guardedDb.delete(cartItems).where(eq(cartItems.id, cartItemId));
  });
}

export async function clearCart(cartId: number, tx?: any) {
  const database = tx || await getDb();
  if (!database) return;
  const userId = await getCartOwnerUserId(cartId, database);
  if (!userId) return;
  await withAccountMergeClassifiedMutationGuard(userId, tx, async (guardedDb) => {
    await guardedDb.delete(cartItems).where(eq(cartItems.cartId, cartId));
  });
}

// ============ ORDERS & PAYMENTS ============

export async function createOrder(data: {
  orderNumber: string;
  userId?: number;
  subtotal: string;
  discountAmount: string;
  pointsDiscountAmount: string;
  totalAmount: string;
  couponCodeSnapshot?: string;
}, tx?: any): Promise<{ id: number } | undefined> {
  if (data.userId && !tx) {
    return withAccountMergeClassifiedMutationGuard(data.userId, undefined, async (guardedTx) =>
      createOrder(data, guardedTx)
    );
  }
  const db = tx || await getDb();
  if (!db) return undefined;
  if (data.userId && tx) await assertAccountMergeClassifiedMutationAllowed(data.userId, tx);

  const result = await db.insert(orders).values({
    orderNumber: data.orderNumber,
    userId: data.userId,
    subtotal: data.subtotal as any,
    discountAmount: data.discountAmount as any,
    pointsDiscountAmount: data.pointsDiscountAmount as any,
    totalAmount: data.totalAmount as any,
    couponCodeSnapshot: data.couponCodeSnapshot,
    status: "pending",
    paymentStatus: "unpaid",
  });

  // Extract insertId from Drizzle MySQL result
  let insertedId: number | undefined;
  
  // Try different ways to get insertId based on Drizzle/MySQL driver behavior
  if (typeof result === 'object' && result !== null) {
    // Direct property access
    insertedId = (result as any).insertId;
    // Or nested in array
    if (!insertedId && Array.isArray(result) && result[0]) {
      insertedId = (result[0] as any).insertId;
    }
    // Or in metadata
    if (!insertedId && (result as any).meta) {
      insertedId = (result as any).meta.insertId;
    }
  }
  
  if (!insertedId) {
    console.error("Insert result structure:", JSON.stringify(result, null, 2));
    console.error("Result type:", typeof result);
    console.error("Result keys:", Object.keys(result || {}));
    throw new Error("Failed to extract inserted order ID from database result");
  }

  // Return object with id property so orderService can access it
  return { id: insertedId } as any;
}

export async function getOrderById(orderId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const result = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getOrderByNumber(orderNumber: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getOrdersByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt));
}

export async function getAllOrders(limit?: number, offset?: number) {
  const db = await getDb();
  if (!db) return [];
  let query: any = db.select().from(orders).orderBy(desc(orders.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

export async function getAdminOrders(options: {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'amount' | 'discount';
  sortOrder?: 'asc' | 'desc';
  status?: string;
  paymentStatus?: string;
  startDate?: Date;
  endDate?: Date;
  hasDiscount?: boolean;
  hasCoupon?: boolean;
  minAmount?: number;
  maxAmount?: number;
} = {}) {
  const db = await getDb();
  if (!db) return { orders: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };

  const pageSize = options.pageSize || 20;
  const page = Math.max(1, options.page || 1);
  const offset = (page - 1) * pageSize;

  // Build where conditions
  const conditions: any[] = [];

  // Search conditions
  if (options.search) {
    const searchLower = `%${options.search.toLowerCase()}%`;
    conditions.push(
      or(
        sql`LOWER(${orders.orderNumber}) LIKE ${searchLower}`,
        sql`LOWER(${orders.userId}) LIKE ${searchLower}`
      )
    );
  }

  // Status filter
  if (options.status) {
    conditions.push(eq(orders.status, options.status as any));
  }

  // Payment status filter
  if (options.paymentStatus) {
    conditions.push(eq(orders.paymentStatus, options.paymentStatus as any));
  }

  // Date range filter
  if (options.startDate) {
    conditions.push(gte(orders.createdAt, options.startDate));
  }
  if (options.endDate) {
    conditions.push(lte(orders.createdAt, options.endDate));
  }

  // Discount filter
  if (options.hasDiscount === true) {
    conditions.push(
      or(
        gt(orders.discountAmount, '0'),
        gt(orders.pointsDiscountAmount, '0')
      )
    );
  } else if (options.hasDiscount === false) {
    conditions.push(
      and(
        eq(orders.discountAmount, '0'),
        eq(orders.pointsDiscountAmount, '0')
      )
    );
  }

  // Amount range filter
  if (options.minAmount !== undefined) {
    conditions.push(gte(orders.totalAmount, options.minAmount.toString()));
  }
  if (options.maxAmount !== undefined) {
    conditions.push(lte(orders.totalAmount, options.maxAmount.toString()));
  }

  // Build base query
  let query: any = db.select().from(orders);

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  // Sorting
  const sortBy = options.sortBy || 'createdAt';
  const sortOrder = options.sortOrder || 'desc';
  const orderByFn = sortOrder === 'asc' ? asc : desc;

  let orderByColumn: any = orders.createdAt;
  if (sortBy === 'updatedAt') orderByColumn = orders.updatedAt;
  if (sortBy === 'amount') orderByColumn = orders.totalAmount;
  if (sortBy === 'discount') orderByColumn = orders.discountAmount;

  // Count total before pagination
  const countQuery = query;
  const countResult = await countQuery;
  const total = countResult.length;

  // Apply sorting and pagination
  query = query.orderBy(orderByFn(orderByColumn)).limit(pageSize).offset(offset);
  const result = await query;

  return {
    orders: result,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function getOrderWithUserName(orderId: number) {
  const db = await getDb();
  if (!db) return null;
  
  const order = await db
    .select({
      ...getTableColumns(orders),
      userName: users.name,
      userEmail: users.email,
    })
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id))
    .where(eq(orders.id, orderId))
    .limit(1);

  return order.length > 0 ? order[0] : null;
}

export async function getAdminOrdersWithUsers(options: {
  page?: number;
  pageSize?: number;
  search?: string;
  userId?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'amount' | 'discount';
  sortOrder?: 'asc' | 'desc';
  status?: string;
  paymentStatus?: string;
  startDate?: Date;
  endDate?: Date;
  hasDiscount?: boolean;
  hasCoupon?: boolean;
  minAmount?: number;
  maxAmount?: number;
} = {}) {
  const db = await getDb();
  if (!db) return { orders: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };

  const pageSize = options.pageSize || 20;
  const page = Math.max(1, options.page || 1);
  const offset = (page - 1) * pageSize;

  // Create aliases for order user and approver user (must be before using in conditions)
  const orderUser = alias(users, "orderUser");
  const approverUser = alias(users, "approverUser");

  // Build where conditions
  const conditions: any[] = [];

  // Search conditions - search in order number, user ID, or user name
  if (options.search) {
    const searchLower = `%${options.search.toLowerCase()}%`;
    conditions.push(
      or(
        sql`LOWER(${orders.orderNumber}) LIKE ${searchLower}`,
        sql`LOWER(CAST(${orders.userId} AS CHAR)) LIKE ${searchLower}`,
        sql`LOWER(${orderUser.name}) LIKE ${searchLower}`,
        sql`LOWER(${orderUser.email}) LIKE ${searchLower}`
      )
    );
  }

  // UserID filter
  if (options.userId !== undefined) {
    conditions.push(eq(orders.userId, options.userId));
  }

  // Status filter
  if (options.status) {
    conditions.push(eq(orders.status, options.status as any));
  }

  // Payment status filter
  if (options.paymentStatus) {
    conditions.push(eq(orders.paymentStatus, options.paymentStatus as any));
  }

  // Date range filter
  if (options.startDate) {
    conditions.push(gte(orders.createdAt, options.startDate));
  }
  if (options.endDate) {
    conditions.push(lte(orders.createdAt, options.endDate));
  }

  // Discount filter
  if (options.hasDiscount === true) {
    conditions.push(
      or(
        gt(orders.discountAmount, '0'),
        gt(orders.pointsDiscountAmount, '0')
      )
    );
  } else if (options.hasDiscount === false) {
    conditions.push(
      and(
        eq(orders.discountAmount, '0'),
        eq(orders.pointsDiscountAmount, '0')
      )
    );
  }

  // Amount range filter
  if (options.minAmount !== undefined) {
    conditions.push(gte(orders.totalAmount, options.minAmount.toString()));
  }
  if (options.maxAmount !== undefined) {
    conditions.push(lte(orders.totalAmount, options.maxAmount.toString()));
  }



  // Build query with user joins and payment data
  let query: any = db
    .select({
      ...getTableColumns(orders),
      userName: orderUser.name,
      userEmail: orderUser.email,
      approvalSource: payments.approvalSource,
      approvedByAdminId: payments.approvedByAdminId,
      approvedByLabel: payments.approvedByLabel,
      approvedAt: payments.approvedAt,
      approvedByName: approverUser.name,
      approvedByEmail: approverUser.email,
    })
    .from(orders)
    .leftJoin(orderUser, eq(orders.userId, orderUser.id))
    .leftJoin(payments, eq(orders.id, payments.orderId))
    .leftJoin(approverUser, eq(payments.approvedByAdminId, approverUser.id))

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  // Count total before pagination
  const countResult = await query;
  const total = countResult.length;

  // Sorting
  const sortBy = options.sortBy || 'createdAt';
  const sortOrder = options.sortOrder || 'desc';
  const orderByFn = sortOrder === 'asc' ? asc : desc;

  let orderByColumn: any = orders.createdAt;
  if (sortBy === 'updatedAt') orderByColumn = orders.updatedAt;
  if (sortBy === 'amount') orderByColumn = orders.totalAmount;
  if (sortBy === 'discount') orderByColumn = orders.discountAmount;

  // Apply sorting and pagination
  query = query.orderBy(orderByFn(orderByColumn)).limit(pageSize).offset(offset);
  const result = await query;

  return {
    orders: result,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function countOrdersByDateRange(startDate: Date, endDate: Date) {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, startDate),
        lte(orders.createdAt, endDate)
      )
    );
  return result[0]?.count || 0;
}

export async function createOrderItems(items: Array<{ orderId: number; novelId: number; episodeId: number; unitPrice: string; discountAmount: string; finalPrice: string }>, tx?: any) {
  if (items.length === 0) return;
  const orderId = items[0].orderId;
  if (items.some((item) => item.orderId !== orderId)) {
    throw new Error("createOrderItems requires one order per guarded mutation");
  }
  await withAccountMergeOrderMutationGuard(orderId, tx, async (guardedDb) => {
    await guardedDb.insert(orderItems).values(items as any);
  });
}

export async function getOrderItems(orderId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return [];
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  
  // Enrich with episode and novel data
  const enriched = await Promise.all(
    items.map(async (item: any) => {
      const episodeData = await db.select().from(episodes).where(eq(episodes.id, item.episodeId)).limit(1);
      const novelData = episodeData.length > 0 ? await db.select().from(novels).where(eq(novels.id, episodeData[0].novelId)).limit(1) : [];
      return {
        ...item,
        episode: episodeData.length > 0 ? episodeData[0] : null,
        novel: novelData.length > 0 ? novelData[0] : null,
      };
    })
  );
  
  return enriched;
}

export async function createPayment(
  orderId: number,
  slipImageUrl?: string,
  tx?: any
): Promise<{ id: number } | undefined> {
  if (!tx) {
    return withAccountMergeOrderMutationGuard(orderId, undefined, async (guardedTx) =>
      createPayment(orderId, slipImageUrl, guardedTx)
    );
  }
  await withAccountMergeOrderMutationGuard(orderId, tx, async () => undefined);
  const db = tx;
  const result = await db.insert(payments).values({
    orderId,
    status: "pending",
    slipImageUrl: slipImageUrl || null,
    slipSubmittedAt: slipImageUrl ? new Date() : null,
    // Explicit, not relying on the column's own DEFAULT clause: migration
    // 0021 sets `ocrConfidence int NOT NULL DEFAULT 0` and then immediately
    // re-runs `MODIFY COLUMN ocrConfidence int NOT NULL` with no DEFAULT,
    // silently dropping it - every insert that omits this column resolves
    // to the SQL keyword DEFAULT, which errors under strict SQL mode
    // ("Field 'ocrConfidence' doesn't have a default value") since the
    // column has none. This was the root cause of every checkout failing
    // right after a successful slip upload.
    ocrConfidence: 0,
  });
  
  // Extract insertId from Drizzle MySQL result
  let insertedId: number | undefined;
  if (typeof result === 'object' && result !== null) {
    insertedId = (result as any).insertId;
    if (!insertedId && Array.isArray(result) && result[0]) {
      insertedId = (result[0] as any).insertId;
    }
    if (!insertedId && (result as any).meta) {
      insertedId = (result as any).meta.insertId;
    }
  }
  
  if (!insertedId) {
    throw new Error("Failed to extract inserted payment ID from database result");
  }
  return { id: insertedId } as any;
}

export async function getPaymentByOrderId(orderId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const result = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getPaymentById(paymentId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const result = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateOrder(orderId: number, data: { status?: string; paymentStatus?: string; notes?: string }, tx?: any) {
  const updateData: any = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.paymentStatus !== undefined) updateData.paymentStatus = data.paymentStatus;
  if (data.notes !== undefined) updateData.notes = data.notes;

  if (Object.keys(updateData).length === 0) return;

  await withAccountMergeOrderMutationGuard(orderId, tx, async (guardedDb) => {
    await guardedDb.update(orders).set(updateData).where(eq(orders.id, orderId));
  });
}

export async function updatePayment(paymentId: number, data: { slipImageUrl?: string; slipSubmittedAt?: Date; status?: "pending" | "approved" | "rejected" | "pending_review"; rejectionReason?: string; extractedData?: string | null; reviewReason?: string | null; fingerprint?: string | null; linkedOrderId?: number | null; linkedPaymentId?: number | null; ocrConfidence?: number | null; ocrDecision?: string | null }, tx?: any) {
  await withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
    await guardedDb.update(payments).set(data).where(eq(payments.id, paymentId));
  });
}

export async function approvePayment(paymentId: number, reviewedByUserId: number, tx?: any) {
  await withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
    await guardedDb
      .update(payments)
      .set({
        status: "approved",
        reviewedByUserId,
        reviewedAt: new Date(),
      })
      .where(eq(payments.id, paymentId));
  });
}

export async function rejectPayment(paymentId: number, reviewedByUserId: number, rejectionReason: string, tx?: any) {
  await withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
    await guardedDb
      .update(payments)
      .set({
        status: "rejected",
        rejectionReason,
        reviewedByUserId,
        reviewedAt: new Date(),
      })
      .where(eq(payments.id, paymentId));
  });
}

export async function getCartItemById(cartItemId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(cartItems).where(eq(cartItems.id, cartItemId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getCartById(cartId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getWishlistById(wishlistId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(wishlists).where(eq(wishlists.id, wishlistId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getPendingPayments(limit?: number, offset?: number) {
  const db = await getDb();
  if (!db) return [];
  // Exclude wallet payments - they don't need slip review
  // Include both pending and pending_review payments for admin review
  let query: any = db.select().from(payments).where(
    and(
      or(
        eq(payments.status, "pending"),
        eq(payments.status, "pending_review")
      ),
      or(
        isNull(payments.approvalSource),
        ne(payments.approvalSource, "wallet")
      )
    )
  ).orderBy(desc(payments.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

// ============ PURCHASES (ENTITLEMENTS) ============

export async function createPurchase(userId: number, novelId: number, episodeId: number, orderId: number, tx?: any) {
  return withAccountMergeClassifiedMutationGuard(userId, tx, async (guardedDb) =>
    guardedDb.insert(purchases).values({
      userId,
      novelId,
      episodeId,
      orderId,
      grantedAt: new Date(),
    })
  );
}

export async function getPurchaseByUserAndEpisode(userId: number, episodeId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  // Only return purchase if the associated order is approved
  const result = await db
    .select()
    .from(purchases)
    .innerJoin(orders, eq(purchases.orderId, orders.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.episodeId, episodeId),
        eq(orders.status, "approved")
      )
    )
    .limit(1);
  return result.length > 0 ? result[0].purchases : undefined;
}

export async function getPurchasesByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(purchases).where(eq(purchases.userId, userId)).orderBy(desc(purchases.grantedAt));
}

export async function getPurchasesByNovelId(novelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(purchases).where(eq(purchases.novelId, novelId));
}

export async function getPurchasedEpisodesByNovelAndUser(novelId: number, userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(purchases).where(and(eq(purchases.novelId, novelId), eq(purchases.userId, userId)));
}

// ============ COUPONS ============

export async function getCouponByCode(code: string, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  // Normalize code: trim and uppercase for consistent lookup
  const normalizedCode = String(code || "").trim().toUpperCase();
  const result = await db.select().from(coupons).where(eq(coupons.code, normalizedCode)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getAllCoupons() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(coupons).orderBy(desc(coupons.createdAt));
}

/**
 * Look up which reward-tracking table (if any) a coupon belongs to, and
 * return its ownership/status. A coupon with no match in any reward table
 * is a regular, non-user-scoped coupon (usable by anyone, subject only to
 * the normal isActive/expiresAt/usageCount checks).
 *
 * Single shared source of truth for "is this a reward coupon, and who owns
 * it" - both validateAndApplyCoupon (orderService.ts) and
 * getActiveCouponsForCart (below) call this instead of querying each
 * reward table directly, so adding a third reward type later only means
 * extending this one function. See docs/DAILY_CHECKIN_COUPON.md PART A
 * risk #1.
 */
export async function getRewardCouponOwnership(
  couponId: number,
  tx?: any
): Promise<{ userId: number; status: string } | null> {
  const database = tx || (await getDb());
  if (!database) return null;

  const sportsReward = await database
    .select()
    .from(sportsMatchRewards)
    .where(eq(sportsMatchRewards.couponId, couponId))
    .limit(1);
  if (sportsReward.length > 0) {
    return { userId: sportsReward[0].userId, status: sportsReward[0].status };
  }

  const checkinReward = await database
    .select()
    .from(dailyCheckins)
    .where(eq(dailyCheckins.couponId, couponId))
    .limit(1);
  if (checkinReward.length > 0) {
    return { userId: checkinReward[0].userId, status: checkinReward[0].status };
  }

  return null;
}

export interface CouponOwnershipResolution {
  /** True when this coupon may only be used by ownerUserId. */
  isOwnershipRestricted: boolean;
  ownerUserId: number | null;
  /** Reward-table status ("issued"/"used"/"expired"/"void"), or null when
   *  ownership comes from the new scope="user"/ownerUserId columns instead
   *  of a legacy reward table (those have no separate status gate here -
   *  isActive/expiresAt/usageCount already cover them). */
  rewardStatus: string | null;
}

/**
 * Single shared source of truth for "is this coupon restricted to one
 * owner, and to whom" - covers BOTH the new explicit
 * coupons.scope/ownerUserId columns AND the legacy
 * sportsMatchRewards/dailyCheckins reward-table fallback. Both
 * orderService.validateAndApplyCoupon and getActiveCouponsForCart (below)
 * call this instead of re-implementing the precedence rule.
 *
 * The legacy reward-table check always runs, regardless of what `scope`
 * says - this is what keeps every pre-existing reward coupon (created
 * before this column existed, so scope defaulted to "global") fully
 * protected without any backfill.
 */
export async function resolveCouponOwnership(
  coupon: { id: number; scope?: string | null; ownerUserId?: number | null },
  tx?: any
): Promise<CouponOwnershipResolution> {
  if (coupon.scope === "user" && coupon.ownerUserId) {
    return { isOwnershipRestricted: true, ownerUserId: coupon.ownerUserId, rewardStatus: null };
  }

  const legacy = await getRewardCouponOwnership(coupon.id, tx);
  if (legacy) {
    return { isOwnershipRestricted: true, ownerUserId: legacy.userId, rewardStatus: legacy.status };
  }

  return { isOwnershipRestricted: false, ownerUserId: null, rewardStatus: null };
}

export async function getActiveCouponsForCart(subtotal?: string | number, userId?: number) {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const subtotalNum = Number.parseFloat(String(subtotal ?? "0"));
  const safeSubtotal = Number.isFinite(subtotalNum) ? subtotalNum : 0;

  const result = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.isActive, true),
        or(isNull(coupons.expiresAt), gt(coupons.expiresAt, now)),
        or(
          isNull(coupons.maxUsageCount),
          sql`${coupons.maxUsageCount} > ${coupons.usageCount}`
        )
      )
    )
    .orderBy(asc(coupons.minPurchaseAmount), desc(coupons.createdAt));

  // Filter out coupons (new-style user-owned or legacy reward) that don't
  // belong to this user. Fail CLOSED: with no authenticated userId, every
  // ownership-restricted coupon is excluded rather than shown - a cart
  // query must never leak another user's personal/reward coupon code.
  const filteredResult: typeof result = [];
  for (const coupon of result) {
    const ownership = await resolveCouponOwnership(coupon);
    if (!ownership.isOwnershipRestricted) {
      filteredResult.push(coupon);
      continue;
    }
    if (!userId) continue;
    if (ownership.ownerUserId !== userId) continue;
    if (ownership.rewardStatus && ownership.rewardStatus !== "issued") continue;
    filteredResult.push(coupon);
  }

  return filteredResult.map((coupon: any) => {
    const discountValueNum = Number.parseFloat(String(coupon.discountValue ?? "0"));
    const minPurchaseNum = Number.parseFloat(String(coupon.minPurchaseAmount ?? "0"));

    const discountValue = Number.isFinite(discountValueNum) ? discountValueNum : 0;
    const minPurchaseAmount = Number.isFinite(minPurchaseNum) ? minPurchaseNum : 0;

    const canUse = safeSubtotal >= minPurchaseAmount;
    const needMoreAmount = Math.max(0, minPurchaseAmount - safeSubtotal);
    const usageCount = coupon.usageCount ?? 0;
    const remainingUsageCount = coupon.maxUsageCount
      ? Math.max(0, coupon.maxUsageCount - usageCount)
      : null;

    return {
      id: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: discountValue.toFixed(2),
      minPurchaseAmount: minPurchaseAmount.toFixed(2),
      maxUsageCount: coupon.maxUsageCount,
      usageCount,
      remainingUsageCount,
      expiresAt: coupon.expiresAt,
      canUse,
      needMoreAmount: needMoreAmount.toFixed(2),
      discountLabel:
        coupon.discountType === "percentage"
          ? `Discount ${discountValue.toFixed(discountValue % 1 === 0 ? 0 : 2)}%`
          : `Discount ฿${discountValue.toFixed(2)}`,
    };
  });
}

/**
 * Resolves and validates the final {scope, ownerUserId} pair for a
 * create/update, given the caller's partial patch and (for updates) the
 * coupon's current values. Enforces the invariant scope="user" <=>
 * ownerUserId set at the single point both createCoupon and updateCoupon
 * write through - never a DB CHECK constraint, consistent with how every
 * other cross-field invariant in this schema is enforced in code.
 *
 * `ownerUserId` is never trusted as a bare client-supplied ID: this always
 * re-resolves it against a real `users` row via getUserById before
 * accepting it, so a stale/fabricated/typo'd ID fails loudly here instead
 * of silently creating an unowned-in-practice "personal" coupon.
 */
async function resolveCouponScopeAndOwner(
  input: { scope?: "global" | "user"; ownerUserId?: number | null },
  current?: { scope: string; ownerUserId: number | null }
): Promise<{ scope: "global" | "user"; ownerUserId: number | null }> {
  const scope: "global" | "user" = input.scope ?? (current?.scope as "global" | "user" | undefined) ?? "global";
  const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : current?.ownerUserId ?? null;

  if (scope === "user") {
    if (!ownerUserId) {
      throw new Error("A user-specific coupon requires an owner");
    }
    const owner = await getUserById(ownerUserId);
    if (!owner) {
      throw new Error("Owner user not found");
    }
    return { scope: "user", ownerUserId };
  }

  if (ownerUserId) {
    throw new Error("A global coupon must not have an owner");
  }
  return { scope: "global", ownerUserId: null };
}

/** True if a coupon has ever actually been used - by usage record, or by a
 *  legacy reward-table "used" status (covers the rare case a reward coupon
 *  was marked used without ever going through couponUsages). Used to block
 *  destructive/ownership-changing edits on a coupon with real history. */
async function hasCouponBeenUsed(couponId: number): Promise<boolean> {
  const database = await getDb();
  if (!database) return false;

  const usages = await database
    .select({ id: couponUsages.id })
    .from(couponUsages)
    .where(eq(couponUsages.couponId, couponId))
    .limit(1);
  if (usages.length > 0) return true;

  const ownership = await getRewardCouponOwnership(couponId);
  return ownership?.status === "used";
}

export async function createCoupon(data: {
  code: string;
  discountType: "flat" | "percentage";
  discountValue: string;
  minPurchaseAmount?: string;
  maxUsageCount?: number;
  expiresAt?: Date;
  scope?: "global" | "user";
  ownerUserId?: number | null;
}) {
  const db = await getDb();
  if (!db) return undefined;

  // Personal coupons created explicitly by an admin default to "user" scope
  // is opt-in, not automatic - resolveCouponScopeAndOwner defaults to
  // "global" when `scope` is omitted, preserving every existing caller's
  // behavior (including plain promotional coupons and reward-coupon
  // issuance, which never pass `scope` at all).
  const { scope, ownerUserId } = await resolveCouponScopeAndOwner(data);

  // Normalize code: uppercase for consistency
  const normalizedCode = String(data.code || "").trim().toUpperCase();
  const insertCoupon = (writeDb: any) =>
    writeDb.insert(coupons).values({
      code: normalizedCode,
      discountType: data.discountType,
      discountValue: data.discountValue as any,
      minPurchaseAmount: data.minPurchaseAmount as any,
      maxUsageCount: data.maxUsageCount,
      expiresAt: data.expiresAt,
      isActive: true,
      usageCount: 0,
      scope,
      ownerUserId,
    });

  // Only user-scoped coupons are classified account value. Global campaign
  // coupons remain unrelated to a Source account and keep their existing path.
  if (ownerUserId) {
    return withAccountMergeClassifiedMutationGuard(ownerUserId, undefined, insertCoupon);
  }
  return insertCoupon(db);
}

export async function updateCoupon(couponId: number, data: {
  code?: string;
  discountType?: "flat" | "percentage";
  discountValue?: string;
  minPurchaseAmount?: string;
  maxUsageCount?: number;
  expiresAt?: Date;
  isActive?: boolean;
  scope?: "global" | "user";
  ownerUserId?: number | null;
}) {
  const db = await getDb();
  if (!db) return;

  const existingRows = await db.select().from(coupons).where(eq(coupons.id, couponId)).limit(1);
  const current = existingRows[0];
  if (!current) {
    throw new Error("Coupon not found");
  }

  const normalizedData: any = { ...data };
  let nextOwnerUserId: number | null = current.ownerUserId ?? null;
  if (data.code) {
    normalizedData.code = String(data.code).trim().toUpperCase();
  }

  if (data.scope !== undefined || data.ownerUserId !== undefined) {
    const changingOwnerOrScope =
      (data.scope !== undefined && data.scope !== current.scope) ||
      (data.ownerUserId !== undefined && data.ownerUserId !== current.ownerUserId);
    if (changingOwnerOrScope && (await hasCouponBeenUsed(couponId))) {
      throw new Error("Cannot change scope or owner of a coupon that has already been used");
    }
    const resolved = await resolveCouponScopeAndOwner(data, current as any);
    normalizedData.scope = resolved.scope;
    normalizedData.ownerUserId = resolved.ownerUserId;
    nextOwnerUserId = resolved.ownerUserId;
  }

  const ownerIds = [current.ownerUserId, nextOwnerUserId].filter(
    (id): id is number => typeof id === "number" && id > 0
  );
  if (ownerIds.length > 0) {
    await db.transaction(async (tx: any) => {
      await assertAccountMergeClassifiedMutationsAllowed(ownerIds, tx);
      await tx.update(coupons).set(normalizedData).where(eq(coupons.id, couponId));
    });
    return;
  }

  await db.update(coupons).set(normalizedData).where(eq(coupons.id, couponId));
}

export async function deleteCoupon(couponId: number) {
  const db = await getDb();
  if (!db) return;
  const currentRows = await db.select().from(coupons).where(eq(coupons.id, couponId)).limit(1);
  const current = currentRows[0];
  if (!current) return;

  // Never delete a coupon with real usage history, or one still linked to a
  // reward-issuance row at all (even unused) - deleting it would leave a
  // dangling sportsMatchRewards/dailyCheckins.couponId reference. Deactivate
  // (isActive: false) instead in both cases.
  if (await hasCouponBeenUsed(couponId)) {
    throw new Error("Cannot delete a coupon with usage history - deactivate it instead");
  }
  const ownership = await getRewardCouponOwnership(couponId);
  if (ownership) {
    throw new Error("Cannot delete a reward coupon - deactivate it instead");
  }

  if (current.ownerUserId) {
    await withAccountMergeClassifiedMutationGuard(current.ownerUserId, undefined, async (guardedDb) => {
      await guardedDb.delete(coupons).where(eq(coupons.id, couponId));
    });
    return;
  }

  await db.delete(coupons).where(eq(coupons.id, couponId));
}

/**
 * Locks the coupon row (SELECT ... FOR UPDATE) for the duration of a
 * usage-consumption check - same pattern as lockUserForPoints/
 * lockCartForCheckout above, EXCEPT this selects every column (not just
 * `id`) and returns the full row, which callers must use directly instead
 * of re-reading the coupon afterward.
 *
 * That difference is required, not stylistic: confirmed by a real
 * concurrency run (server/couponOwnership.integration.test.ts's two-orders-
 * race-one-single-use-reward-coupon scenario) that a SELECT-id-only lock
 * followed by a SEPARATE plain (non-FOR UPDATE) re-read of usageCount for
 * the actual limit check is unsafe under InnoDB REPEATABLE READ: a plain
 * read inside an already-open transaction can return that transaction's
 * consistent snapshot from before this lock was even acquired, rather than
 * the row this FOR UPDATE just locked - only a locking read is guaranteed
 * to see the latest committed value. Two concurrent finalizations for
 * DIFFERENT orders against the same maxUsageCount=1 coupon both read
 * usageCount=0 this way and both recorded usage, reaching usageCount=2 -
 * reproduced against a real disposable database, not a theoretical concern.
 */
export async function lockCouponForUsage(couponId: number, tx: any) {
  const rawResult: any = await tx.execute(sql`SELECT * FROM coupons WHERE id = ${couponId} FOR UPDATE`);
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  if (!rows || rows.length === 0) throw new Error("Coupon not found");
  return rows[0];
}

/**
 * Runs `fn` with the given coupon's row locked, same self-transacting
 * convention as withUserPointsLock: if `tx` is already an open transaction,
 * the lock is taken inside it; otherwise this opens its own transaction
 * scoped to exactly `fn`. `fn` receives the locked row itself (from the
 * FOR UPDATE read) as its second argument - see lockCouponForUsage's own
 * comment for why every usage-limit decision must be made from that row,
 * never from a later, separate, non-locking re-read.
 */
export async function withCouponLock<T>(
  couponId: number,
  tx: any | undefined,
  fn: (lockedTx: any, lockedCoupon: any) => Promise<T>
): Promise<T> {
  if (tx) {
    const lockedCoupon = await lockCouponForUsage(couponId, tx);
    return fn(tx, lockedCoupon);
  }
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async (newTx: any) => {
    const lockedCoupon = await lockCouponForUsage(couponId, newTx);
    return fn(newTx, lockedCoupon);
  });
}

/**
 * Records a coupon's consumption for one order - the actual point a
 * single-use coupon (maxUsageCount or a reward coupon's one-time "issued"
 * status) gets spent. Locks the coupon row and RE-VERIFIES usage limit and
 * ownership/status under that lock before writing, because
 * validateAndApplyCoupon's own check (at order-creation time) can be long
 * before this exact moment for the slip/manual-approval path - a second
 * single-use order could have been approved in between. Two concurrent
 * calls for the same coupon (different orders) are serialized by the lock:
 * the loser re-reads the winner's already-committed usageCount/status and
 * correctly throws instead of double-spending it.
 *
 * Idempotent per (couponId, orderId): re-finalizing the SAME order is a
 * safe no-op, checked before the lock is even taken since it never races
 * against other orders.
 */
export async function recordCouponUsage(
  couponId: number,
  userId: number | undefined,
  orderId: number,
  tx?: any
): Promise<{ recorded?: boolean; alreadyRecorded?: boolean }> {
  if (userId && !tx) {
    return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedTx) =>
      recordCouponUsage(couponId, userId, orderId, guardedTx)
    );
  }
  const readDb = tx || (await getDb());
  if (!readDb) return { recorded: false };
  if (userId && tx) {
    // Canonical hierarchy: Source users-row / merge guard before coupon row.
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
  }

  const existing = await readDb.select().from(couponUsages)
    .where(and(eq(couponUsages.couponId, couponId), eq(couponUsages.orderId, orderId)));
  if (existing && existing.length > 0) {
    return { alreadyRecorded: true };
  }

  return withCouponLock(couponId, tx, async (lockedTx, coupon) => {
    if (!coupon) {
      throw new Error("Coupon not found");
    }

    if (coupon.maxUsageCount != null && coupon.usageCount >= coupon.maxUsageCount) {
      throw new Error("Coupon usage limit reached");
    }

    const ownership = await resolveCouponOwnership(coupon, lockedTx);
    if (ownership.isOwnershipRestricted) {
      if (!userId || ownership.ownerUserId !== userId) {
        // Same generic message as "not found" - never confirm to a caller
        // who isn't the owner that this code exists and belongs to someone
        // else. In practice unreachable here because validateAndApplyCoupon
        // already enforced this at order creation, but this lock is the
        // real guarantee, not that earlier check.
        throw new Error("Coupon not found");
      }
      if (ownership.rewardStatus && ownership.rewardStatus !== "issued") {
        throw new Error(`Reward coupon is no longer usable (status: ${ownership.rewardStatus})`);
      }
    }

    try {
      await lockedTx.insert(couponUsages).values({ couponId, userId, orderId });
      await lockedTx.update(coupons).set({ usageCount: sql`${coupons.usageCount} + 1` }).where(eq(coupons.id, couponId));
      return { recorded: true };
    } catch (err: any) {
      // Handle unique constraint violation gracefully (duplicate key error) -
      // belt-and-suspenders alongside the pre-lock idempotency check above.
      // isDuplicateKeyError walks the cause chain: drizzle wraps the mysql2
      // error, so `err.code` is undefined here.
      if (isDuplicateKeyError(err)) {
        return { alreadyRecorded: true };
      }
      throw err;
    }
  });
}

export async function getCouponUsageByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(couponUsages).where(eq(couponUsages.userId, userId));
}

export async function getCouponUsageByOrderId(orderId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(couponUsages).where(eq(couponUsages.orderId, orderId));
}

// ============ POINTS ============

export async function getUserPointsBalance(userId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return "0.00";

  // `id DESC` is a required tiebreaker, not decoration: pointsTransactions
  // .createdAt is a MySQL `timestamp` with second-level precision, so two
  // transactions written in the same second carry an identical createdAt.
  // Ordering by createdAt alone leaves those rows tied, and which one the
  // engine returns for LIMIT 1 is then unspecified - it could hand back a
  // stale balanceAfter and silently rewind the user's balance. The
  // autoincrement id is strictly monotonic per insert, so (createdAt DESC,
  // id DESC) makes "the latest transaction" deterministic.
  const result = await db
    .select({ balanceAfter: pointsTransactions.balanceAfter })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId))
    .orderBy(desc(pointsTransactions.createdAt), desc(pointsTransactions.id))
    .limit(1);

  return result.length > 0 ? result[0].balanceAfter.toString() : "0.00";
}

export async function recordPointsTransaction(data: {
  userId: number;
  type: "earn" | "redeem" | "adjust" | "refund";
  amount: string;
  balanceAfter: string;
  referenceType?: string;
  referenceId?: number;
  note?: string;
}, tx?: any) {
  await withAccountMergeClassifiedMutationGuard(data.userId, tx, async (guardedDb) => {
    await guardedDb.insert(pointsTransactions).values({
      userId: data.userId,
      type: data.type,
      amount: data.amount as any,
      balanceAfter: data.balanceAfter as any,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      note: data.note,
    });
  });
}

/**
 * Same insert as recordPointsTransaction, but returns the new row's id.
 *
 * Added rather than changing recordPointsTransaction's signature so every
 * existing caller keeps working untouched. The id is required by the Daily
 * Check-in point reward, which stores it on dailyCheckinRewardGrants
 * .pointsTransactionId (a UNIQUE column) - that link is both the audit trail
 * back to the exact ledger row and one of the guards that makes a second
 * credit for the same grant structurally impossible.
 *
 * Callers must compute balanceAfter INSIDE the same transaction, after
 * taking the user lock - this helper deliberately does not read the balance
 * itself, so the read-modify-write stays in one place under one lock.
 */
export async function recordPointsTransactionReturningId(data: {
  userId: number;
  type: "earn" | "redeem" | "adjust" | "refund";
  amount: string;
  balanceAfter: string;
  referenceType?: string;
  referenceId?: number;
  note?: string;
}, tx?: any): Promise<number> {
  return withAccountMergeClassifiedMutationGuard(data.userId, tx, async (guardedDb) => {
    const result = await guardedDb.insert(pointsTransactions).values({
      userId: data.userId,
      type: data.type,
      amount: data.amount as any,
      balanceAfter: data.balanceAfter as any,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      note: data.note,
    });
    return extractInsertId(result);
  });
}

export async function getPointsHistory(userId: number, limit?: number) {
  const db = await getDb();
  if (!db) return [];
  let query: any = db.select().from(pointsTransactions).where(eq(pointsTransactions.userId, userId)).orderBy(desc(pointsTransactions.createdAt));
  if (limit) query = query.limit(limit);
  return query;
}

// Alias for getPointsHistory
export const getPointsTransactions = getPointsHistory;

/**
 * Convenience wrapper: add a points transaction with a simple signature
 * Used by tests and admin tools
 */
export async function addPointsTransaction(
  userId: number,
  amount: number,
  referenceType: string,
  note: string
): Promise<void> {
  const currentBalance = await getUserPointsBalance(userId);
  const currentBalanceNum = parseFloat(currentBalance || "0");
  const newBalance = (currentBalanceNum + amount).toFixed(2);
  await recordPointsTransaction({
    userId,
    type: amount >= 0 ? "earn" : "redeem",
    amount: Math.abs(amount).toString(),
    balanceAfter: newBalance,
    referenceType,
    note,
  });
}

// ============ WISHLISTS ============

export async function getWishlistByUserAndNovel(userId: number, novelId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(wishlists)
    .where(and(eq(wishlists.userId, userId), eq(wishlists.novelId, novelId)))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getWishlistsByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(wishlists).where(eq(wishlists.userId, userId));
}

export type ProfileWishlistItem = {
  wishlistId: number;
  novelId: number;
  addedAt: Date;
  novel: {
    id: number;
    title: string;
    slug: string;
    description: string | null;
    coverImageUrl: string | null;
    storyStatus: "ongoing" | "finished";
  };
};

/**
 * Wishlist rows for a user, joined with their novel in a single query - used
 * by wishlists.list (see routers.ts) instead of the old pattern of loading
 * every wishlist row then calling getNovelById() per row (N+1). Only
 * published novels are returned: a novel archived after being wishlisted
 * just disappears from this list - its wishlist row is deliberately left
 * alone (never auto-deleted here), so it reappears if the novel is
 * unarchived later.
 *
 * Deliberately throws (never returns []) when the database itself is
 * unavailable - an empty array is a real, meaningful result ("this user has
 * no wishlist items") and must never be indistinguishable from "couldn't
 * even ask the database." The caller (wishlists.list in routers.ts) is
 * responsible for turning this into a safe, generic client-facing error.
 */
export async function getWishlistNovelsByUserId(userId: number): Promise<ProfileWishlistItem[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("[Database] Database connection is not available");
  }

  return db
    .select({
      wishlistId: wishlists.id,
      novelId: wishlists.novelId,
      addedAt: wishlists.createdAt,
      novel: {
        id: novels.id,
        title: novels.title,
        slug: novels.slug,
        description: novels.description,
        coverImageUrl: novels.coverImageUrl,
        storyStatus: novels.storyStatus,
      },
    })
    .from(wishlists)
    .innerJoin(novels, eq(wishlists.novelId, novels.id))
    .where(and(eq(wishlists.userId, userId), eq(novels.publicationStatus, "published")))
    .orderBy(desc(wishlists.createdAt));
}

export async function addToWishlist(userId: number, novelId: number) {
  await withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    await guardedDb.insert(wishlists).values({ userId, novelId });
  });
}

export async function removeFromWishlist(wishlistId: number) {
  const database = await getDb();
  if (!database) return;
  const rows = await database.select({ userId: wishlists.userId }).from(wishlists).where(eq(wishlists.id, wishlistId)).limit(1);
  const userId = rows[0]?.userId;
  if (!userId) return;
  await withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    await guardedDb.delete(wishlists).where(eq(wishlists.id, wishlistId));
  });
}

// ============ BANNERS ============

export async function getAllBanners() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(banners).where(eq(banners.isActive, true)).orderBy(asc(banners.displayOrder));
}

// Admin version: returns all banners including inactive ones
export async function getAllBannersAdmin() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(banners).orderBy(asc(banners.displayOrder));
}

export async function createBanner(data: { title: string; description?: string; imageUrl: string; linkUrl?: string; displayOrder?: number }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(banners).values({
    title: data.title,
    description: data.description,
    imageUrl: data.imageUrl,
    linkUrl: data.linkUrl,
    displayOrder: data.displayOrder || 0,
    isActive: true,
  });
}

export async function updateBanner(bannerId: number, data: { title?: string; description?: string; imageUrl?: string; linkUrl?: string; displayOrder?: number; isActive?: boolean }) {
  const db = await getDb();
  if (!db) return;
  await db.update(banners).set(data).where(eq(banners.id, bannerId));
}

export async function deleteBanner(bannerId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(banners).where(eq(banners.id, bannerId));
}

/**
 * Compare-and-set update used ONLY by the OCR recheck path.
 *
 * A recheck validates that the payment is pending BEFORE its slow provider
 * work. An admin can approve or reject during that window, so an
 * unconditional write afterwards would overwrite finalized evidence - and for
 * an approval the persisted extraction could then disagree with the
 * identifiers already written to paymentSlipClaims.
 *
 * This only writes while the payment is still non-finalized, and reports
 * whether it actually did. Callers MUST treat `false` as "the recheck lost
 * the race" and change nothing.
 *
 * `status` and `slipSubmittedAt` are deliberately not writable through this
 * helper: a recheck is diagnostic and must never move the payment or rewrite
 * the customer's submission time.
 */
export async function updatePaymentIfNotFinalized(
  paymentId: number,
  fields: {
    extractedData?: string | null;
    ocrConfidence?: number;
    reviewReason?: string | null;
    ocrDecision?: "auto_approved" | "needs_review" | "rejected" | "ocr_disabled" | "shadow_auto_approved";
  },
  tx?: any,
  /**
   * When provided, the write also requires `slipImageUrl`/`slipSubmittedAt`
   * to still match this exact pair. A recheck captures the slip version it
   * started against; if the customer replaces the slip while the recheck is
   * still running, the version no longer matches and this write is refused -
   * a status-only CAS would have let a recheck of the OLD slip land its
   * result on the NEW one, since replacing a slip does not change status.
   */
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null }
): Promise<boolean> {
  const database = tx || (await getDb());
  if (!database) return false;

  const conditions = [
    eq(payments.id, paymentId),
    // The non-finalized set. An approved/rejected payment is excluded, so
    // its evidence can never be clobbered by a late-finishing recheck.
    or(eq(payments.status, "pending"), eq(payments.status, "pending_review")),
  ];

  if (expectedSlipVersion) {
    conditions.push(
      expectedSlipVersion.slipImageUrl === null
        ? isNull(payments.slipImageUrl)
        : eq(payments.slipImageUrl, expectedSlipVersion.slipImageUrl)
    );
    conditions.push(
      expectedSlipVersion.slipSubmittedAt === null
        ? isNull(payments.slipSubmittedAt)
        : eq(payments.slipSubmittedAt, expectedSlipVersion.slipSubmittedAt)
    );
  }

  return withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
    const result = await guardedDb
      .update(payments)
      .set(fields as any)
      .where(and(...conditions));

    const header = Array.isArray(result) ? result[0] : result;
    return ((header as any)?.affectedRows || 0) > 0;
  });
}

/**
 * Atomically publishes a replacement slip upload. The SAME write that makes
 * the new slip current also invalidates whatever OCR evidence belonged to
 * the slip it replaces, so `slipImageUrl = B` can never be paired with
 * `extractedData` still describing A - not even for the instant between two
 * separate statements.
 *
 * `fields.extractedData` should already be seeded with the NEW slip's own
 * server-derived identifier (fileHash) when available, so a replacement
 * slip is never left with zero anti-replay protection while OCR is still
 * running against it.
 *
 * Conditioned on the payment still being reviewable (pending/pending_review):
 * an approved/rejected payment can never be reopened by a replacement
 * upload that was being prepared while it got finalized. Returns false when
 * that race was lost; callers MUST treat false as "nothing published" and
 * must not proceed to run OCR or any further write against this upload.
 */
export async function publishReplacementSlipIfReviewable(
  paymentId: number,
  fields: {
    slipImageUrl: string;
    slipSubmittedAt: Date;
    extractedData: string | null;
  }
): Promise<boolean> {
  const database = await getDb();
  if (!database) return false;

  return withAccountMergePaymentMutationGuard(paymentId, undefined, async (guardedDb) => {
    const result = await guardedDb
      .update(payments)
      .set({
        slipImageUrl: fields.slipImageUrl,
        slipSubmittedAt: fields.slipSubmittedAt,
        status: "pending",
        extractedData: fields.extractedData,
        // Stale OCR verdicts from the replaced slip must not linger next to
        // the new one - a leftover confidence/decision/reason would describe
        // evidence for a slip that is no longer even displayed.
        ocrConfidence: 0,
        ocrDecision: "needs_review",
        reviewReason: null,
        fingerprint: null,
      })
      .where(
        and(
          eq(payments.id, paymentId),
          or(eq(payments.status, "pending"), eq(payments.status, "pending_review"))
        )
      );

    const header = Array.isArray(result) ? result[0] : result;
    return ((header as any)?.affectedRows || 0) > 0;
  });
}

/**
 * Locks a payment row for the rest of the transaction (SELECT ... FOR UPDATE).
 *
 * Approval reads the persisted `extractedData`, decides on it, claims its
 * identifiers and only THEN writes the status. Without a lock a concurrent
 * Recheck could rewrite that extraction inside the window, so the money
 * would be committed against evidence nobody evaluated. Locking first makes
 * the subject stable from revalidation through commit; the Recheck blocks,
 * and once this commits its compare-and-set finds a finalized payment and
 * no-ops - the existing CAS guarantee is unchanged, just no longer racy.
 *
 * Always called with an explicit transaction: locking outside one would
 * release immediately and defeat the purpose. Returns false when the row
 * does not exist.
 */
export async function lockPaymentForUpdate(paymentId: number, tx: any): Promise<boolean> {
  // mysql2's raw .execute() resolves to a [rows, fields] tuple, not the bare
  // rows array - unwrapped the same way lockCartForCheckout does.
  const rawResult: any = await tx.execute(
    sql`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`
  );
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return Boolean(rows && rows.length > 0);
}

/**
 * Locks a wallet top-up row for the rest of the transaction. Same reasoning
 * as lockPaymentForUpdate: the extraction a decision rests on must not change
 * between revalidation and the credit.
 */
export async function lockWalletTopupForUpdate(topupId: number, tx: any): Promise<boolean> {
  const rawResult: any = await tx.execute(
    sql`SELECT id FROM walletTopups WHERE id = ${topupId} FOR UPDATE`
  );
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return Boolean(rows && rows.length > 0);
}

/**
 * Conditionally rejects a payment, ONLY while it is still reviewable.
 *
 * Returns true iff THIS call won the race. Used by the audited legacy-case
 * resolution flow, where the rejection and its resolution record must commit
 * together: an unconditional rejection could not tell "I rejected it" from
 * "someone else already finalized it", so a resolution row was committed for
 * a state this call never created.
 */
export async function rejectPaymentIfReviewable(
  paymentId: number,
  reviewedByUserId: number,
  rejectionReason: string,
  tx: any
): Promise<boolean> {
  const database = tx || (await getDb());
  if (!database) return false;

  return withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
    const result = await guardedDb
      .update(payments)
      .set({
        status: "rejected",
        rejectionReason,
        reviewedByUserId,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, paymentId),
          or(eq(payments.status, "pending"), eq(payments.status, "pending_review"))
        )
      );

    const header = Array.isArray(result) ? result[0] : result;
    return ((header as any)?.affectedRows || 0) > 0;
  });
}

// ============ SETTINGS ============

export async function getSetting(key: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function setSetting(key: string, value: string, description?: string) {
  const db = await getDb();
  if (!db) return;

  const existing = await getSetting(key);
  if (existing) {
    await db.update(settings).set({ value, description }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value, description });
  }
}

// ============ ORDER HISTORY ============

export async function recordOrderHistory(data: { orderId: number; action: string; fromStatus?: string; toStatus?: string; actorUserId?: number; note?: string }, tx?: any) {
  await withAccountMergeOrderMutationGuard(data.orderId, tx, async (guardedDb) => {
    await guardedDb.insert(orderHistory).values({
      orderId: data.orderId,
      action: data.action,
      fromStatus: data.fromStatus,
      toStatus: data.toStatus,
      actorUserId: data.actorUserId,
      note: data.note,
    });
  });
}

export async function getOrderHistory(orderId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orderHistory).where(eq(orderHistory.orderId, orderId)).orderBy(desc(orderHistory.createdAt));
}

// ============ BULK UPLOAD HELPERS ============

/**
 * Generate a unique slug from a title
 * If slug conflicts with existing novel, append a unique suffix
 */
export async function generateUniqueSlug(title: string, existingNovelId?: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Strip non-ASCII characters (e.g. Thai) and use timestamp fallback if empty
  let slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!slug) slug = `novel-${Date.now()}`;

  // Check if slug already exists
  const existing = await db
    .select()
    .from(novels)
    .where(eq(novels.slug, slug))
    .limit(1);

  if (existing.length === 0 || (existingNovelId && existing[0].id === existingNovelId)) {
    return slug;
  }

  // Append unique suffix if conflict
  let counter = 1;
  while (true) {
    const newSlug = `${slug}-${counter}`;
    const conflict = await db
      .select()
      .from(novels)
      .where(eq(novels.slug, newSlug))
      .limit(1);
    if (conflict.length === 0) {
      return newSlug;
    }
    counter++;
  }
}

/**
 * Bulk create novels from CSV data
 * Validates and returns errors for invalid rows
 */
export async function bulkCreateNovels(
  rows: Array<{ title: string }>
): Promise<{
  success: Array<{ rowIndex: number; novelId: number; title: string }>;
  errors: Array<{ rowIndex: number; error: string }>;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const success: Array<{ rowIndex: number; novelId: number; title: string }> = [];
  const errors: Array<{ rowIndex: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Validate
    if (!row.title || !row.title.trim()) {
      errors.push({ rowIndex: i, error: "Title is required" });
      continue;
    }

    try {
      const slug = await generateUniqueSlug(row.title);
      const result = await db.insert(novels).values({
        title: row.title.trim(),
        author: "",
        description: "",
        coverImageUrl: "",
        slug,
        status: "ongoing",
      });

      const novelId = (result as any).insertId;
      success.push({ rowIndex: i, novelId, title: row.title });
    } catch (error) {
      errors.push({ rowIndex: i, error: `Failed to create: ${error instanceof Error ? error.message : "Unknown error"}` });
    }
  }

  return { success, errors };
}

/**
 * Bulk create episodes for a novel from CSV data
 * Validates and returns errors for invalid rows
 */
export async function bulkCreateEpisodes(
  novelId: number,
  rows: Array<{ title: string; episodeNumber: string; price: string; fileUrl: string }>
): Promise<{
  success: Array<{ rowIndex: number; episodeId: number; title: string; price: string }>;
  errors: Array<{ rowIndex: number; error: string }>;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const success: Array<{ rowIndex: number; episodeId: number; title: string; price: string }> = [];
  const errors: Array<{ rowIndex: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Validate required fields
    if (!row.title || !row.title.trim()) {
      errors.push({ rowIndex: i, error: "Title is required" });
      continue;
    }

    if (!row.episodeNumber || !row.episodeNumber.trim()) {
      errors.push({ rowIndex: i, error: "Episode number is required" });
      continue;
    }

    if (!row.price) {
      errors.push({ rowIndex: i, error: "Price is required" });
      continue;
    }

    // Validate price is numeric
    const priceNum = parseFloat(row.price);
    if (isNaN(priceNum)) {
      errors.push({ rowIndex: i, error: `Invalid price: "${row.price}" is not a number` });
      continue;
    }

    if (!row.fileUrl || !row.fileUrl.trim()) {
      errors.push({ rowIndex: i, error: "File URL is required" });
      continue;
    }

    try {
      // Determine if free based on price
      const isFree = priceNum === 0;

      const result = await db.insert(episodes).values({
        novelId,
        episodeNumber: row.episodeNumber.trim(),
        title: row.title.trim(),
        price: row.price.trim(),
        isFree,
        fileUrl: row.fileUrl.trim(),
      });

      const episodeId = (result as any).insertId;
      success.push({ rowIndex: i, episodeId, title: row.title, price: row.price });
    } catch (error) {
      errors.push({ rowIndex: i, error: `Failed to create: ${error instanceof Error ? error.message : "Unknown error"}` });
    }
  }

  return { success, errors };
}

/**
 * Find novel by title with exact normalized matching
 * Trim spaces and case-insensitive comparison
 * Returns null if no match, throws error if multiple matches
 */
export async function findNovelByTitle(title: string): Promise<{ id: number; title: string } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const normalizedTitle = title.trim().toLowerCase();
  const allNovels = await db.select().from(novels);
  
  const matches = allNovels.filter((n: any) => n.title.trim().toLowerCase() === normalizedTitle);

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    throw new Error(`Multiple novels match title "${title}". Please be more specific.`);
  }

  return { id: matches[0].id, title: matches[0].title };
}

/**
 * Bulk create episodes with novel title matching
 * CSV format: novelTitle,title,episodeNumber,price,fileUrl
 */
export async function bulkCreateEpisodesWithNovelTitle(
  rows: Array<{ novelTitle: string; title: string; episodeNumber: string; price: string; fileUrl: string }>
): Promise<{
  success: Array<{ rowIndex: number; episodeId: number; novelTitle: string; episodeTitle: string; novelId: number; price: string }>;
  errors: Array<{ rowIndex: number; error: string }>;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const success: Array<{ rowIndex: number; episodeId: number; novelTitle: string; episodeTitle: string; novelId: number; price: string }> = [];
  const errors: Array<{ rowIndex: number; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Validate required fields
    if (!row.novelTitle || !row.novelTitle.trim()) {
      errors.push({ rowIndex: i, error: "Novel title is required" });
      continue;
    }

    if (!row.title || !row.title.trim()) {
      errors.push({ rowIndex: i, error: "Episode title is required" });
      continue;
    }

    if (!row.episodeNumber || !row.episodeNumber.trim()) {
      errors.push({ rowIndex: i, error: "Episode number is required" });
      continue;
    }

    if (!row.price) {
      errors.push({ rowIndex: i, error: "Price is required" });
      continue;
    }

    // Validate price is numeric
    const priceNum = parseFloat(row.price);
    if (isNaN(priceNum)) {
      errors.push({ rowIndex: i, error: `Invalid price: "${row.price}" is not a number` });
      continue;
    }

    if (!row.fileUrl || !row.fileUrl.trim()) {
      errors.push({ rowIndex: i, error: "File URL is required" });
      continue;
    }

    try {
      // Find novel by title
      const novel = await findNovelByTitle(row.novelTitle);
      if (!novel) {
        errors.push({ rowIndex: i, error: `No novel found with title "${row.novelTitle}"` });
        continue;
      }

      // Determine if free based on price
      const isFree = priceNum === 0;

      // Create episode
      const result = await db.insert(episodes).values({
        novelId: novel.id,
        episodeNumber: row.episodeNumber.trim(),
        title: row.title.trim(),
        price: row.price.trim(),
        isFree,
        fileUrl: row.fileUrl.trim(),
      });

      const episodeId = (result as any).insertId;
      success.push({
        rowIndex: i,
        episodeId,
        novelTitle: novel.title,
        episodeTitle: row.title,
        novelId: novel.id,
        price: row.price,
      });
    } catch (error) {
      errors.push({
        rowIndex: i,
        error: `Failed to create: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  return { success, errors };
}


/**
 * Check if points have already been awarded for a given order
 * Returns true if an "earn" transaction exists for this order
 */
export async function hasPointsBeenAwardedForOrder(orderId: number, tx?: any): Promise<boolean> {
  const db = tx || await getDb();
  if (!db) return false;

  const result = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.referenceType, "order"),
        eq(pointsTransactions.referenceId, orderId),
        eq(pointsTransactions.type, "earn")
      )
    )
    .limit(1);

  return result.length > 0;
}

export async function hasPointsBeenRedeemedForOrder(orderId: number, tx?: any): Promise<boolean> {
  const db = tx || await getDb();
  if (!db) return false;

  const result = await db
    .select({ id: pointsTransactions.id })
    .from(pointsTransactions)
    .where(
      and(
        eq(pointsTransactions.referenceType, "order"),
        eq(pointsTransactions.referenceId, orderId),
        eq(pointsTransactions.type, "redeem")
      )
    )
    .limit(1);

  return result.length > 0;
}

// ============ HOME PAGE & CATALOG QUERIES ============

/**
 * Type for novel with computed counts
 */
export interface NovelWithCounts extends Novel {
  purchaseCount: number;
  wishlistCount: number;
  freeEpisodeCount: number;
}

/**
 * Get popular novels for the homepage: pulls the top `candidateLimit` novels
 * ranked by purchaseCount DESC, wishlistCount DESC, createdAt DESC, then
 * returns a random sample of `limit` from that pool - so the section still
 * only ever surfaces genuinely popular novels, but doesn't show the exact
 * same 4 on every load. Uses aggregate subqueries to avoid N+1 queries.
 */
export async function getPopularNovels(limit: number = 4, candidateLimit: number = 30): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];
  const poolSize = Math.max(candidateLimit, limit);

  // Subquery for purchase counts per novel
  const purchaseCountsSubquery = db
    .select({
      novelId: purchases.novelId,
      count: sql<number>`COUNT(DISTINCT ${purchases.userId})`.as("purchaseCount"),
    })
    .from(purchases)
    .groupBy(purchases.novelId)
    .as("purchaseCounts");

  // Subquery for wishlist counts per novel
  const wishlistCountsSubquery = db
    .select({
      novelId: wishlists.novelId,
      count: sql<number>`COUNT(DISTINCT ${wishlists.userId})`.as("wishlistCount"),
    })
    .from(wishlists)
    .groupBy(wishlists.novelId)
    .as("wishlistCounts");

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`,
      wishlistCount: sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`,
      freeEpisodeCount: sql<number>`0`, // Placeholder, not used for popular
    })
    .from(novels)
    .where(eq(novels.publicationStatus, "published")) // Only published novels
    .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
    .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId))
    .orderBy(
      desc(sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`),
      desc(sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`),
      desc(novels.createdAt),
      desc(novels.id) // tie-breaker for novels matching on every prior column
    )
    .limit(poolSize);

  // Normalize counts to numbers, then randomly sample `limit` from the
  // popular-novels pool (not the whole table) so ordering stays meaningful.
  const normalized = result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: 0,
  }));
  return pickRandom(normalized, limit);
}

/**
 * Get new novels sorted by createdAt DESC.
 *
 * Phase 3 perf note: this used to LEFT JOIN a purchaseCounts and a
 * wishlistCounts GROUP BY subquery (identical to getPopularNovels') purely
 * to populate the NovelWithCounts.purchaseCount/wishlistCount fields - but
 * this section sorts only by createdAt and neither field is ever read by
 * the frontend (grepped client/src - confirmed unused). Removed both joins
 * entirely instead of computing-then-discarding them; the fields stay
 * present in the return shape (always 0) so NovelWithCounts/the tRPC output
 * shape don't change. See docs/PERFORMANCE_SEO_AUDIT.md Phase 3.
 */
export async function getNewNovels(limit: number = 4): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`0`,
      wishlistCount: sql<number>`0`,
      freeEpisodeCount: sql<number>`0`,
    })
    .from(novels)
    .where(eq(novels.publicationStatus, "published")) // Only published novels
    // id DESC as a tie-breaker for novels sharing the exact same createdAt
    // timestamp (e.g. bulk-imported rows) - same insertion-order tie-break
    // deterministic ordering already relied on implicitly, now explicit.
    .orderBy(desc(novels.createdAt), desc(novels.id))
    .limit(limit);

  return result.map((row: any) => ({
    ...row,
    purchaseCount: 0,
    wishlistCount: 0,
    freeEpisodeCount: 0,
  }));
}

/**
 * Get novels with free episodes sorted by createdAt DESC
 * Only returns novels that have at least one free episode
 */
// Phase 3 perf note: purchaseCounts/wishlistCounts subqueries were removed
// from this function - same reasoning as getNewNovels above (sort is by
// createdAt only, neither field is read by the frontend for this section).
// freeEpisodeCountsSubquery is kept - it's genuinely used both to filter
// (only novels with >=1 free episode) and in the returned freeEpisodeCount
// field, which client/src/pages/Home.tsx actually reads to show the "Free"
// badge (`showFreeTag && novel.freeEpisodeCount > 0`).
export async function getFreeNovels(limit: number = 4): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

  // Subquery for free episode counts per novel
  const freeEpisodeCountsSubquery = db
    .select({
      novelId: episodes.novelId,
      count: sql<number>`COUNT(${episodes.id})`.as("freeEpisodeCount"),
    })
    .from(episodes)
    .where(eq(episodes.isFree, true))
    .groupBy(episodes.novelId)
    .as("freeEpisodeCounts");

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`0`,
      wishlistCount: sql<number>`0`,
      freeEpisodeCount: sql<number>`COALESCE(${freeEpisodeCountsSubquery.count}, 0)`,
    })
    .from(novels)
    .innerJoin(freeEpisodeCountsSubquery, eq(novels.id, freeEpisodeCountsSubquery.novelId))
    .where(and(
      eq(novels.publicationStatus, "published"), // Only published novels
      sql<boolean>`${freeEpisodeCountsSubquery.count} > 0`
    ))
    .orderBy(desc(novels.createdAt), desc(novels.id))
    .limit(limit);

  return result.map((row: any) => ({
    ...row,
    purchaseCount: 0,
    wishlistCount: 0,
    freeEpisodeCount: Number(row.freeEpisodeCount) || 0,
  }));
}

/**
 * Get finished/completed novels for the homepage: pulls the most recent
 * `candidateLimit` published novels with storyStatus = 'finished', then
 * returns a random sample of `limit` from that pool - so the section only
 * ever shows genuinely finished novels, but doesn't repeat the same 4 on
 * every load.
 *
 * Phase 3 perf note: purchaseCounts/wishlistCounts subqueries removed -
 * same reasoning as getNewNovels/getFreeNovels above (candidate pool is
 * ordered by createdAt only, then randomly sampled; neither field is read
 * by the frontend for this section).
 */
export async function getFinishedNovels(limit: number = 4, candidateLimit: number = 50): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];
  const poolSize = Math.max(candidateLimit, limit);

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`0`,
      wishlistCount: sql<number>`0`,
      freeEpisodeCount: sql<number>`0`,
    })
    .from(novels)
    .where(and(
      eq(novels.publicationStatus, "published"),
      eq(novels.storyStatus, "finished")
    ))
    .orderBy(desc(novels.createdAt), desc(novels.id))
    .limit(poolSize);

  const normalized = result.map((row: any) => ({
    ...row,
    purchaseCount: 0,
    wishlistCount: 0,
    freeEpisodeCount: 0,
  }));
  return pickRandom(normalized, limit);
}

/**
 * Get catalog novels with flexible sorting and filtering
 * Supports sort=new|popular and filter=all|free
 */
export async function getCatalogNovels(params: {
  sort?: "new" | "popular";
  filter?: "all" | "free";
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

  const { sort = "new", filter = "all", search, limit = 50, offset = 0 } = params;

  // Subquery for free episode counts per novel
  const freeEpisodeCountsSubquery = db
    .select({
      novelId: episodes.novelId,
      count: sql<number>`COUNT(${episodes.id})`.as("freeEpisodeCount"),
    })
    .from(episodes)
    .where(eq(episodes.isFree, true))
    .groupBy(episodes.novelId)
    .as("freeEpisodeCounts");

  // Subquery for purchase counts
  const purchaseCountsSubquery = db
    .select({
      novelId: purchases.novelId,
      count: sql<number>`COUNT(DISTINCT ${purchases.userId})`.as("purchaseCount"),
    })
    .from(purchases)
    .groupBy(purchases.novelId)
    .as("purchaseCounts");

  // Subquery for wishlist counts
  const wishlistCountsSubquery = db
    .select({
      novelId: wishlists.novelId,
      count: sql<number>`COUNT(DISTINCT ${wishlists.userId})`.as("wishlistCount"),
    })
    .from(wishlists)
    .groupBy(wishlists.novelId)
    .as("wishlistCounts");

  let query: any = db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`,
      wishlistCount: sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`,
      freeEpisodeCount: sql<number>`COALESCE(${freeEpisodeCountsSubquery.count}, 0)`,
    })
    .from(novels)
    .leftJoin(freeEpisodeCountsSubquery, eq(novels.id, freeEpisodeCountsSubquery.novelId))
    .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
    .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId));

  // Combine filter and search into a single .where() call to avoid overwriting
  const conditions: any[] = [
    eq(novels.publicationStatus, "published"), // Always filter for published novels
  ];
  if (filter === "free") {
    conditions.push(sql<boolean>`${freeEpisodeCountsSubquery.count} > 0`);
  }
  if (search && search.trim()) {
    const searchPattern = `%${search.trim()}%`;
    conditions.push(sql`${novels.title} LIKE ${searchPattern}`);
  }
  if (conditions.length === 1) {
    query = query.where(conditions[0]);
  } else if (conditions.length > 1) {
    query = query.where(and(...conditions));
  }

  // Apply sort
  if (sort === "popular") {
    query = query.orderBy(
      desc(sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`),
      desc(sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`),
      desc(novels.createdAt)
    );
  } else {
    // Default to "new"
    query = query.orderBy(desc(novels.createdAt));
  }

  // Apply pagination
  query = query.limit(limit).offset(offset);

  const result: any[] = await query;

  return result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: Number(row.freeEpisodeCount) || 0,
  }));
}


/**
 * Get the latest uploaded episodes with novel information
 * Used for the "Latest Uploaded Episodes" section on the Home page
 *
 * Phase 3 bug fix: this previously had NO visibility filter at all - an
 * episode with isPublished=false (a draft/scheduled chapter), or belonging
 * to an archived/unpublished novel, could appear on the public homepage.
 * Every other homepage section already filters novels.publicationStatus =
 * "published"; this one didn't, and also never checked episodes.isPublished.
 * Fixed by requiring both, matching the same visibility rule used
 * everywhere else on this page. Confirmed via grep this function has no
 * other caller, so this only affects the Home page's own "Latest Uploaded
 * Episodes" section - no admin/other page relies on the old, unfiltered
 * behavior. See docs/PERFORMANCE_SEO_AUDIT.md Phase 3.
 */
export async function getLatestEpisodes(limit: number = 4) {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select({
      id: episodes.id,
      novelId: episodes.novelId,
      novelTitle: novels.title,
      novelCoverImageUrl: novels.coverImageUrl,
      episodeNumber: episodes.episodeNumber,
      episodeTitle: episodes.title,
      isFree: episodes.isFree,
      createdAt: episodes.createdAt,
    })
    .from(episodes)
    .innerJoin(novels, eq(episodes.novelId, novels.id))
    .where(and(
      eq(episodes.isPublished, true),
      eq(novels.publicationStatus, "published")
    ))
    .orderBy(desc(episodes.createdAt), desc(episodes.id))
    .limit(limit);

  return result;
}


/**
 * Get lightweight browse catalog data - optimized for performance
 * Returns only essential fields needed for browse cards
 * Avoids expensive aggregate subqueries for counts
 */
export interface BrowseCatalogNovel {
  id: number;
  title: string;
  slug: string;
  coverImageUrl: string | null;
  storyStatus: string;
  createdAt: Date;
  freeEpisodeCount: number;
}

export interface BrowseCatalogResult {
  items: BrowseCatalogNovel[];
  /** True when at least one more row exists beyond this page - derived from
   *  a limit+1 fetch-ahead, never from a separate COUNT(*) query, since the
   *  /novels UI only needs to enable/disable "Next", not a total page count. */
  hasNextPage: boolean;
}

// LIKE wildcard characters (%, _) and the escape character itself must be
// escaped before being embedded in a user-controlled LIKE pattern, otherwise
// a search term containing them (e.g. "50%") is silently reinterpreted as a
// wildcard instead of matched literally. Parameterization already prevents
// SQL injection here; this only fixes match-correctness.
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function getBrowseCatalog(params: {
  sort?: "new" | "popular";
  filter?: "all" | "free";
  storyStatus?: "ongoing" | "finished";
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<BrowseCatalogResult> {
  const db = await getDb();
  if (!db) return { items: [], hasNextPage: false };

  const { sort = "new", filter = "all", storyStatus, search, limit = 20, offset = 0 } = params;
  // Fetch one extra row beyond the page size so hasNextPage reflects reality
  // instead of the old (buggy) `results.length === pageSize` heuristic, which
  // was wrong whenever the total row count was an exact multiple of the page
  // size (it would report hasNextPage=true for the last page).
  const fetchLimit = limit + 1;

  // Lightweight correlated EXISTS check instead of a GROUP BY over the whole
  // episodes table - the UI only ever needs a boolean "has a free episode"
  // (for the Free badge / the filter=free condition below), never an actual
  // count, so this can use the existing episodes_novelId_idx/isFree_idx
  // indexes as a per-row semi-join instead of aggregating every episode row
  // on every single browse request. Field name/shape (freeEpisodeCount,
  // truthy when > 0) is kept as-is for frontend backward compatibility - it
  // now just always resolves to 0 or 1 instead of a real count.
  const hasFreeEpisodeSql = () => sql<number>`EXISTS (
    SELECT 1 FROM ${episodes}
    WHERE ${episodes.novelId} = ${novels.id} AND ${episodes.isFree} = true
  )`;

  const browseConditions: any[] = [
    eq(novels.publicationStatus, "published"), // Always filter for published novels
  ];
  if (storyStatus === "ongoing" || storyStatus === "finished") {
    browseConditions.push(eq(novels.storyStatus, storyStatus));
  }
  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    const searchPattern = `%${escapeLikePattern(trimmedSearch)}%`;
    browseConditions.push(sql`${novels.title} LIKE ${searchPattern} ESCAPE '\\\\'`);
  }
  if (filter === "free") {
    browseConditions.push(hasFreeEpisodeSql());
  }
  const whereClause = browseConditions.length > 1 ? and(...browseConditions) : browseConditions[0];

  let result: any[];

  if (sort === "popular") {
    // Real popularity signal (purchases, then wishlists) instead of free
    // episode count as a proxy - same ranking pattern as the homepage's
    // getPopularNovels(). Only joined for this branch, never for the far
    // more common "new" sort.
    const purchaseCountsSubquery = db
      .select({
        novelId: purchases.novelId,
        count: sql<number>`COUNT(DISTINCT ${purchases.userId})`.as("purchaseCount"),
      })
      .from(purchases)
      .groupBy(purchases.novelId)
      .as("purchaseCounts");
    const wishlistCountsSubquery = db
      .select({
        novelId: wishlists.novelId,
        count: sql<number>`COUNT(DISTINCT ${wishlists.userId})`.as("wishlistCount"),
      })
      .from(wishlists)
      .groupBy(wishlists.novelId)
      .as("wishlistCounts");

    result = await db
      .select({
        id: novels.id,
        title: novels.title,
        slug: novels.slug,
        coverImageUrl: novels.coverImageUrl,
        storyStatus: novels.storyStatus,
        createdAt: novels.createdAt,
        freeEpisodeCount: hasFreeEpisodeSql(),
      })
      .from(novels)
      .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
      .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId))
      .where(whereClause)
      .orderBy(
        desc(sql`COALESCE(${purchaseCountsSubquery.count}, 0)`),
        desc(sql`COALESCE(${wishlistCountsSubquery.count}, 0)`),
        desc(novels.createdAt),
        desc(novels.id)
      )
      .limit(fetchLimit)
      .offset(offset);
  } else {
    // Default "new" - the common case. No episode-table join/group at all,
    // just the novels table plus one lightweight per-row EXISTS check.
    result = await db
      .select({
        id: novels.id,
        title: novels.title,
        slug: novels.slug,
        coverImageUrl: novels.coverImageUrl,
        storyStatus: novels.storyStatus,
        createdAt: novels.createdAt,
        freeEpisodeCount: hasFreeEpisodeSql(),
      })
      .from(novels)
      .where(whereClause)
      .orderBy(desc(novels.createdAt), desc(novels.id))
      .limit(fetchLimit)
      .offset(offset);
  }

  const hasNextPage = result.length > limit;
  const items = (hasNextPage ? result.slice(0, limit) : result).map((row: any) => ({
    ...row,
    freeEpisodeCount: Number(row.freeEpisodeCount) || 0,
  }));

  return { items, hasNextPage };
}


/**
 * Get top selling novels by revenue with time filtering
 * Used for admin dashboard analytics
 */
export async function getTopSellingNovels(period: "all" | "today" | "7d" | "month" = "all", limit: number = 20) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Calculate date range based on period
  let dateFilter: any = null;
  const now = new Date();
  
  if (period === "today") {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    dateFilter = gte(orders.createdAt, startOfDay);
  } else if (period === "7d") {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    dateFilter = gte(orders.createdAt, sevenDaysAgo);
  } else if (period === "month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFilter = gte(orders.createdAt, startOfMonth);
  }

  // Build sales subquery: aggregate approved orderItems by novelId
  // This is the source of truth for revenue and purchase counts
  const salesSubquery = db
    .select({
      novelId: orderItems.novelId,
      totalRevenue: sql<string>`CAST(SUM(${orderItems.finalPrice}) AS DECIMAL(12,2))`.as("totalRevenue"),
      purchaseCount: sql<number>`COUNT(${orderItems.id})`.as("purchaseCount"), // Count real sold line items
      soldEpisodesCount: sql<number>`COUNT(DISTINCT ${orderItems.episodeId})`.as("soldEpisodesCount"),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(payments, eq(orders.id, payments.orderId))
    .where(
      dateFilter
        ? and(
            eq(orders.status, "approved"),
            eq(orders.paymentStatus, "approved"),
            eq(payments.status, "approved"),
            dateFilter
          )
        : and(
            eq(orders.status, "approved"),
            eq(orders.paymentStatus, "approved"),
            eq(payments.status, "approved")
          )
    )
    .groupBy(orderItems.novelId)
    .as("sales");

  // Build wishlist subquery: count distinct users per novel
  const wishlistSubquery = db
    .select({
      novelId: wishlists.novelId,
      wishlistCount: sql<number>`COUNT(DISTINCT ${wishlists.userId})`.as("wishlistCount"),
    })
    .from(wishlists)
    .groupBy(wishlists.novelId)
    .as("wishlists_agg");

  // Join aggregated results back to novels table
  const results: any[] = await db
    .select({
      novelId: novels.id,
      novelTitle: novels.title,
      coverImageUrl: novels.coverImageUrl,
      totalRevenue: salesSubquery.totalRevenue,
      purchaseCount: salesSubquery.purchaseCount,
      soldEpisodesCount: salesSubquery.soldEpisodesCount,
      wishlistCount: wishlistSubquery.wishlistCount,
      createdAt: novels.createdAt,
    })
    .from(novels)
    .innerJoin(salesSubquery, eq(novels.id, salesSubquery.novelId))
    .leftJoin(wishlistSubquery, eq(novels.id, wishlistSubquery.novelId))
    .orderBy(desc(salesSubquery.totalRevenue))
    .limit(limit);

  return results.map((row, index) => ({
    rank: index + 1,
    novelId: row.novelId,
    novelTitle: row.novelTitle,
    coverImageUrl: row.coverImageUrl,
    totalRevenue: Number(row.totalRevenue) || 0,
    purchaseCount: Number(row.purchaseCount) || 0,
    soldEpisodesCount: Number(row.soldEpisodesCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    createdAt: row.createdAt,
  }));
}

/**
 * Get summary statistics for top selling novels dashboard
 */
export async function getTopSellingNovelsStats(period: "all" | "today" | "7d" | "month" = "all") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Calculate date range based on period
  let dateFilter: any = null;
  const now = new Date();
  
  if (period === "today") {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    dateFilter = gte(orders.createdAt, startOfDay);
  } else if (period === "7d") {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    dateFilter = gte(orders.createdAt, sevenDaysAgo);
  } else if (period === "month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFilter = gte(orders.createdAt, startOfMonth);
  }

  // Build sales subquery: aggregate approved orderItems to get real revenue and purchase counts
  // This is the source of truth for financial metrics
  const salesSubquery = db
    .select({
      totalRevenue: sql<string>`CAST(SUM(${orderItems.finalPrice}) AS DECIMAL(12,2))`.as("totalRevenue"),
      totalPurchases: sql<number>`COUNT(${orderItems.id})`.as("totalPurchases"), // Count real sold line items
      novelCount: sql<number>`COUNT(DISTINCT ${orderItems.novelId})`.as("novelCount"), // Count distinct novels with sales
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(payments, eq(orders.id, payments.orderId))
    .where(
      dateFilter
        ? and(
            eq(orders.status, "approved"),
            eq(orders.paymentStatus, "approved"),
            eq(payments.status, "approved"),
            dateFilter
          )
        : and(
            eq(orders.status, "approved"),
            eq(orders.paymentStatus, "approved"),
            eq(payments.status, "approved")
          )
    )
    .as("sales_stats");

  const result: any[] = await db
    .select({
      totalRevenue: salesSubquery.totalRevenue,
      totalPurchases: salesSubquery.totalPurchases,
      novelCount: salesSubquery.novelCount,
    })
    .from(salesSubquery);

  return {
    totalRevenue: Number(result[0]?.totalRevenue) || 0,
    totalPurchases: Number(result[0]?.totalPurchases) || 0,
    novelCount: Number(result[0]?.novelCount) || 0,
  };
}

// ============ CLEANUP HELPERS (used in tests / admin) ============

export async function deleteOrderItems(orderId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
}

export async function deletePaymentsByOrderId(orderId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(payments).where(eq(payments.orderId, orderId));
}

export async function deleteOrder(orderId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(orders).where(eq(orders.id, orderId));
}

export async function deleteUser(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(users).where(eq(users.id, userId));
}

// Dashboard count helpers - source of truth for metrics
export async function countAllOrders(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(orders);
  return result[0]?.count || 0;
}

export async function countAllNovels(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(novels);
  return result[0]?.count || 0;
}

export async function countPendingPayments(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(payments)
    .where(eq(payments.status, "pending"));
  return result[0]?.count || 0;
}

export async function countApprovedPayments(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(payments)
    .where(eq(payments.status, "approved"));
  return result[0]?.count || 0;
}

export async function countApprovedOrders(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: count() })
    .from(orders)
    .where(eq(orders.status, "approved"));
  return result[0]?.count || 0;
}

export async function getTopUsersBySpending(period: "all" | "today" | "7d" | "30d" | "month" = "all", limit: number = 10) {
  const db = await getDb();
  if (!db) return [];

  let startDate: Date | null = null;
  const now = new Date();

  if (period === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "7d") {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "30d") {
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (period === "month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  try {
    const whereConditions = [
      eq(orders.status, "approved"),
      eq(orders.paymentStatus, "approved")
    ];
    if (startDate) {
      whereConditions.push(gte(orders.createdAt, startDate));
    }

    // Step 1: Get totalSpent and orderCount from orders alone (no joins to avoid multiplication)
    const spendingData = await db
      .select({
        userId: orders.userId,
        totalSpent: sql<string>`SUM(CAST(${orders.totalAmount} AS DECIMAL(10,2)))`,
        orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`,
      })
      .from(orders)
      .where(and(...whereConditions))
      .groupBy(orders.userId);

    // Step 2: Get episode counts separately to avoid multiplying totalSpent
    const episodeData = await db
      .select({
        userId: orders.userId,
        episodeCount: sql<number>`COUNT(DISTINCT ${orderItems.episodeId})`,
      })
      .from(orders)
      .leftJoin(orderItems, eq(orders.id, orderItems.orderId))
      .where(and(...whereConditions))
      .groupBy(orders.userId);

    // Step 3: Get user names
    const userIds = spendingData.map((d: any) => d.userId);
    const userNames = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userMap = new Map(userNames.map((u: any) => [u.id, { name: u.name, email: u.email }]));
    const episodeMap = new Map(episodeData.map((d: any) => [d.userId, d.episodeCount]));

    // Step 4: Merge and sort by totalSpent descending
    const result = spendingData
      .map((row: any) => ({
        userId: row.userId,
        userName: userMap.get(row.userId)?.name || "Unknown",
        userEmail: userMap.get(row.userId)?.email || "",
        totalSpent: row.totalSpent ? parseFloat(row.totalSpent).toFixed(2) : "0.00",
        orderCount: row.orderCount || 0,
        episodeCount: episodeMap.get(row.userId) || 0,
      }))
      .sort((a: any, b: any) => parseFloat(b.totalSpent) - parseFloat(a.totalSpent))
      .slice(0, limit);

    return result;
  } catch (error) {
    console.error("Error fetching top users:", error);
    return [];
  }
}

/**
 * Count approved payments by source (wallet/auto/manual)
 * Returns accurate breakdown for dashboard metrics
 */
export async function getPaymentSourceCounts(): Promise<{
  walletCount: number;
  ocrCount: number;
  transferCount: number;
  unknownCount: number;
  totalApproved: number;
  totalPending: number;
}> {
  const db = await getDb();
  if (!db) return { walletCount: 0, ocrCount: 0, transferCount: 0, unknownCount: 0, totalApproved: 0, totalPending: 0 };

  // Count approved payments grouped by approvalSource
  const sourceCounts = await db
    .select({
      approvalSource: payments.approvalSource,
      count: count(),
    })
    .from(payments)
    .where(eq(payments.status, "approved"))
    .groupBy(payments.approvalSource);

  // Count pending payments (for review queue)
  const pendingResult = await db
    .select({ count: count() })
    .from(payments)
    .where(eq(payments.status, "pending"));

  let walletCount = 0;
  let ocrCount = 0;
  let transferCount = 0;
  let unknownCount = 0;

  for (const row of sourceCounts) {
    const src = row.approvalSource;
    const n = Number(row.count) || 0;
    if (src === "wallet") walletCount += n;
    else if (src === "auto") ocrCount += n;
    else if (src === "manual") transferCount += n;
    else unknownCount += n; // null, "legacy", or any unrecognized source
  }

  const totalApproved = walletCount + ocrCount + transferCount + unknownCount;
  const totalPending = Number(pendingResult[0]?.count) || 0;

  return { walletCount, ocrCount, transferCount, unknownCount, totalApproved, totalPending };
}

export async function getDashboardSummary() {
  const [totalOrders, totalNovels, pendingPayments, approvedPayments, paymentSources] = await Promise.all([
    countAllOrders(),
    countAllNovels(),
    countPendingPayments(),
    countApprovedPayments(),
    getPaymentSourceCounts(),
  ]);

  return {
    totalOrders,
    totalNovels,
    pendingPayments,
    approvedPayments,
    paymentSources,
  };
}


// ============ WALLET HELPERS ============

export async function getOrCreateWalletAccount(
  userId: number,
  tx?: any
): Promise<typeof walletAccounts.$inferSelect> {
  const db = tx || await getDb();
  if (!db) throw new Error("Database not available");

  let account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];

  if (!account && !tx) {
    // The apparent read helper becomes a classified mutation when it creates
    // the singleton account. Re-enter under one real guarded transaction;
    // the in-transaction re-read below handles a concurrent creator safely.
    return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedTx) =>
      getOrCreateWalletAccount(userId, guardedTx)
    );
  }

  if (!account) {
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
    account = (await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];
    if (account) return account;
    const now = new Date();
    try {
      await db.insert(walletAccounts).values({
        userId,
        balance: "0.00",
        totalTopupApproved: "0.00",
        totalSpent: "0.00",
        createdAt: now,
        updatedAt: now,
      });
      account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];
    } catch (insertError: any) {
      // A concurrent insert is an EXPECTED, fully-recovered race - not an
      // error worth a console.error. Log it only if recovery below fails.
      // Sanitized via safeErrorSummary: the previous version logged
      // insertError.message and the raw error object, and drizzle embeds the
      // failing SQL plus its bound parameters in that message.
      if (isDuplicateKeyError(insertError)) {
        account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];
        if (account) return account;
      }

      console.error(
        `[getOrCreateWalletAccount] insert wallet account failed for user ${userId}: ${safeErrorSummary(insertError)}`
      );
      throw insertError;
    }
  }

  return account;
}

export async function getWalletBalance(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];

  return account?.balance || "0.00";
}

export async function listWalletTransactions(userId: number, limit: number = 20, offset: number = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit)
    .offset(offset);
}

// Cache for bonus config to support synchronous calculations
let cachedBonusConfig: any = null;
let configLoadPromise: Promise<any> | null = null;

/**
 * Initialize bonus config cache (call at app startup)
 */
export async function initializeBonusConfigCache(): Promise<void> {
  const { getWalletBonusConfig } = await import("./services/walletBonusService");
  cachedBonusConfig = await getWalletBonusConfig();
}

/**
 * Calculate bonus based on requested amount
 * Uses cached or async-loaded dynamic bonus configuration
 * Falls back to default tiers if config is not available
 */
export async function calculateBonus(requestedAmount: string | number): Promise<string> {
  const { calculateWalletTopupBonus } = await import("./services/walletBonusService");
  const result = await calculateWalletTopupBonus(requestedAmount);
  return result.bonusAmount.toFixed(2);
}

export async function createWalletTopup(userId: number, requestedAmount: string, slipImageUrl?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Validate amount
  const amount = parseFloat(requestedAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid top-up amount");
  }

  // Calculate bonus
  const bonusAmount = await calculateBonus(amount);
  const creditedAmount = (amount + parseFloat(bonusAmount)).toFixed(2);

  // Use explicit timestamps to avoid production DB default mismatch
  const now = new Date();

  return await withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    let result: any;
    try {
      result = await guardedDb.insert(walletTopups).values({
        userId,
        requestedAmount,
        bonusAmount,
        creditedAmount,
        slipImageUrl: slipImageUrl || null,
        slipSubmittedAt: now,
        status: "pending" as any,
        approvalSource: "manual",
        createdAt: now,
        updatedAt: now,
      });
    } catch (insertError: any) {
      console.error("[createWalletTopup] insert walletTopups failed", {
        message: insertError?.message,
        code: insertError?.code,
        errno: insertError?.errno,
        sqlState: insertError?.sqlState,
        sqlMessage: insertError?.sqlMessage,
        sql: insertError?.sql,
        userId,
        requestedAmount,
        bonusAmount,
        creditedAmount,
        hasSlipImageUrl: !!slipImageUrl,
        slipImageUrl,
        now: now.toISOString(),
        fullError: insertError,
      });
      throw insertError;
    }

    const header = Array.isArray(result) ? result[0] : result;
    return (await guardedDb.select().from(walletTopups).where(eq(walletTopups.id, header.insertId)).limit(1))[0];
  });
}

export async function getWalletTopupById(topupId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return (await db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
}

export async function listPendingWalletTopups(limit: number = 20, offset: number = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Join with users to enrich topup data with user info
  // Include both pending and pending_review statuses for admin review queue
  const result = await db
    .select({
      ...getTableColumns(walletTopups),
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
      },
    })
    .from(walletTopups)
    .leftJoin(users, eq(walletTopups.userId, users.id))
    .where(
      or(
        eq(walletTopups.status, "pending"),
        eq(walletTopups.status, "pending_review")
      )
    )
    .orderBy(asc(walletTopups.createdAt))
    .limit(limit)
    .offset(offset);

  return result;
}

/**
 * @deprecated Legacy replace-slip write. Left in place ONLY because
 * legacyManusAssetMigrationService's URL-rewrite helper (`updateWalletTopupSlipUrlIfUnchanged`,
 * a same-bytes storage-key rewrite, not a customer re-upload) is intentionally
 * separate. A genuine customer-facing slip REPLACEMENT must go through
 * `publishWalletTopupReplacementIfReviewable` below - this bare setter leaves
 * `extractedData` describing whatever slip preceded it, which is exactly the
 * IPE-001 wallet finding.
 */
export async function updateWalletTopupSlip(topupId: number, slipImageUrl: string) {
  return withAccountMergeWalletTopupMutationGuard(topupId, undefined, async (guardedDb) => {
    await guardedDb.update(walletTopups).set({ slipImageUrl }).where(eq(walletTopups.id, topupId));
    return (await guardedDb.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
  });
}

/**
 * Atomically publishes a replacement slip for a wallet top-up - the wallet
 * sibling of `publishReplacementSlipIfReviewable`. The SAME conditional
 * UPDATE that makes the new slip current also invalidates whatever OCR
 * evidence belonged to the slip it replaces (or to nothing, on a first
 * upload) and seeds the new slip's own server-derived fileHash, so
 * `slipImageUrl = B` can never be paired with `extractedData` still
 * describing A - not even for the instant between two statements.
 *
 * Conditioned on the top-up still being reviewable (pending/pending_review):
 * an approved/rejected/cancelled top-up can never be reopened by a
 * replacement upload that was being prepared while it got finalized.
 * Returns false when that race was lost; callers MUST treat false as
 * "nothing published" and must not proceed to run OCR or any further write
 * against this upload.
 */
export async function publishWalletTopupReplacementIfReviewable(
  topupId: number,
  fields: {
    slipImageUrl: string;
    slipSubmittedAt: Date;
    extractedData: string | null;
  }
): Promise<boolean> {
  return withAccountMergeWalletTopupMutationGuard(topupId, undefined, async (guardedDb) => {
    const result = await guardedDb
      .update(walletTopups)
      .set({
        slipImageUrl: fields.slipImageUrl,
        slipSubmittedAt: fields.slipSubmittedAt,
        status: "pending",
        extractedData: fields.extractedData,
        // Stale OCR verdicts from the replaced slip must not linger next to
        // the new one - a leftover confidence/decision/reason/duplicate flag
        // would describe evidence for a slip that is no longer even displayed.
        ocrConfidence: null,
        visionConfidence: null,
        structuredConfidence: null,
        finalConfidence: null,
        duplicateStatus: null,
        ocrDecision: "needs_review",
        reviewReason: null,
      })
      .where(
        and(
          eq(walletTopups.id, topupId),
          or(eq(walletTopups.status, "pending"), eq(walletTopups.status, "pending_review"))
        )
      );

    const header = Array.isArray(result) ? result[0] : result;
    return ((header as any)?.affectedRows || 0) > 0;
  });
}

export async function createWalletTransaction(
  userId: number,
  type: string,
  amount: string,
  balanceBefore: string,
  balanceAfter: string,
  referenceType?: string,
  referenceId?: number,
  note?: string,
  tx?: any
) {
  return withAccountMergeClassifiedMutationGuard(userId, tx, async (guardedDb) =>
    guardedDb.insert(walletTransactions).values({
      userId,
      type: type as any,
      amount,
      balanceBefore,
      balanceAfter,
      referenceType,
      referenceId,
      note,
    })
  );
}

export async function debitWalletBalance(
  userId: number,
  amount: string,
  referenceType: string,
  referenceId: number,
  tx?: any
): Promise<string> {
  if (!tx) {
    return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedTx) =>
      debitWalletBalance(userId, amount, referenceType, referenceId, guardedTx)
    );
  }
  const db = tx;
  await assertAccountMergeClassifiedMutationAllowed(userId, tx);

  const account = await getOrCreateWalletAccount(userId, tx);
  const currentBalance = parseFloat(account.balance);
  const debitAmount = parseFloat(amount);

  if (currentBalance < debitAmount) {
    throw new Error("Insufficient wallet balance");
  }

  const newBalance = (currentBalance - debitAmount).toFixed(2);

  await db
    .update(walletAccounts)
    .set({ balance: newBalance, updatedAt: new Date() })
    .where(eq(walletAccounts.userId, userId));

  await createWalletTransaction(
    userId,
    "debit",
    amount,
    account.balance,
    newBalance,
    referenceType,
    referenceId,
    undefined,
    tx
  );

  return newBalance;
}

export async function creditWalletBalance(userId: number, amount: string, referenceType: string, referenceId: number) {
  return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) => {
    const account = await getOrCreateWalletAccount(userId, guardedDb);
    const currentBalance = parseFloat(account.balance);
    const creditAmount = parseFloat(amount);
    const newBalance = (currentBalance + creditAmount).toFixed(2);

    await guardedDb
      .update(walletAccounts)
      .set({ balance: newBalance, updatedAt: new Date() })
      .where(eq(walletAccounts.userId, userId));

    await createWalletTransaction(
      userId,
      "topup_approved",
      amount,
      account.balance,
      newBalance,
      referenceType,
      referenceId,
      undefined,
      guardedDb
    );

    return newBalance;
  });
}

export async function approveWalletTopup(
  topupId: number,
  adminUserId: number,
  /**
   * Set ONLY by the audited legacy-case resolution flow. Skips the advisory
   * alias check a human has adjudicated - and nothing else. Every exact
   * UNIQUE identifier is still claimed atomically below.
   *
   * `auditResolution` is invoked INSIDE this transaction so the successful
   * resolution record and the wallet credit commit together or roll back
   * together. Writing the audit separately beforehand permanently consumed
   * the subject-unique slot when approval then failed, leaving the top-up
   * stuck with no retry path.
   */
  options?: {
    legacyCaseAmbiguityResolution?: {
      expectedLegacyAliasHash?: string;
      expectedMatchedSourceType: "order_payment" | "wallet_topup";
      expectedMatchedSourceId: number;
      /** The exact case-preserving reference the admin adjudicated. */
      expectedIncomingReferenceHash?: string;
    };
    auditResolution?: (tx: any) => Promise<void>;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ownerCandidate = (await db.select({ userId: walletTopups.userId }).from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
  if (!ownerCandidate) throw new Error("Wallet top-up not found");

  // REAL DATABASE TRANSACTION: All operations succeed or all rollback.
  // IPE-005 lock hierarchy is users/merge-guard FIRST, subject row SECOND.
  return await db.transaction(async (tx) => {
    await assertAccountMergeClassifiedMutationAllowed(ownerCandidate.userId, tx);
    // Step 0: LOCK the subject row only after the Source users-row guard.
    await lockWalletTopupForUpdate(topupId, tx);

    // Step 1: Fetch topup INSIDE transaction for consistency
    const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topupResult || topupResult.length === 0) {
      throw new Error("Wallet top-up not found");
    }
    const topup = topupResult[0];
    if (topup.userId !== ownerCandidate.userId) {
      throw new Error("Wallet top-up owner changed while approval was waiting for account lock");
    }

    // Step 1a: DURABLE SLIP-INTEGRITY BLOCK (IPE-001-C07).
    //
    // walletTopupSubmissionService.ts's automatic-submission checkpoints
    // durably clear `extractedData` to null the moment they detect the
    // stored bytes changed mid-run (SLIP_INTEGRITY_MISMATCH), so the
    // strong-identifier check in Step 1b below already refuses an approval
    // with nothing to claim. This is a second, independent gate on the
    // reviewReason itself - wallet parity with orderService's
    // lockAndRequireReviewablePayment/SLIP_INTEGRITY_BLOCK_REASON check -
    // so approval stays refused even if some OTHER path (present or future,
    // including the deprecated wallet.uploadTopupSlip flow) re-seeds
    // extractedData without re-verifying the slip is stable. Cleared only by
    // a genuine replacement upload - publishWalletTopupReplacementIfReviewable
    // accepts this row's "pending_review" status precisely so a customer is
    // not permanently stuck, and its single atomic write unconditionally
    // resets reviewReason to null alongside the fresh slip/extractedData -
    // never a partial clear that could leave this guard on while a new,
    // unrelated hash sits underneath it.
    if (topup.reviewReason === "SLIP_INTEGRITY_MISMATCH") {
      throw new WalletSlipClaimError(
        "SLIP_INTEGRITY_MISMATCH_BLOCKED",
        `Wallet top-up ${topupId}'s slip was found to have changed bytes at the same URL ` +
          `during a prior automatic check, and that finding has not yet been cleared. Approval ` +
          `is refused until a stable re-submission re-establishes integrity for this exact slip, ` +
          `or the customer uploads a genuine replacement.`
      );
    }

    // Step 1b: ANTI-REPLAY GATE (manual admin approval).
    //
    // The admin's browser is never trusted: identifiers are recomputed
    // server-side from the persisted extractedData and claimed inside THIS
    // transaction, so a slip claimed by another submission between page load
    // and the click cannot credit a second wallet.
    //
    // A top-up with NO strong identifier cannot be protected against replay,
    // so normal Approve must not quietly proceed - that would make ordinary
    // admin approval a silent bypass of the registry. After server-side
    // fileHash wiring every NEW slip carries at least an exact-file
    // identifier even when OCR fails, so reaching this branch means a legacy
    // row or unreadable bytes: a deliberate human decision, not a default.
    {
      // Reloaded inside the transaction; nothing from the admin's browser.
      const persistedExtractedData = topup.extractedData as string | null;
      const { identifiers, semanticFingerprint } =
        deriveStrongIdentifiersFromExtractedData(persistedExtractedData);

      if (!hasStrongIdentifier(identifiers)) {
        throw new WalletSlipClaimError(
          "NO_STRONG_IDENTIFIER",
          "This top-up has no transaction reference and no readable slip file, so it cannot " +
            "be protected against replay. It needs the legacy override path (not yet " +
            "available) rather than a normal approval."
        );
      }

      // ── CURRENT-BYTE INTEGRITY (IPE-001-C09) ────────────────────────────
      // `topup` is reloaded and row-locked above, but `persistedExtractedData`
      // - and any fileHash within it - describes bytes from an EARLIER
      // moment: the last successful automatic submission or admin-facing
      // resubmission, not necessarily what slipImageUrl serves RIGHT NOW.
      // Row locks and the SLIP_INTEGRITY_MISMATCH_BLOCKED reviewReason guard
      // above serialize concurrent writes to THIS row; neither serializes an
      // external object-store mutation of the same key. Recompute the
      // current bytes' hash here, inside this transaction, immediately
      // before claiming - wallet parity with orderService.ts's
      // approvePaymentInTx. Applies whenever a slip exists, even for a
      // reference-only identifier set: a reference match alone must never
      // bypass current-file integrity when a file is right there to check.
      if (topup.slipImageUrl) {
        const currentFileHash = await computeSlipFileHash(topup.slipImageUrl as string);
        const persistedFileHash = fileHashFromExtractedData(persistedExtractedData);

        if (!currentFileHash) {
          // Unavailability is uncertainty, never proof of stability - fail
          // closed exactly as a proven mismatch would.
          throw new WalletSlipClaimError(
            "SLIP_CURRENT_BYTES_UNAVAILABLE",
            "The stored slip's current bytes could not be read at approval time, so this " +
              "approval cannot be bound to what is actually being displayed. Nothing was " +
              "claimed or approved. Try again, or run Recheck OCR first."
          );
        }

        if (persistedFileHash && currentFileHash !== persistedFileHash) {
          throw new WalletSlipClaimError(
            "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL",
            "The stored slip's bytes changed after the last successful check and before this " +
              "approval. Nothing was claimed or approved. Run Recheck OCR again to " +
              "re-establish integrity for the exact bytes now on file."
          );
        }

        // Bind the freshly confirmed current hash into what THIS approval
        // actually claims - re-confirms an identifier that already had one,
        // and enriches a reference-only record with one now, atomically
        // inside the SAME transaction that commits the claim and the credit.
        identifiers.fileHash = currentFileHash;
      }

      const claim = await claimSlip(
        {
          sourceType: "wallet_topup",
          sourceId: topupId,
          userId: topup.userId,
          identifiers,
          semanticFingerprint,
          // Legacy lookup only - the claim itself still uses the
          // case-preserving hash derived above.
          referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(persistedExtractedData),
          // Set ONLY by the audited resolution flow, and BOUND to the exact
          // ambiguity a human adjudicated - not a bare boolean. claimSlip
          // waives it only if the fold it finds from transaction-visible
          // state is identical (same alias, same matched source); anything
          // else returns legacy_case_ambiguity_changed. Every exact UNIQUE
          // identifier below is still claimed atomically, so an exact
          // reference/file/QR duplicate still blocks.
          legacyCaseAmbiguityResolution: options?.legacyCaseAmbiguityResolution,
        },
        tx
      );

      if (!claim.claimed && claim.reason === "legacy_scan_unresolved") {
        // An approved historical row exists that could not be verified - not
        // a proven duplicate, not provably clean. Normal Approve must not
        // treat this as an ordinary review outcome or silently proceed.
        throw new WalletSlipClaimError(
          "LEGACY_APPROVED_SLIP_UNRESOLVED",
          describeClaimFailure(claim)
        );
      }

      if (!claim.claimed && claim.reason === "legacy_alias_group_ambiguity") {
        // MORE THAN ONE historical source shares this alias - never
        // resolvable by the single-member "confirm distinct" flow.
        throw new WalletSlipClaimError(
          "LEGACY_ALIAS_GROUP_AMBIGUITY",
          describeClaimFailure(claim)
        );
      }

      if (!claim.claimed && claim.reason === "known_collision") {
        // This top-up's own strong identifier durably matches a KNOWN
        // historical collision. No winner was ever picked, so nothing owns
        // it in the registry - must still fail closed here.
        throw new WalletSlipClaimError(
          "LEGACY_KNOWN_COLLISION",
          describeClaimFailure(claim)
        );
      }

      if (!claim.claimed && claim.reason === "legacy_case_ambiguity") {
        // Normal Approve must not silently bypass this, and must not call it
        // a duplicate - it is an unresolved question. Direct the admin to the
        // explicit resolution flow instead of failing forever.
        throw new WalletSlipClaimError(
          "LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION",
          describeClaimFailure(claim)
        );
      }

      if (!claim.claimed && claim.reason === "legacy_case_ambiguity_changed") {
        // The evidence moved after the admin decided. Their decision was
        // about different evidence, so it is NOT applied: no claim, no
        // credit, no resolution record.
        throw new WalletSlipClaimError(
          "LEGACY_CASE_AMBIGUITY_CHANGED_REVIEW_REQUIRED",
          describeClaimFailure(claim)
        );
      }

      if (!claim.claimed && claim.reason === "already_claimed") {
        const ownedByThisTopup =
          claim.existingSourceType === "wallet_topup" &&
          claim.existingSourceId === topupId;

        if (!ownedByThisTopup) {
          throw new WalletSlipClaimError(
            "SLIP_ALREADY_CLAIMED",
            describeClaimFailure(claim)
          );
        }
      }
    }

    // Step 2: Conditional status update - ONLY update if still pending or pending_review (idempotency)
    // CRITICAL: Only the winning concurrent request may proceed
    // Losing requests will have 0 rows affected and must abort immediately
    const updateResult = await tx
      .update(walletTopups)
      .set({
        status: "approved" as any,
        reviewedByUserId: adminUserId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletTopups.id, topupId),
          or(
            eq(walletTopups.status, "pending" as any),
            eq(walletTopups.status, "pending_review" as any)
          )
        )
      );
    
    // CRITICAL: Check if update actually affected a row
    // Drizzle returns [ResultSetHeader, undefined] where ResultSetHeader has affectedRows
    // If affectedRows is 0, this request lost the race and must not credit wallet
    const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    const affectedRows = (resultHeader as any)?.affectedRows || 0;
    if (affectedRows === 0) {
      // Another request already approved this topup - abort without crediting
      throw new Error("Wallet top-up already processed by another request");
    }

    // Step 2: Use creditedAmount (includes bonus), fallback to requestedAmount for backward compatibility
    const creditAmount = topup.creditedAmount || topup.requestedAmount;
    const bonusAmount = topup.bonusAmount || "0.00";

    // Step 3: Get or create wallet account (within transaction)
    let account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
    if (!account || account.length === 0) {
      // Create wallet account if it doesn't exist (atomic within transaction)
      await tx.insert(walletAccounts).values({
        userId: topup.userId,
        balance: "0.00",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Fetch the newly created account
      account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
      if (!account || account.length === 0) {
        throw new Error("Failed to create wallet account");
      }
    }
    const currentBalance = parseFloat(account[0].balance);
    const creditAmountNum = parseFloat(creditAmount);
    const newBalance = (currentBalance + creditAmountNum).toFixed(2);

    // Step 4: Update wallet balance (within transaction)
    await tx
      .update(walletAccounts)
      .set({ balance: newBalance, updatedAt: new Date() })
      .where(eq(walletAccounts.userId, topup.userId));

    // Step 5: Create wallet transaction record (within transaction)
    await tx.insert(walletTransactions).values({
      userId: topup.userId,
      type: "topup_approved" as any,
      amount: creditAmount,
      balanceBefore: account[0].balance,
      balanceAfter: newBalance,
      referenceType: "topup",
      referenceId: topupId,
    });

    // Step 6: Create topup log (within transaction)
    await tx.insert(topupLogs).values({
      userId: topup.userId,
      amount: topup.requestedAmount,
      bonus: bonusAmount,
      total: creditAmount,
      method: "slip" as any,
      reference: `topup-${topupId}`,
      note: `Slip approved by admin`,
      createdBy: adminUserId,
      createdAt: new Date(),
    });

    // Step 7: Audit a legacy-case resolution INSIDE this transaction, so the
    // successful resolution record and the wallet credit commit together or
    // roll back together. If anything above failed, no resolution row exists
    // and the admin can retry.
    if (options?.auditResolution) {
      await options.auditResolution(tx);
    }

    // Step 8: Return updated topup
    const updated = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    return updated[0];
  });
}

export async function rejectWalletTopup(
  topupId: number,
  adminUserId: number,
  reason: string,
  /**
   * `auditResolution` is invoked INSIDE this transaction, after the
   * conditional rejection has been confirmed to have won. The audit row and
   * the rejection therefore commit together or roll back together: writing
   * the audit first permanently consumed the subject-unique resolution slot
   * when the rejection then lost a race or failed, leaving the top-up
   * reviewable but unresolvable.
   */
  options?: {
    /**
     * Runs under the row lock while the top-up is STILL REVIEWABLE, before
     * the status changes. Evidence revalidation belongs here: running it
     * after the rejection meant it saw `rejected` and always refused.
     */
    revalidate?: (tx: any) => Promise<void>;
    auditResolution?: (tx: any) => Promise<void>;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ownerCandidate = (await db.select({ userId: walletTopups.userId }).from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
  if (!ownerCandidate) throw new Error("Wallet top-up not found");

  return await db.transaction(async (tx) => {
    // IPE-005 canonical lock order: Source users-row/guard before subject.
    await assertAccountMergeClassifiedMutationAllowed(ownerCandidate.userId, tx);
    await lockWalletTopupForUpdate(topupId, tx);

    const topup = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topup || topup.length === 0) throw new Error("Wallet top-up not found");
    if (topup[0].userId !== ownerCandidate.userId) {
      throw new Error("Wallet top-up owner changed while rejection was waiting for account lock");
    }

    // Locked, reloaded, and still reviewable: the only correct point to
    // revalidate the evidence a resolution rests on.
    if (options?.revalidate) {
      await options.revalidate(tx);
    }

    // Conditional update - only reject if still pending or pending_review (idempotency)
    const updateResult = await tx
      .update(walletTopups)
      .set({
        status: "rejected" as any,
        rejectionReason: reason,
        reviewedByUserId: adminUserId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletTopups.id, topupId),
          or(
            eq(walletTopups.status, "pending" as any),
            eq(walletTopups.status, "pending_review" as any)
          )
        )
      );

    // Check if rejection actually affected a row
    const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    const affectedRows = (resultHeader as any)?.affectedRows || 0;
    if (affectedRows === 0) {
      throw new Error("Wallet top-up cannot be rejected - already processed or not in pending state");
    }

    // Log the rejection
    const amountNum = parseFloat("0.00");
    const bonusNum = parseFloat("0.00");
    const total = (amountNum + bonusNum).toFixed(2);

    await tx.insert(topupLogs).values({
      userId: topup[0].userId,
      amount: "0.00",
      bonus: "0.00",
      total: total,
      method: "slip",
      reference: `topup-${topupId}`,
      note: `Slip rejected: ${reason}`,
      createdBy: adminUserId,
      createdAt: new Date(),
    });

    if (options?.auditResolution) {
      await options.auditResolution(tx);
    }

    return tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1).then(r => r[0]);
  });
}

/**
 * Repair wallet credit for approved top-ups that didn't get credited
 * Used for orphan records: topup.status = approved but no walletTransactions
 * Ensures credit is only applied once
 */
export async function repairWalletTopupCredit(
  topupId: number,
  adminUserId: number,
  reason: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ownerCandidate = (await db.select({ userId: walletTopups.userId }).from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
  if (!ownerCandidate) throw new Error("Wallet top-up not found");

  return await db.transaction(async (tx) => {
    await assertAccountMergeClassifiedMutationAllowed(ownerCandidate.userId, tx);
    await lockWalletTopupForUpdate(topupId, tx);
    // Step 1: Fetch topup
    const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topupResult || topupResult.length === 0) {
      throw new Error("Wallet top-up not found");
    }
    const topup = topupResult[0];

    // Step 2: Must be approved
    if (topup.status !== "approved") {
      throw new Error(`Cannot repair top-up with status ${topup.status}. Only approved top-ups can be repaired.`);
    }

    // Step 3: Check if already credited
    const existingTransaction = await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.referenceType, "topup"),
          eq(walletTransactions.referenceId, topupId),
          eq(walletTransactions.type, "topup_approved" as any)
        )
      )
      .limit(1);

    if (existingTransaction && existingTransaction.length > 0) {
      throw new Error("This top-up has already been credited. Cannot repair.");
    }

    // Step 4: Get or create wallet account
    let account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
    if (!account || account.length === 0) {
      await tx.insert(walletAccounts).values({
        userId: topup.userId,
        balance: "0.00",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
      if (!account || account.length === 0) {
        throw new Error("Failed to create wallet account");
      }
    }

    // Step 5: Calculate credit amount
    const creditAmount = topup.creditedAmount || topup.requestedAmount;
    const currentBalance = parseFloat(account[0].balance);
    const creditAmountNum = parseFloat(creditAmount);
    const newBalance = (currentBalance + creditAmountNum).toFixed(2);

    // Step 6: Update wallet balance
    await tx
      .update(walletAccounts)
      .set({ balance: newBalance, updatedAt: new Date() })
      .where(eq(walletAccounts.userId, topup.userId));

    // Step 7: Create wallet transaction record
    await tx.insert(walletTransactions).values({
      userId: topup.userId,
      type: "topup_approved" as any,
      amount: creditAmount,
      balanceBefore: account[0].balance,
      balanceAfter: newBalance,
      referenceType: "topup",
      referenceId: topupId,
      note: `Repair credit by admin ${adminUserId}: ${reason}`,
    });

    // Step 8: Create topup log for audit trail
    const absAmount = Math.abs(parseFloat(creditAmount)).toFixed(2);
    await tx.insert(topupLogs).values({
      userId: topup.userId,
      amount: absAmount,
      bonus: topup.bonusAmount || "0.00",
      total: absAmount,
      method: "slip",
      reference: `topup-${topupId}-repair`,
      note: `Repair wallet credit: ${reason}`,
      createdBy: adminUserId,
      createdAt: new Date(),
    });

    return {
      success: true,
      topupId,
      balanceBefore: account[0].balance,
      balanceAfter: newBalance,
      creditAmount,
    };
  });
}

/**
 * Admin wallet balance adjustment with transaction
 * Ensures balance changes are always accompanied by transaction records
 * Prevents orphan balance changes without audit trail
 */
export async function adjustWalletBalance(
  userId: number,
  amount: string,
  adminUserId: number,
  reason: string,
  mode: "add" | "subtract" | "set" = "add"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Validate amount format: must be valid positive number
  if (!/^\d+(\.\d{1,2})?$/.test(String(amount || "").trim())) {
    throw new Error("Invalid amount format. Must be a positive number (e.g., 100 or 100.50)");
  }

  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum < 0) {
    throw new Error("Amount must be a valid positive number");
  }

  // Use transaction to ensure atomicity
  return await db.transaction(async (tx) => {
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
    // Get or create wallet account
    let account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
    if (!account || account.length === 0) {
      await tx.insert(walletAccounts).values({
        userId,
        balance: "0.00",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
      if (!account || account.length === 0) {
        throw new Error("Failed to create wallet account");
      }
    }

    const currentBalance = parseFloat(account[0].balance);
    let newBalance: number;

    if (mode === "add") {
      newBalance = currentBalance + amountNum;
    } else if (mode === "subtract") {
      newBalance = currentBalance - amountNum;
    } else if (mode === "set") {
      newBalance = amountNum;
    } else {
      throw new Error("Invalid mode");
    }

    // Prevent negative balance
    if (newBalance < 0) {
      throw new Error(`Cannot set balance to negative. Current: ${currentBalance}, requested: ${newBalance}`);
    }

    const newBalanceStr = newBalance.toFixed(2);

    // Calculate transaction amount (the difference)
    const transactionAmount = (newBalance - currentBalance).toFixed(2);

    // Update wallet balance
    await tx
      .update(walletAccounts)
      .set({ balance: newBalanceStr, updatedAt: new Date() })
      .where(eq(walletAccounts.userId, userId));

    // Create wallet transaction record
    await tx.insert(walletTransactions).values({
      userId,
      type: "adjust" as any,
      amount: transactionAmount,
      balanceBefore: account[0].balance,
      balanceAfter: newBalanceStr,
      referenceType: "admin_adjust",
      note: `Admin adjustment by user ${adminUserId}: ${reason}`,
    });

    // Create topup log for audit trail
    const absAmount = Math.abs(parseFloat(transactionAmount)).toFixed(2);
    await tx.insert(topupLogs).values({
      userId,
      amount: absAmount,
      bonus: "0.00",
      total: absAmount,
      method: "admin_adjust",
      reference: `admin-adjust-${Date.now()}`,
      note: reason,
      createdBy: adminUserId,
      createdAt: new Date(),
    });

    return {
      userId,
      balanceBefore: account[0].balance,
      balanceAfter: newBalanceStr,
      transactionAmount,
      mode,
      reason,
    };
  });
}

export async function getWalletSummary(userId: number) {
  const startedAt = Date.now();
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const account = await getOrCreateWalletAccount(userId);

    const [transactions, topups] = await Promise.all([
      db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.userId, userId))
        .orderBy(desc(walletTransactions.createdAt))
        .limit(10),
      // Select only necessary columns to avoid schema mismatch issues
      db
        .select({
          id: walletTopups.id,
          userId: walletTopups.userId,
          requestedAmount: walletTopups.requestedAmount,
          bonusAmount: walletTopups.bonusAmount,
          creditedAmount: walletTopups.creditedAmount,
          slipImageUrl: walletTopups.slipImageUrl,
          slipSubmittedAt: walletTopups.slipSubmittedAt,
          status: walletTopups.status,
          rejectionReason: walletTopups.rejectionReason,
          reviewReason: walletTopups.reviewReason,
          approvedAt: walletTopups.approvedAt,
          createdAt: walletTopups.createdAt,
        })
        .from(walletTopups)
        .where(eq(walletTopups.userId, userId))
        .orderBy(desc(walletTopups.createdAt))
        .limit(5),
    ]);

    const durationMs = Date.now() - startedAt;
    if (durationMs > 1000) {
      console.warn("[getWalletSummary] slow query", {
        userId,
        durationMs,
      });
    }

    return {
      balance: account.balance,
      totalTopupApproved: account.totalTopupApproved,
      totalSpent: account.totalSpent,
      recentTransactions: transactions,
      recentTopups: topups,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    console.error("[getWalletSummary] failed", {
      userId,
      durationMs,
      message: error?.message,
      code: error?.code,
      error: error,
    });
    throw error;
  }
}


/**
 * Top-up Logs (Audit Trail) Helpers
 */

export async function createTopupLog(
  userId: number,
  amount: string,
  bonus: string,
  method: "slip" | "admin_adjust" | "promo",
  reference?: string,
  note?: string,
  createdBy?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const amountNum = parseFloat(amount);
  const bonusNum = parseFloat(bonus || "0");
  const total = (amountNum + bonusNum).toFixed(2);

  return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedDb) =>
    guardedDb.insert(topupLogs).values({
      userId,
      amount: amount,
      bonus: bonus || "0.00",
      total: total,
      method,
      reference,
      note,
      createdBy,
      createdAt: new Date(),
    })
  );
}

export async function getTopupLogById(logId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return (await db.select().from(topupLogs).where(eq(topupLogs.id, logId)).limit(1))[0];
}

export async function getTopupLogs(
  userId?: number,
  startDate?: Date,
  endDate?: Date,
  limit: number = 50,
  offset: number = 0
) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [];

  if (userId) {
    conditions.push(eq(topupLogs.userId, userId));
  }

  if (startDate) {
    conditions.push(gte(topupLogs.createdAt, startDate));
  }

  if (endDate) {
    conditions.push(lte(topupLogs.createdAt, endDate));
  }

  // Create aliases for owner and creator users
  const ownerUser = alias(users, "ownerUser");
  const creatorUser = alias(users, "creatorUser");

  let query = db
    .select({
      id: topupLogs.id,
      userId: topupLogs.userId,
      userName: ownerUser.name,
      userEmail: ownerUser.email,
      amount: topupLogs.amount,
      bonus: topupLogs.bonus,
      total: topupLogs.total,
      method: topupLogs.method,
      reference: topupLogs.reference,
      note: topupLogs.note,
      createdBy: topupLogs.createdBy,
      createdByName: creatorUser.name,
      createdAt: topupLogs.createdAt,
    })
    .from(topupLogs)
    .leftJoin(ownerUser, eq(topupLogs.userId, ownerUser.id))
    .leftJoin(creatorUser, eq(topupLogs.createdBy, creatorUser.id));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as any;
  }

  const result = await (query as any)
    .orderBy(desc(topupLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return result;
}

export async function getTopupLogsCount(userId?: number, startDate?: Date, endDate?: Date) {
  const db = await getDb();
  if (!db) return 0;

  const conditions: any[] = [];

  if (userId) {
    conditions.push(eq(topupLogs.userId, userId));
  }

  if (startDate) {
    conditions.push(gte(topupLogs.createdAt, startDate));
  }

  if (endDate) {
    conditions.push(lte(topupLogs.createdAt, endDate));
  }

  let query = db.select({ count: count() }).from(topupLogs) as any;

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const result = await query;
  return result[0]?.count || 0;
}

export async function getTopupLogsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];

  const result = await db
    .select()
    .from(topupLogs)
    .where(eq(topupLogs.userId, userId))
    .orderBy(desc(topupLogs.createdAt));

  return result;
}

export async function getRecentlyApprovedPayments(limit?: number, offset?: number) {
  const db = await getDb();
  if (!db) return [];
  let query: any = db.select().from(payments).where(eq(payments.status, "approved")).orderBy(desc(payments.approvedAt)).limit(limit || 50);
  if (offset) query = query.offset(offset);
  return query;
}


// ============================================================================
// Sports Match Prediction Voting
// ============================================================================

type SportsPrediction = "home_win" | "draw" | "away_win";
type SportsMatchStatus = "draft" | "open" | "closed" | "settled" | "cancelled";

function extractInsertId(result: any): number {
  let insertedId: number | undefined;
  if (typeof result === "object" && result !== null) {
    insertedId = result.insertId;
    if (!insertedId && Array.isArray(result) && result[0]) insertedId = result[0].insertId;
    if (!insertedId && result.meta) insertedId = result.meta.insertId;
  }
  if (!insertedId) throw new Error("Failed to extract inserted ID");
  return insertedId;
}

async function getSportsCompetitionTeamsInternal(competitionId: number, database: any): Promise<Array<SportsTeamLookup & { membershipId: number; displayOrder: number }>> {
  return database
    .select({
      membershipId: sportsCompetitionTeams.id,
      displayOrder: sportsCompetitionTeams.displayOrder,
      id: sportsTeams.id,
      code: sportsTeams.code,
      name: sportsTeams.name,
      logoImageUrl: sportsTeams.logoImageUrl,
      isActive: sportsTeams.isActive,
    })
    .from(sportsCompetitionTeams)
    .innerJoin(sportsTeams, eq(sportsCompetitionTeams.teamId, sportsTeams.id))
    .where(eq(sportsCompetitionTeams.competitionId, competitionId))
    .orderBy(asc(sportsCompetitionTeams.displayOrder), asc(sportsTeams.name));
}

async function getSportsCompetitionByIdInternal(competitionId: number, database: any) {
  const rows = await database
    .select()
    .from(sportsCompetitions)
    .where(eq(sportsCompetitions.id, competitionId))
    .limit(1);
  return rows[0];
}

async function getSportsTeamByIdInternal(teamId: number, database: any) {
  const rows = await database.select().from(sportsTeams).where(eq(sportsTeams.id, teamId)).limit(1);
  return rows[0];
}

export async function getAdminSportsCompetitions() {
  const database = await getDb();
  if (!database) return [];
  const competitions = await database.select().from(sportsCompetitions).orderBy(asc(sportsCompetitions.name));
  const membershipRows = await database
    .select({
      competitionId: sportsCompetitionTeams.competitionId,
      membershipId: sportsCompetitionTeams.id,
      displayOrder: sportsCompetitionTeams.displayOrder,
      id: sportsTeams.id,
      code: sportsTeams.code,
      name: sportsTeams.name,
      logoImageUrl: sportsTeams.logoImageUrl,
      isActive: sportsTeams.isActive,
    })
    .from(sportsCompetitionTeams)
    .innerJoin(sportsTeams, eq(sportsCompetitionTeams.teamId, sportsTeams.id))
    .orderBy(asc(sportsCompetitionTeams.displayOrder), asc(sportsTeams.name));

  const teamsByCompetition = new Map<number, any[]>();
  for (const row of membershipRows) {
    const list = teamsByCompetition.get(row.competitionId) ?? [];
    list.push({
      membershipId: row.membershipId,
      displayOrder: row.displayOrder,
      id: row.id,
      code: row.code,
      name: row.name,
      logoImageUrl: row.logoImageUrl,
      isActive: row.isActive,
    });
    teamsByCompetition.set(row.competitionId, list);
  }

  return competitions.map((competition: any) => ({
    ...competition,
    teams: teamsByCompetition.get(competition.id) ?? [],
  }));
}

export async function getAdminSportsTeams() {
  const database = await getDb();
  if (!database) return [];
  return database.select().from(sportsTeams).orderBy(asc(sportsTeams.name));
}

export async function createSportsCompetition(data: {
  code: string;
  name: string;
  competitionType: "league" | "cup";
  logoImageUrl?: string | null;
  isActive?: boolean;
}) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const code = normalizeSportsCatalogCode(data.code, "competition code");
  const name = data.name.trim();
  if (!name) throw new Error("Competition name is required");
  const result = await database.insert(sportsCompetitions).values({
    code,
    name,
    competitionType: data.competitionType,
    logoImageUrl: data.logoImageUrl ?? null,
    isActive: data.isActive ?? true,
  });
  return { id: extractInsertId(result) };
}

export async function updateSportsCompetition(competitionId: number, data: Partial<{
  code: string;
  name: string;
  competitionType: "league" | "cup";
  logoImageUrl: string | null;
  isActive: boolean;
}>) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const existing = await getSportsCompetitionByIdInternal(competitionId, database);
  if (!existing) throw new Error("Competition not found");
  const patch: any = { ...data };
  if (data.code !== undefined) patch.code = normalizeSportsCatalogCode(data.code, "competition code");
  if (data.name !== undefined) {
    patch.name = data.name.trim();
    if (!patch.name) throw new Error("Competition name is required");
  }
  await database.update(sportsCompetitions).set(patch).where(eq(sportsCompetitions.id, competitionId));
  return { success: true };
}

export async function createSportsTeam(data: {
  code: string;
  name: string;
  logoImageUrl?: string | null;
  isActive?: boolean;
}) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const code = normalizeSportsCatalogCode(data.code, "team code");
  const name = data.name.trim();
  if (!name) throw new Error("Team name is required");
  const result = await database.insert(sportsTeams).values({
    code,
    name,
    logoImageUrl: data.logoImageUrl ?? null,
    isActive: data.isActive ?? true,
  });
  return { id: extractInsertId(result) };
}

export async function updateSportsTeam(teamId: number, data: Partial<{
  code: string;
  name: string;
  logoImageUrl: string | null;
  isActive: boolean;
}>) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const existing = await getSportsTeamByIdInternal(teamId, database);
  if (!existing) throw new Error("Team not found");
  const patch: any = { ...data };
  if (data.code !== undefined) patch.code = normalizeSportsCatalogCode(data.code, "team code");
  if (data.name !== undefined) {
    patch.name = data.name.trim();
    if (!patch.name) throw new Error("Team name is required");
  }
  await database.update(sportsTeams).set(patch).where(eq(sportsTeams.id, teamId));
  return { success: true };
}

export async function setSportsCompetitionTeamMembership(data: {
  competitionId: number;
  teamId: number;
  isMember: boolean;
  displayOrder?: number;
}) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  const [competition, team] = await Promise.all([
    getSportsCompetitionByIdInternal(data.competitionId, database),
    getSportsTeamByIdInternal(data.teamId, database),
  ]);
  if (!competition) throw new Error("Competition not found");
  if (!team) throw new Error("Team not found");

  const existing = await database
    .select()
    .from(sportsCompetitionTeams)
    .where(and(
      eq(sportsCompetitionTeams.competitionId, data.competitionId),
      eq(sportsCompetitionTeams.teamId, data.teamId)
    ))
    .limit(1);

  if (data.isMember) {
    if (existing.length) {
      if (data.displayOrder !== undefined) {
        await database
          .update(sportsCompetitionTeams)
          .set({ displayOrder: data.displayOrder })
          .where(eq(sportsCompetitionTeams.id, existing[0].id));
      }
      return { success: true, membershipId: existing[0].id, created: false };
    }
    const result = await database.insert(sportsCompetitionTeams).values({
      competitionId: data.competitionId,
      teamId: data.teamId,
      displayOrder: data.displayOrder ?? 0,
    });
    return { success: true, membershipId: extractInsertId(result), created: true };
  }

  if (existing.length) {
    await database.delete(sportsCompetitionTeams).where(eq(sportsCompetitionTeams.id, existing[0].id));
  }
  return { success: true, created: false };
}

async function resolveSportsMatchCatalogSelection(
  competitionId: number,
  homeTeamId: number,
  awayTeamId: number,
  database: any
) {
  if (homeTeamId === awayTeamId) throw new Error("Home and away team must be different");
  const competition = await getSportsCompetitionByIdInternal(competitionId, database);
  if (!competition) throw new Error("Competition not found");
  if (!competition.isActive) throw new Error("Competition is inactive");
  const members = await getSportsCompetitionTeamsInternal(competitionId, database);
  const homeTeam = members.find((team) => team.id === homeTeamId);
  const awayTeam = members.find((team) => team.id === awayTeamId);
  if (!homeTeam) throw new Error("Home team is not a member of the selected competition");
  if (!awayTeam) throw new Error("Away team is not a member of the selected competition");
  if (homeTeam.isActive === false || awayTeam.isActive === false) throw new Error("Selected team is inactive");
  return { competition, homeTeam, awayTeam };
}

async function enrichSportsMatchesWithCatalog(matches: any[], database: any) {
  if (!matches.length) return matches;
  const [competitions, teams] = await Promise.all([
    database.select().from(sportsCompetitions),
    database.select().from(sportsTeams),
  ]);
  const competitionById = new Map(competitions.map((item: any) => [item.id, item]));
  const teamById = new Map(teams.map((item: any) => [item.id, item]));
  return matches.map((match: any) => {
    const competition: any = match.competitionId ? competitionById.get(match.competitionId) : undefined;
    const homeTeam: any = match.homeTeamId ? teamById.get(match.homeTeamId) : undefined;
    const awayTeam: any = match.awayTeamId ? teamById.get(match.awayTeamId) : undefined;
    return buildSportsMatchCatalogView(match, competition, homeTeam, awayTeam);
  });
}

export async function getPublicSportsMatches(userId?: number) {
  const db = await getDb();
  if (!db) return [];

  const matches = await db
    .select()
    .from(sportsMatches)
    .where(eq(sportsMatches.isActive, true))
    .orderBy(asc(sportsMatches.displayOrder), asc(sportsMatches.voteDeadlineAt));
  const enrichedMatches = await enrichSportsMatchesWithCatalog(matches, db);

  if (!userId) return enrichedMatches.map((match: any) => ({ ...match, myVote: null }));

  const votes = await db
    .select()
    .from(sportsMatchVotes)
    .where(eq(sportsMatchVotes.userId, userId));

  const voteByMatchId = new Map(votes.map((vote: any) => [vote.matchId, vote]));
  return enrichedMatches.map((match: any) => ({ ...match, myVote: voteByMatchId.get(match.id) || null }));
}

export async function getAdminSportsMatches() {
  const db = await getDb();
  if (!db) return [];

  const matches = await db
    .select()
    .from(sportsMatches)
    .orderBy(desc(sportsMatches.createdAt));
  const enrichedMatches = await enrichSportsMatchesWithCatalog(matches, db);

  return Promise.all(
    enrichedMatches.map(async (match: any) => {
      const voteRows = await db
        .select({ status: sportsMatchVotes.status, prediction: sportsMatchVotes.prediction })
        .from(sportsMatchVotes)
        .where(eq(sportsMatchVotes.matchId, match.id));

      return {
        ...match,
        voteCount: voteRows.length,
        homeVoteCount: voteRows.filter((v: any) => v.prediction === "home_win").length,
        drawVoteCount: voteRows.filter((v: any) => v.prediction === "draw").length,
        awayVoteCount: voteRows.filter((v: any) => v.prediction === "away_win").length,
        winnerCount: voteRows.filter((v: any) => v.status === "won").length,
      };
    })
  );
}

export async function getSportsMatchById(matchId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(sportsMatches).where(eq(sportsMatches.id, matchId)).limit(1);
  return rows[0];
}

export async function getSportsVoteByMatchAndUser(matchId: number, userId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(sportsMatchVotes)
    .where(and(eq(sportsMatchVotes.matchId, matchId), eq(sportsMatchVotes.userId, userId)))
    .limit(1);
  return rows[0];
}

export async function createSportsMatch(data: {
  title: string;
  leagueName?: string;
  competitionId: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName?: string;
  awayTeamName?: string;
  homeTeamImageUrl?: string;
  awayTeamImageUrl?: string;
  coverImageUrl?: string;
  matchStartAt?: Date;
  voteDeadlineAt: Date;
  voteCostPoints: string;
  rewardKind?: SportsRewardKind;
  rewardPointsAmount?: string | null;
  rewardDiscountType?: "flat" | "percentage" | null;
  rewardDiscountValue?: string | null;
  rewardMinPurchaseAmount?: string | null;
  rewardCouponExpiresAt?: Date | null;
  status?: SportsMatchStatus;
  isActive?: boolean;
  displayOrder?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  parseStrictNonNegativeDecimal(data.voteCostPoints, "voteCostPoints");
  const reward = validateSportsRewardConfig(data);

  if (!data.voteDeadlineAt || !(data.voteDeadlineAt instanceof Date) || isNaN(data.voteDeadlineAt.getTime())) {
    throw new Error("voteDeadlineAt must be a valid date");
  }
  if (data.voteDeadlineAt.getTime() <= Date.now()) {
    throw new Error("voteDeadlineAt must be in the future");
  }

  if (!data.competitionId || !data.homeTeamId || !data.awayTeamId) {
    throw new Error("New Sports Vote matches require competitionId, homeTeamId, and awayTeamId");
  }
  const resolved = await resolveSportsMatchCatalogSelection(data.competitionId, data.homeTeamId, data.awayTeamId, db);
  const catalogPatch = {
    competitionId: resolved.competition.id,
    homeTeamId: resolved.homeTeam.id,
    awayTeamId: resolved.awayTeam.id,
    leagueName: resolved.competition.name,
    homeTeamName: resolved.homeTeam.name,
    awayTeamName: resolved.awayTeam.name,
    homeTeamImageUrl: resolved.homeTeam.logoImageUrl ?? null,
    awayTeamImageUrl: resolved.awayTeam.logoImageUrl ?? null,
  };

  const result = await db.insert(sportsMatches).values({
    title: data.title.trim(),
    ...catalogPatch,
    coverImageUrl: data.coverImageUrl ?? null,
    matchStartAt: data.matchStartAt ?? null,
    voteDeadlineAt: data.voteDeadlineAt,
    voteCostPoints: data.voteCostPoints as any,
    rewardKind: reward.rewardKind,
    rewardPointsAmount: reward.rewardPointsAmount as any,
    rewardDiscountType: reward.rewardDiscountType,
    rewardDiscountValue: reward.rewardDiscountValue as any,
    rewardMinPurchaseAmount: reward.rewardMinPurchaseAmount as any,
    rewardCouponExpiresAt: reward.rewardCouponExpiresAt,
    status: data.status || "draft",
    isActive: data.isActive ?? true,
    displayOrder: data.displayOrder ?? 0,
  });

  return { id: extractInsertId(result) };
}

export async function updateSportsMatch(matchId: number, data: Partial<{
  title: string;
  leagueName: string | null;
  competitionId: number | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  coverImageUrl: string | null;
  matchStartAt: Date | null;
  voteDeadlineAt: Date;
  voteCostPoints: string;
  rewardKind: SportsRewardKind;
  rewardPointsAmount: string | null;
  rewardDiscountType: "flat" | "percentage" | null;
  rewardDiscountValue: string | null;
  rewardMinPurchaseAmount: string | null;
  rewardCouponExpiresAt: Date | null;
  status: SportsMatchStatus;
  result: SportsPrediction | null;
  isActive: boolean;
  displayOrder: number;
}>, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;

  const existing = await getSportsMatchById(matchId, tx);
  if (!existing) throw new Error("Match not found");

  const CRITICAL_FIELDS = [
    "title", "leagueName", "competitionId", "homeTeamId", "awayTeamId",
    "homeTeamName", "awayTeamName", "matchStartAt", "voteDeadlineAt", "voteCostPoints",
    "rewardKind", "rewardPointsAmount", "rewardDiscountType", "rewardDiscountValue",
    "rewardMinPurchaseAmount", "rewardCouponExpiresAt", "status", "result"
  ];
  if ((existing.status === "settled" || existing.status === "cancelled") &&
      Object.keys(data).some((key) => CRITICAL_FIELDS.includes(key))) {
    throw new Error(`Cannot update critical fields on a ${existing.status} match`);
  }

  const patch: any = { ...data };
  const voteCostPoints = data.voteCostPoints !== undefined ? data.voteCostPoints : String(existing.voteCostPoints);
  parseStrictNonNegativeDecimal(voteCostPoints, "voteCostPoints");

  const mergedStatus = data.status !== undefined ? data.status : existing.status;
  const mergedDeadline = data.voteDeadlineAt !== undefined ? data.voteDeadlineAt : existing.voteDeadlineAt;
  if (mergedDeadline) {
    const deadline = new Date(mergedDeadline);
    if (isNaN(deadline.getTime())) throw new Error("voteDeadlineAt must be a valid date");
    if (mergedStatus === "open" && deadline.getTime() <= Date.now()) {
      throw new Error("voteDeadlineAt must be in the future for open matches");
    }
  }

  const rewardFields = [
    "rewardKind", "rewardPointsAmount", "rewardDiscountType", "rewardDiscountValue",
    "rewardMinPurchaseAmount", "rewardCouponExpiresAt"
  ];
  if (Object.keys(data).some((key) => rewardFields.includes(key))) {
    const reward = validateSportsRewardConfig({
      rewardKind: (data.rewardKind ?? existing.rewardKind ?? "coupon") as SportsRewardKind,
      rewardPointsAmount: data.rewardPointsAmount !== undefined ? data.rewardPointsAmount : existing.rewardPointsAmount?.toString() ?? null,
      rewardDiscountType: data.rewardDiscountType !== undefined ? data.rewardDiscountType : existing.rewardDiscountType as any,
      rewardDiscountValue: data.rewardDiscountValue !== undefined ? data.rewardDiscountValue : existing.rewardDiscountValue?.toString() ?? null,
      rewardMinPurchaseAmount: data.rewardMinPurchaseAmount !== undefined ? data.rewardMinPurchaseAmount : existing.rewardMinPurchaseAmount?.toString() ?? null,
      rewardCouponExpiresAt: data.rewardCouponExpiresAt !== undefined ? data.rewardCouponExpiresAt : existing.rewardCouponExpiresAt,
    });
    patch.rewardKind = reward.rewardKind;
    patch.rewardPointsAmount = reward.rewardPointsAmount;
    patch.rewardDiscountType = reward.rewardDiscountType;
    patch.rewardDiscountValue = reward.rewardDiscountValue;
    patch.rewardMinPurchaseAmount = reward.rewardMinPurchaseAmount;
    patch.rewardCouponExpiresAt = reward.rewardCouponExpiresAt;
  }

  const catalogFields = ["competitionId", "homeTeamId", "awayTeamId"];
  if (Object.keys(data).some((key) => catalogFields.includes(key))) {
    const competitionId = data.competitionId !== undefined ? data.competitionId : existing.competitionId;
    const homeTeamId = data.homeTeamId !== undefined ? data.homeTeamId : existing.homeTeamId;
    const awayTeamId = data.awayTeamId !== undefined ? data.awayTeamId : existing.awayTeamId;
    if (!competitionId || !homeTeamId || !awayTeamId) {
      throw new Error("competitionId, homeTeamId, and awayTeamId must be provided together");
    }
    const resolved = await resolveSportsMatchCatalogSelection(competitionId, homeTeamId, awayTeamId, db);
    patch.competitionId = resolved.competition.id;
    patch.homeTeamId = resolved.homeTeam.id;
    patch.awayTeamId = resolved.awayTeam.id;
    patch.leagueName = resolved.competition.name;
    patch.homeTeamName = resolved.homeTeam.name;
    patch.awayTeamName = resolved.awayTeam.name;
    patch.homeTeamImageUrl = resolved.homeTeam.logoImageUrl ?? null;
    patch.awayTeamImageUrl = resolved.awayTeam.logoImageUrl ?? null;
  }

  await db.update(sportsMatches).set(patch).where(eq(sportsMatches.id, matchId));
}

export interface SportsBulkFixtureRowInput {
  rowNumber?: number;
  title: string;
  homeTeamRef: string | number;
  awayTeamRef: string | number;
  homeTeamLogoUrl?: string | null;
  awayTeamLogoUrl?: string | null;
  matchStartAt?: Date | null;
  voteDeadlineAt: Date;
  voteCostPoints: string;
  rewardKind?: SportsRewardKind;
  rewardPointsAmount?: string | null;
  rewardDiscountType?: "flat" | "percentage" | null;
  rewardDiscountValue?: string | null;
  rewardMinPurchaseAmount?: string | null;
  rewardCouponExpiresAt?: Date | null;
  status?: "draft" | "open" | "closed";
  displayOrder?: number;
}

export interface SportsBulkFixtureRowError {
  rowNumber: number;
  field: string;
  message: string;
}

export async function bulkCreateSportsFixtures(input: {
  competitionId: number;
  rows: SportsBulkFixtureRowInput[];
  updateTeamAssets?: boolean;
}) {
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  if (!input.rows.length) return { success: false as const, createdCount: 0, errors: [{ rowNumber: 0, field: "rows", message: "At least one fixture row is required" }] };
  if (input.rows.length > 1000) throw new Error("Bulk fixture import supports at most 1000 rows per batch");

  const competition = await getSportsCompetitionByIdInternal(input.competitionId, database);
  if (!competition) throw new Error("Competition not found");
  if (!competition.isActive) throw new Error("Competition is inactive");

  const [competitionTeams, allTeams] = await Promise.all([
    getSportsCompetitionTeamsInternal(input.competitionId, database),
    database.select().from(sportsTeams),
  ]);
  const errors: SportsBulkFixtureRowError[] = [];
  const prepared: Array<{
    source: SportsBulkFixtureRowInput;
    homeTeam: SportsTeamLookup;
    awayTeam: SportsTeamLookup;
    reward: ReturnType<typeof validateSportsRewardConfig>;
    rowNumber: number;
  }> = [];
  const seenFixtureKeys = new Set<string>();

  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    const rowNumber = row.rowNumber ?? index + 2;
    const beforeErrorCount = errors.length;
    const title = String(row.title ?? "").trim();
    if (!title) errors.push({ rowNumber, field: "title", message: "Title is required" });

    let homeTeam: SportsTeamLookup | undefined;
    let awayTeam: SportsTeamLookup | undefined;
    try {
      homeTeam = resolveSportsTeamReference(row.homeTeamRef, competitionTeams, allTeams);
    } catch (error: any) {
      errors.push({ rowNumber, field: "homeTeamRef", message: error?.message || "Invalid home team" });
    }
    try {
      awayTeam = resolveSportsTeamReference(row.awayTeamRef, competitionTeams, allTeams);
    } catch (error: any) {
      errors.push({ rowNumber, field: "awayTeamRef", message: error?.message || "Invalid away team" });
    }
    if (homeTeam && awayTeam && homeTeam.id === awayTeam.id) {
      errors.push({ rowNumber, field: "awayTeamRef", message: "Home and away team must be different" });
    }

    try {
      parseStrictNonNegativeDecimal(row.voteCostPoints, "voteCostPoints");
    } catch (error: any) {
      errors.push({ rowNumber, field: "voteCostPoints", message: error?.message || "Invalid vote cost" });
    }

    if (!(row.voteDeadlineAt instanceof Date) || isNaN(row.voteDeadlineAt.getTime())) {
      errors.push({ rowNumber, field: "voteDeadlineAt", message: "voteDeadlineAt must be a valid date" });
    } else if ((row.status ?? "draft") === "open" && row.voteDeadlineAt.getTime() <= Date.now()) {
      errors.push({ rowNumber, field: "voteDeadlineAt", message: "Open fixtures require a future vote deadline" });
    }
    if (row.matchStartAt && (!(row.matchStartAt instanceof Date) || isNaN(row.matchStartAt.getTime()))) {
      errors.push({ rowNumber, field: "matchStartAt", message: "matchStartAt must be a valid date" });
    }

    let reward: ReturnType<typeof validateSportsRewardConfig> | undefined;
    try {
      reward = validateSportsRewardConfig(row);
    } catch (error: any) {
      errors.push({ rowNumber, field: "reward", message: error?.message || "Invalid reward configuration" });
    }

    if (homeTeam && awayTeam && row.voteDeadlineAt instanceof Date && !isNaN(row.voteDeadlineAt.getTime())) {
      const fixtureTime = row.matchStartAt instanceof Date && !isNaN(row.matchStartAt.getTime())
        ? row.matchStartAt.toISOString()
        : row.voteDeadlineAt.toISOString();
      const fixtureKey = `${homeTeam.id}:${awayTeam.id}:${fixtureTime}:${title.toLocaleLowerCase()}`;
      if (seenFixtureKeys.has(fixtureKey)) {
        errors.push({ rowNumber, field: "row", message: "Duplicate fixture row in this import" });
      } else {
        seenFixtureKeys.add(fixtureKey);
      }
    }

    if (errors.length === beforeErrorCount && homeTeam && awayTeam && reward) {
      prepared.push({ source: { ...row, title }, homeTeam, awayTeam, reward, rowNumber });
    }
  }

  if (errors.length) return { success: false as const, createdCount: 0, errors };

  return database.transaction(async (tx: any) => {
    const ids: number[] = [];
    const assetUpdates = new Map<number, string>();
    if (input.updateTeamAssets) {
      for (const item of prepared) {
        const homeLogo = item.source.homeTeamLogoUrl?.trim();
        const awayLogo = item.source.awayTeamLogoUrl?.trim();
        if (homeLogo) assetUpdates.set(item.homeTeam.id, homeLogo);
        if (awayLogo) assetUpdates.set(item.awayTeam.id, awayLogo);
      }
      for (const [teamId, logoImageUrl] of Array.from(assetUpdates.entries())) {
        await tx.update(sportsTeams).set({ logoImageUrl }).where(eq(sportsTeams.id, teamId));
      }
    }

    for (const item of prepared) {
      const homeLogo = input.updateTeamAssets
        ? assetUpdates.get(item.homeTeam.id) ?? item.homeTeam.logoImageUrl ?? null
        : item.homeTeam.logoImageUrl ?? null;
      const awayLogo = input.updateTeamAssets
        ? assetUpdates.get(item.awayTeam.id) ?? item.awayTeam.logoImageUrl ?? null
        : item.awayTeam.logoImageUrl ?? null;
      const result = await tx.insert(sportsMatches).values({
        title: item.source.title.trim(),
        leagueName: competition.name,
        competitionId: competition.id,
        homeTeamId: item.homeTeam.id,
        awayTeamId: item.awayTeam.id,
        homeTeamName: item.homeTeam.name,
        awayTeamName: item.awayTeam.name,
        homeTeamImageUrl: homeLogo,
        awayTeamImageUrl: awayLogo,
        matchStartAt: item.source.matchStartAt ?? null,
        voteDeadlineAt: item.source.voteDeadlineAt,
        voteCostPoints: item.source.voteCostPoints as any,
        rewardKind: item.reward.rewardKind,
        rewardPointsAmount: item.reward.rewardPointsAmount as any,
        rewardDiscountType: item.reward.rewardDiscountType,
        rewardDiscountValue: item.reward.rewardDiscountValue as any,
        rewardMinPurchaseAmount: item.reward.rewardMinPurchaseAmount as any,
        rewardCouponExpiresAt: item.reward.rewardCouponExpiresAt,
        status: item.source.status ?? "draft",
        isActive: true,
        displayOrder: item.source.displayOrder ?? 0,
      });
      ids.push(extractInsertId(result));
    }

    return { success: true as const, createdCount: ids.length, ids, errors: [] as SportsBulkFixtureRowError[] };
  });
}

// Strict numeric validation helpers
export function parseStrictNonNegativeDecimal(value: any, fieldName: string): number {
  if (value === undefined || value === null) return 0;
  const str = String(value).trim();
  if (str === "") throw new Error(`${fieldName} cannot be empty string`);
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`${fieldName} must be a non-negative decimal number, got: ${str}`);
  }
  const num = parseFloat(str);
  if (num < 0) throw new Error(`${fieldName} must be >= 0`);
  return num;
}

export function parseStrictPositiveDecimal(value: any, fieldName: string): number {
  if (value === undefined || value === null) throw new Error(`${fieldName} is required`);
  const str = String(value).trim();
  if (str === "") throw new Error(`${fieldName} cannot be empty string`);
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`${fieldName} must be a positive decimal number, got: ${str}`);
  }
  const num = parseFloat(str);
  if (num <= 0) throw new Error(`${fieldName} must be > 0`);
  return num;
}

/**
 * Shared helper to lock user row for points-changing operations.
 * Prevents concurrent overspend by acquiring SELECT FOR UPDATE lock.
 */
export async function lockUserForPoints(userId: number, tx?: any) {
  const database = tx || (await getDb());
  if (!database) throw new Error("Database not available");

  // IPE-005: every points-changing path is also a classified Source-account
  // mutation. When a real transaction is supplied, acquire the canonical
  // users-row + merge-case guard instead of a points-only users-row lock.
  // withUserPointsLock always supplies a transaction (opening one itself when
  // necessary), as do the direct sports/check-in callers.
  if (tx) {
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
    return { id: userId };
  }

  // Legacy fallback for any read/diagnostic caller that invokes this helper
  // without a transaction. The lock cannot outlive this statement, exactly
  // as before IPE-005; mutation entry points must use withUserPointsLock.
  const rawResult: any = await database.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  const userRow = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  if (!userRow || userRow.length === 0) throw new Error("User not found");
  return userRow[0];
}

/**
 * Runs `fn` with the given user's row locked (via lockUserForPoints) for the
 * duration - the shared coordination point every points balance
 * read-modify-write must go through.
 *
 * - If `tx` is already an open transaction, the lock is taken inside it and
 *   `fn` runs on that same tx - it is only ever meaningful because the
 *   CALLER's transaction is what eventually commits or rolls back.
 * - If no `tx` is given, this opens its own transaction scoped to exactly
 *   `fn`'s read-modify-write. This exists because several runtime call
 *   sites (OCR auto-approval finalizing an order, admin points adjustment)
 *   historically called getUserPointsBalance/recordPointsTransaction as two
 *   separate autocommit statements with no lock at all - a real lost-update
 *   window between two concurrent writers for the same user. Wrapping just
 *   the points section here closes that without changing any of the
 *   surrounding (non-points) business logic those callers also run.
 */
export async function withUserPointsLock<T>(
  userId: number,
  tx: any | undefined,
  fn: (lockedTx: any) => Promise<T>
): Promise<T> {
  if (tx) {
    await lockUserForPoints(userId, tx);
    return fn(tx);
  }
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async (newTx: any) => {
    await lockUserForPoints(userId, newTx);
    return fn(newTx);
  });
}

async function lockSportsMatchForAccountMutation(matchId: number, tx: any): Promise<void> {
  const rows = unwrapMysqlRows(
    await tx.execute(sql`SELECT id FROM sportsMatches WHERE id = ${matchId} FOR UPDATE`)
  );
  if (rows.length !== 1) throw new Error("Match not found");
}

export async function castSportsVote(userId: number, matchId: number, prediction: SportsPrediction) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx: any) => {
    // Sports flows share a global match row plus one-or-many account rows.
    // Always lock the match FIRST, then user rows in ascending id order. This
    // prevents vote (user -> match FK) from deadlocking with settle/cancel
    // (match -> users) while preserving the account-merge users-row hierarchy
    // inside the account portion of the transaction.
    await lockSportsMatchForAccountMutation(matchId, tx);
    const match = await getSportsMatchById(matchId, tx);
    if (!match) throw new Error("Match not found");
    if (!match.isActive || match.status !== "open") throw new Error("Voting is not open for this match");
    if (new Date(match.voteDeadlineAt).getTime() <= Date.now()) throw new Error("Voting deadline has passed");

    const existing = await getSportsVoteByMatchAndUser(matchId, userId, tx);
    if (existing) throw new Error("You have already voted for this match");

    const cost = Math.max(0, Number(match.voteCostPoints || 0));
    
    // Lock user row with SELECT FOR UPDATE to prevent concurrent points overspend
    await lockUserForPoints(userId, tx);
    
    const currentBalance = Number(await getUserPointsBalance(userId, tx));
    if (!Number.isFinite(currentBalance) || currentBalance < cost) {
      throw new Error(`Insufficient points. This vote requires ${cost.toFixed(2)} points.`);
    }

    const insertResult = await tx.insert(sportsMatchVotes).values({
      matchId,
      userId,
      prediction,
      pointsSpent: cost.toFixed(2) as any,
      status: "pending",
    });
    const voteId = extractInsertId(insertResult);

    const newBalance = (currentBalance - cost).toFixed(2);
    await recordPointsTransaction({
      userId,
      type: "redeem",
      amount: cost.toFixed(2),
      balanceAfter: newBalance,
      referenceType: "sports_vote",
      referenceId: voteId,
      note: `Sports vote for match #${matchId}`,
    }, tx);

    const vote = await tx.select().from(sportsMatchVotes).where(eq(sportsMatchVotes.id, voteId)).limit(1);
    return vote[0];
  });
}

function buildRewardCouponCode(matchId: number, voteId: number): string {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FB${matchId}V${voteId}${random}`.slice(0, 50);
}

export async function settleSportsMatch(matchId: number, result: SportsPrediction) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx: any) => {
    await lockSportsMatchForAccountMutation(matchId, tx);
    const match = await getSportsMatchById(matchId, tx);
    if (!match) throw new Error("Match not found");

    // A retry of the exact same settlement is a read-only success. Because
    // match status, vote statuses, reward ledger rows, coupons/points, and the
    // points transaction all commit in this one transaction, a committed
    // settled row implies the original settlement committed as a unit.
    if (match.status === "settled") {
      if (match.result !== result) {
        throw new Error(`Match was already settled with result ${match.result}`);
      }
      const existingRewards = await tx
        .select({ id: sportsMatchRewards.id })
        .from(sportsMatchRewards)
        .where(eq(sportsMatchRewards.matchId, matchId));
      return { success: true, winnerCount: existingRewards.length, idempotent: true };
    }
    if (match.status === "cancelled") throw new Error("Cancelled match cannot be settled");
    if (match.status === "draft") {
      throw new Error("Cannot settle draft match. Must be closed or deadline must have passed.");
    }
    if (match.status === "open" && new Date(match.voteDeadlineAt).getTime() > Date.now()) {
      throw new Error("Cannot settle open match before voting deadline has passed.");
    }

    const rewardKind: SportsRewardKind = match.rewardKind === "points" ? "points" : "coupon";
    let pointsRewardAmount: string | null = null;
    if (rewardKind === "points") {
      const parsed = parseStrictPositiveDecimal(match.rewardPointsAmount, "rewardPointsAmount");
      pointsRewardAmount = parsed.toFixed(2);
    } else {
      if (match.rewardDiscountType !== "flat" && match.rewardDiscountType !== "percentage") {
        throw new Error("Coupon reward requires rewardDiscountType");
      }
      const discountValue = parseStrictPositiveDecimal(match.rewardDiscountValue, "rewardDiscountValue");
      if (match.rewardDiscountType === "percentage" && discountValue > 100) {
        throw new Error("rewardDiscountValue cannot exceed 100 for percentage discounts");
      }
      parseStrictNonNegativeDecimal(match.rewardMinPurchaseAmount ?? "0", "rewardMinPurchaseAmount");
    }

    await updateSportsMatch(matchId, { status: "settled", result }, tx);

    const votes = await tx
      .select()
      .from(sportsMatchVotes)
      .where(eq(sportsMatchVotes.matchId, matchId));

    // Acquire all Source-account guards in canonical order before mutating any
    // winner. Point winners then take the same user lock before their balance
    // read-modify-write, matching every other points writer in this repository.
    const pendingUserIds = votes.filter((vote: any) => vote.status === "pending").map((vote: any) => vote.userId);
    if (pendingUserIds.length > 0) {
      await assertAccountMergeClassifiedMutationsAllowed(pendingUserIds, tx);
    }

    let winnerCount = 0;

    for (const vote of votes) {
      if (vote.status !== "pending") continue;

      if (vote.prediction !== result) {
        await tx.update(sportsMatchVotes).set({ status: "lost" }).where(eq(sportsMatchVotes.id, vote.id));
        continue;
      }

      const existingReward = await tx
        .select()
        .from(sportsMatchRewards)
        .where(eq(sportsMatchRewards.voteId, vote.id))
        .limit(1);
      if (existingReward.length) {
        await tx.update(sportsMatchVotes).set({ status: "won" }).where(eq(sportsMatchVotes.id, vote.id));
        winnerCount += 1;
        continue;
      }

      if (rewardKind === "points") {
        const amount = pointsRewardAmount!;
        await lockUserForPoints(vote.userId, tx);
        const currentBalance = await getUserPointsBalance(vote.userId, tx);
        const balanceAfter = formatMoney(moneyAdd(currentBalance, amount), "sportsRewardBalanceAfter");

        // Insert the unique vote->reward arbiter before touching the points
        // ledger. The transaction-level match lock serializes settlement and
        // uniqueVoteId makes a second reward for this vote structurally illegal.
        const rewardResult = await tx.insert(sportsMatchRewards).values({
          matchId,
          voteId: vote.id,
          userId: vote.userId,
          rewardKind: "points",
          couponId: null,
          pointsAmount: amount as any,
          pointsTransactionId: null,
          status: "issued",
          issuedAt: new Date(),
        });
        const rewardId = extractInsertId(rewardResult);
        const pointsTransactionId = await recordPointsTransactionReturningId({
          userId: vote.userId,
          type: "earn",
          amount,
          balanceAfter,
          referenceType: "sports_reward",
          referenceId: rewardId,
          note: `Sports prediction reward for match #${matchId}`,
        }, tx);
        await tx
          .update(sportsMatchRewards)
          .set({ pointsTransactionId })
          .where(eq(sportsMatchRewards.id, rewardId));
        await tx
          .update(sportsMatchVotes)
          .set({ status: "won", rewardCouponId: null, rewardCouponCode: null })
          .where(eq(sportsMatchVotes.id, vote.id));
      } else {
        const code = buildRewardCouponCode(matchId, vote.id);
        const couponResult = await tx.insert(coupons).values({
          code,
          discountType: match.rewardDiscountType as "flat" | "percentage",
          discountValue: match.rewardDiscountValue as any,
          minPurchaseAmount: (match.rewardMinPurchaseAmount || "0.00") as any,
          maxUsageCount: 1,
          usageCount: 0,
          isActive: true,
          expiresAt: match.rewardCouponExpiresAt || null,
          scope: "user",
          ownerUserId: vote.userId,
        });
        const couponId = extractInsertId(couponResult);
        await tx.insert(sportsMatchRewards).values({
          matchId,
          voteId: vote.id,
          userId: vote.userId,
          rewardKind: "coupon",
          couponId,
          pointsAmount: null,
          pointsTransactionId: null,
          status: "issued",
          issuedAt: new Date(),
        });
        await tx
          .update(sportsMatchVotes)
          .set({ status: "won", rewardCouponId: couponId, rewardCouponCode: code })
          .where(eq(sportsMatchVotes.id, vote.id));
      }

      winnerCount += 1;
    }

    return { success: true, winnerCount, idempotent: false };
  });
}

export async function cancelSportsMatch(matchId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx: any) => {
    await lockSportsMatchForAccountMutation(matchId, tx);
    const match = await getSportsMatchById(matchId, tx);
    if (!match) throw new Error("Match not found");
    if (match.status === "settled") throw new Error("Settled match cannot be cancelled");

    await updateSportsMatch(matchId, { status: "cancelled" }, tx);

    const pendingVotes = await tx
      .select()
      .from(sportsMatchVotes)
      .where(and(eq(sportsMatchVotes.matchId, matchId), eq(sportsMatchVotes.status, "pending")));

    if (pendingVotes.length > 0) {
      await assertAccountMergeClassifiedMutationsAllowed(pendingVotes.map((vote: any) => vote.userId), tx);
    }

    for (const vote of pendingVotes) {
      // Lock this voter's row BEFORE reading their balance - refunding N
      // voters in a loop with no lock is a real read-modify-write race
      // against any other concurrent points writer for the same user
      // (this refund loop was already inside a real transaction, it just
      // never took the row lock that makes that transaction's isolation
      // actually protect the balance arithmetic).
      await lockUserForPoints(vote.userId, tx);
      const refundAmount = Number(vote.pointsSpent || 0);
      const currentBalance = Number(await getUserPointsBalance(vote.userId, tx));
      const newBalance = (currentBalance + refundAmount).toFixed(2);

      await recordPointsTransaction({
        userId: vote.userId,
        type: "refund",
        amount: refundAmount.toFixed(2),
        balanceAfter: newBalance,
        referenceType: "sports_vote_refund",
        referenceId: vote.id,
        note: `Refund for cancelled sports match #${matchId}`,
      }, tx);

      await tx.update(sportsMatchVotes).set({ status: "refunded" }).where(eq(sportsMatchVotes.id, vote.id));
    }

    return { success: true, refundedCount: pendingVotes.length };
  });
}


export async function markSportsRewardCouponUsed(
  couponId: number,
  userId: number,
  tx?: any
): Promise<void> {
  if (!tx) {
    return withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedTx) =>
      markSportsRewardCouponUsed(couponId, userId, guardedTx)
    );
  }
  const db = tx;
  await assertAccountMergeClassifiedMutationAllowed(userId, tx);

  // Find reward record for this coupon and user
  const reward = await db
    .select()
    .from(sportsMatchRewards)
    .where(and(eq(sportsMatchRewards.couponId, couponId), eq(sportsMatchRewards.userId, userId)))
    .limit(1);

  if (reward.length > 0 && reward[0].status === "issued") {
    // Mark reward as used
    await db
      .update(sportsMatchRewards)
      .set({
        status: "used",
        usedAt: new Date(),
      })
      .where(eq(sportsMatchRewards.id, reward[0].id));
  }
}

export async function getSportsRewardsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rewards = await db
    .select({
      matchId: sportsMatches.id,
      matchTitle: sportsMatches.title,
      homeTeamName: sportsMatches.homeTeamName,
      awayTeamName: sportsMatches.awayTeamName,
      prediction: sportsMatchVotes.prediction,
      result: sportsMatches.result,
      voteStatus: sportsMatchVotes.status,
      rewardKind: sportsMatchRewards.rewardKind,
      rewardStatusRaw: sportsMatchRewards.status,
      pointsAmount: sportsMatchRewards.pointsAmount,
      pointsTransactionId: sportsMatchRewards.pointsTransactionId,
      balanceAfterGrant: pointsTransactions.balanceAfter,
      couponCode: coupons.code,
      discountType: coupons.discountType,
      discountValue: coupons.discountValue,
      minPurchaseAmount: coupons.minPurchaseAmount,
      expiresAt: coupons.expiresAt,
      usedAt: sportsMatchRewards.usedAt,
      issuedAt: sportsMatchRewards.createdAt,
    })
    .from(sportsMatchRewards)
    .innerJoin(sportsMatches, eq(sportsMatchRewards.matchId, sportsMatches.id))
    .innerJoin(sportsMatchVotes, eq(sportsMatchRewards.voteId, sportsMatchVotes.id))
    .leftJoin(coupons, eq(sportsMatchRewards.couponId, coupons.id))
    .leftJoin(pointsTransactions, eq(sportsMatchRewards.pointsTransactionId, pointsTransactions.id))
    .where(eq(sportsMatchRewards.userId, userId))
    .orderBy(desc(sportsMatchRewards.createdAt));

  return rewards.map((reward: any) => ({
    ...reward,
    rewardStatus: reward.rewardStatusRaw === "void"
      ? "void"
      : reward.rewardKind === "points"
        ? "granted"
        : reward.rewardStatusRaw === "used"
          ? "used"
          : reward.expiresAt && new Date(reward.expiresAt).getTime() <= Date.now()
            ? "expired"
            : "issued",
  }));
}

// ============ DAILY CHECK-IN ============

const DAILY_CHECKIN_CAMPAIGN_KEY = "default";

function buildDailyCheckinCouponCode(userId: number, checkinDate: string): string {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  const compactDate = checkinDate.replace(/-/g, "");
  return `CHKIN${compactDate}U${userId}${random}`.slice(0, 50);
}

export interface DailyCheckinRewardSummary {
  couponId: number;
  couponCode: string;
  discountType: string;
  discountValue: string;
  maxDiscountAmount: string | null;
  minPurchaseAmount: string;
  expiresAt: Date | null;
  status: string;
}

interface DailyCheckinJoinedRow {
  id: number;
  checkinDate: string;
  status: string;
  issuedAt: Date;
  /** NULL for a point-reward check-in - those mint no coupon at all. */
  couponId: number | null;
  couponCode: string | null;
  discountType: string | null;
  discountValue: string | null;
  maxDiscountAmount: string | null;
  minPurchaseAmount: string | null;
  expiresAt: Date | null;
}

/**
 * A single reward attached to a check-in, as an explicit discriminated
 * union. Point rewards and coupon rewards never share fields - overloading
 * the coupon fields to carry a point value is exactly the ambiguity this
 * shape exists to prevent.
 */
export type DailyCheckinReward =
  | {
      kind: "points";
      pointsAmount: string;
      pointsTransactionId: number;
      // The HISTORICAL balanceAfter recorded on the linked pointsTransactions
      // row at the moment this grant was created - a fixed snapshot, not the
      // user's current balance (which can differ if they earned or spent
      // points since). Deliberately named distinctly from the CURRENT
      // balance, which is reported once at the top level of the
      // status/claim response as `pointsBalance`. A user who earned this
      // point and later spent it still shows balanceAfterGrant unchanged;
      // only pointsBalance reflects the spend.
      balanceAfterGrant: string;
      streakCountAtGrant: number;
    }
  | {
      kind: "coupon";
      couponId: number;
      couponCode: string;
      discountType: string;
      discountValue: string;
      maxDiscountAmount: string | null;
      minPurchaseAmount: string;
      expiresAt: Date | null;
      status: string;
    };

/**
 * The legacy coupon-only summary. Retained for backward compatibility with
 * clients that still read `reward`; it is populated ONLY for a coupon
 * reward and is always null for a point reward (never repurposed).
 */
function toDailyCheckinRewardSummary(row: DailyCheckinJoinedRow): DailyCheckinRewardSummary | null {
  if (row.couponId === null || row.couponCode === null) return null;
  return {
    couponId: row.couponId,
    couponCode: row.couponCode,
    discountType: row.discountType!,
    discountValue: row.discountValue!,
    maxDiscountAmount: row.maxDiscountAmount,
    minPurchaseAmount: row.minPurchaseAmount!,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

/**
 * The consecutive-day streak this check-in represents, counting the claim
 * being made right now as the newest day.
 *
 * Counts BOTH legacy coupon check-ins and point check-ins - a user who
 * checked in every day across the cutover has an unbroken streak, because
 * from their point of view they did check in every day.
 *
 * Exact for any streak length, with no arbitrary cap: rather than one
 * unbounded SELECT (or capping the answer at some maximum, which would
 * quietly under-report a real 401-day streak as 400), history is paged
 * backwards in bounded batches of STREAK_BATCH_SIZE rows. Each batch is
 * walked date-by-date; the walk stops the instant a date is missing from
 * that batch (a real gap - the streak is final) and only fetches another,
 * older batch when the current one was entirely consecutive with no gap
 * found in it. A user's total history is therefore read at most
 * ceil(streakLength / STREAK_BATCH_SIZE) times, never once as an unbounded
 * scan of their whole check-in history.
 *
 * Assumes at most one dailyCheckins row per (userId, checkinDate) - true
 * today because every claim path uses the single DAILY_CHECKIN_CAMPAIGN_KEY
 * ("default"); a second campaignKey sharing a date would need its own
 * de-duplication here, which does not yet exist because nothing writes one.
 *
 * All arithmetic is on "YYYY-MM-DD" Bangkok business dates via
 * getPreviousBangkokBusinessDate - never Date.toISOString().slice(0,10)
 * (that is UTC, and is wrong for every request between 00:00 and 06:59 Thai
 * time), so month/year/leap-day boundaries are handled correctly.
 */
const STREAK_BATCH_SIZE = 400;

export async function calculateDailyCheckinStreak(
  userId: number,
  currentCheckinDate: string,
  tx?: any
): Promise<number> {
  const database = tx || (await getDb());
  if (!database) return 1;

  let streak = 1; // the claim happening right now is the newest day
  let cursor = getPreviousBangkokBusinessDate(currentCheckinDate);
  let upperBoundExclusive = currentCheckinDate;

  for (;;) {
    const rows = await database
      .select({ checkinDate: dailyCheckins.checkinDate })
      .from(dailyCheckins)
      .where(and(eq(dailyCheckins.userId, userId), lt(dailyCheckins.checkinDate, upperBoundExclusive)))
      .orderBy(desc(dailyCheckins.checkinDate))
      .limit(STREAK_BATCH_SIZE);

    if (rows.length === 0) break; // no more history at all

    const datesInBatch = new Set<string>(rows.map((r: any) => String(r.checkinDate)));

    let foundGap = false;
    for (let i = 0; i < STREAK_BATCH_SIZE; i += 1) {
      if (!datesInBatch.has(cursor)) {
        foundGap = true;
        break;
      }
      streak += 1;
      cursor = getPreviousBangkokBusinessDate(cursor);
    }

    if (foundGap) break; // a real gap - the streak is final
    if (rows.length < STREAK_BATCH_SIZE) break; // consumed all remaining history with no gap

    // Whole batch was consecutive - page further back, strictly before the
    // oldest date this batch returned.
    upperBoundExclusive = String(rows[rows.length - 1].checkinDate);
  }

  return streak;
}

async function getDailyCheckinForUserAndDate(
  userId: number,
  checkinDate: string,
  tx?: any
): Promise<DailyCheckinJoinedRow | undefined> {
  const database = tx || (await getDb());
  if (!database) return undefined;

  const result = await database
    .select({
      id: dailyCheckins.id,
      checkinDate: dailyCheckins.checkinDate,
      status: dailyCheckins.status,
      issuedAt: dailyCheckins.issuedAt,
      couponId: coupons.id,
      couponCode: coupons.code,
      discountType: coupons.discountType,
      discountValue: coupons.discountValue,
      maxDiscountAmount: coupons.maxDiscountAmount,
      minPurchaseAmount: coupons.minPurchaseAmount,
      expiresAt: coupons.expiresAt,
    })
    .from(dailyCheckins)
    // LEFT JOIN, not INNER: since migration 0031 a point-reward check-in has
    // couponId = NULL and no coupon row at all. An INNER JOIN would make
    // every point check-in silently vanish from status/claim reads, which
    // would in turn let the same user claim again.
    .leftJoin(coupons, eq(dailyCheckins.couponId, coupons.id))
    .where(
      and(
        eq(dailyCheckins.userId, userId),
        eq(dailyCheckins.checkinDate, checkinDate),
        eq(dailyCheckins.campaignKey, DAILY_CHECKIN_CAMPAIGN_KEY)
      )
    )
    .limit(1);

  return result[0];
}

/**
 * The point reward attached to a given check-in row, if any. Read separately
 * from the coupon join above so neither reward kind has to be squeezed into
 * the other's columns.
 */
async function getDailyCheckinPointsReward(
  dailyCheckinId: number,
  tx?: any
): Promise<{ pointsAmount: string; pointsTransactionId: number; streakCountAtGrant: number; balanceAfterGrant: string } | undefined> {
  const database = tx || (await getDb());
  if (!database) return undefined;

  // LEFT JOIN pointsTransactions to read its balanceAfter - the historical
  // snapshot recorded at the moment of THIS grant, not the user's current
  // balance (which getUserPointsBalance would return, and which can differ
  // if the user has since earned or spent more points).
  const rows = await database
    .select({
      pointsAmount: dailyCheckinRewardGrants.pointsAmount,
      pointsTransactionId: dailyCheckinRewardGrants.pointsTransactionId,
      streakCountAtGrant: dailyCheckinRewardGrants.streakCountAtGrant,
      balanceAfterGrant: pointsTransactions.balanceAfter,
    })
    .from(dailyCheckinRewardGrants)
    .leftJoin(pointsTransactions, eq(dailyCheckinRewardGrants.pointsTransactionId, pointsTransactions.id))
    .where(
      and(
        eq(dailyCheckinRewardGrants.dailyCheckinId, dailyCheckinId),
        eq(dailyCheckinRewardGrants.rewardKind, "points")
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.pointsTransactionId === null) return undefined;
  return {
    pointsAmount: String(row.pointsAmount ?? "0.00"),
    pointsTransactionId: row.pointsTransactionId,
    streakCountAtGrant: row.streakCountAtGrant,
    balanceAfterGrant: String(row.balanceAfterGrant ?? "0.00"),
  };
}

/**
 * Builds the forward-compatible `rewards[]` array for one check-in row:
 * exactly one coupon entry for a legacy claim, or exactly one points entry
 * for a point claim, never both and never a hybrid.
 */
async function buildDailyCheckinRewards(row: DailyCheckinJoinedRow, tx?: any): Promise<DailyCheckinReward[]> {
  const couponSummary = toDailyCheckinRewardSummary(row);
  if (couponSummary) {
    return [{ kind: "coupon", ...couponSummary }];
  }

  const points = await getDailyCheckinPointsReward(row.id, tx);
  if (!points) return [];

  return [
    {
      kind: "points",
      pointsAmount: points.pointsAmount,
      pointsTransactionId: points.pointsTransactionId,
      balanceAfterGrant: points.balanceAfterGrant,
      streakCountAtGrant: points.streakCountAtGrant,
    },
  ];
}

export interface DailyCheckinStatusResult {
  checkedInToday: boolean;
  checkinDate: string;
  checkedInAt: Date | null;
  campaignActive: boolean;
  /** Which reward the server would hand out right now. */
  rewardMode: "legacy_coupon" | "points" | "disabled";
  nextCheckinAt: Date;
  pointsBalance: string;
  /** Forward-compatible, explicitly discriminated. Primary field. */
  rewards: DailyCheckinReward[];
  /** Compatibility only - populated for a legacy coupon reward, always null for a point reward. */
  reward: DailyCheckinRewardSummary | null;
}

export async function getDailyCheckinStatus(userId: number): Promise<DailyCheckinStatusResult> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");

  const runtime = await resolveDailyCheckinRuntimeMode();
  const checkinDate = runtime.businessDate;
  const existing = await getDailyCheckinForUserAndDate(userId, checkinDate);

  return {
    checkedInToday: !!existing,
    checkinDate,
    checkedInAt: existing?.issuedAt ?? null,
    campaignActive: runtime.mode !== "disabled",
    rewardMode: runtime.mode,
    nextCheckinAt: getNextBangkokDayStart(checkinDate),
    pointsBalance: await getUserPointsBalance(userId),
    rewards: existing ? await buildDailyCheckinRewards(existing) : [],
    reward: existing ? toDailyCheckinRewardSummary(existing) : null,
  };
}

export interface DailyCheckinClaimResult {
  claimed: boolean;
  alreadyClaimed: boolean;
  campaignActive: boolean;
  rewardMode: "legacy_coupon" | "points" | "disabled";
  checkinDate: string;
  pointsBalance: string;
  rewards: DailyCheckinReward[];
  /** Compatibility only - null for a point reward. */
  reward: DailyCheckinRewardSummary | null;
}

/**
 * Claim today's daily check-in reward.
 *
 * Two reward modes, chosen entirely server-side by
 * resolveDailyCheckinRuntimeMode() - the client never sends a date, an
 * amount, or a mode:
 *
 *   "legacy_coupon" - the historical behavior: mint a one-use percentage
 *                     coupon and link it to the check-in row.
 *   "points"        - grant exactly 1.00 point through the pointsTransactions
 *                     ledger, with couponId left NULL.
 *
 * Idempotent in its result either way: calling this twice on the same
 * Bangkok business day never produces a second reward. The second call - and
 * any concurrent racing call - returns alreadyClaimed: true describing the
 * same reward the winner created.
 *
 * Concurrency safety comes from the database, not from the fast-path
 * pre-check: dailyCheckins' UNIQUE(userId, checkinDate, campaignKey) is the
 * race arbiter. The loser's ENTIRE transaction rolls back - coupon insert,
 * points transaction, and reward grant included - and it then re-reads the
 * winner's row. Because both modes share that one campaignKey ("default"),
 * a coupon claimed earlier on the cutover date also blocks a point claim
 * later the same Bangkok day.
 */
export async function claimDailyCheckin(userId: number): Promise<DailyCheckinClaimResult> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");

  const runtime = await resolveDailyCheckinRuntimeMode();
  const checkinDate = runtime.businessDate;

  const describeExisting = async (row: DailyCheckinJoinedRow | undefined): Promise<DailyCheckinClaimResult> => ({
    claimed: false,
    alreadyClaimed: !!row,
    campaignActive: runtime.mode !== "disabled",
    rewardMode: runtime.mode,
    checkinDate,
    pointsBalance: await getUserPointsBalance(userId),
    rewards: row ? await buildDailyCheckinRewards(row) : [],
    reward: row ? toDailyCheckinRewardSummary(row) : null,
  });

  // Kill switch (or any unsafe/ambiguous configuration): report an already
  // issued reward honestly - a user who claimed before it was disabled keeps
  // what they earned - but never create a new one.
  if (runtime.mode === "disabled") {
    return describeExisting(await getDailyCheckinForUserAndDate(userId, checkinDate));
  }

  // Fast path only - NOT the correctness guarantee (see the duplicate-key
  // recovery below). Avoids opening a write transaction for the common
  // "already checked in today" / double-click case.
  const existingBeforeTx = await getDailyCheckinForUserAndDate(userId, checkinDate);
  if (existingBeforeTx) {
    return describeExisting(existingBeforeTx);
  }

  try {
    if (runtime.mode === "points") {
      const claimed = await claimDailyCheckinPointReward(database, userId, checkinDate, runtime);
      // A racer that lost the under-lock re-read granted nothing - it must
      // report alreadyClaimed, not claim credit for the winner's reward.
      return {
        claimed: claimed.granted,
        alreadyClaimed: !claimed.granted,
        campaignActive: true,
        rewardMode: "points",
        checkinDate,
        pointsBalance: claimed.currentBalance,
        rewards: claimed.reward ? [claimed.reward] : [],
        reward: null, // never repurpose the coupon field for a point reward
      };
    }

    const issued = await claimDailyCheckinCouponReward(database, userId, checkinDate);
    return {
      claimed: true,
      alreadyClaimed: false,
      campaignActive: true,
      rewardMode: "legacy_coupon",
      checkinDate,
      pointsBalance: await getUserPointsBalance(userId),
      rewards: [{ kind: "coupon", ...issued }],
      reward: issued,
    };
  } catch (error: any) {
    // The losing side of a same-day race. isDuplicateKeyError walks the
    // cause chain - drizzle wraps the mysql2 error, so errno/code are
    // undefined on the error we actually catch here and only appear on
    // `error.cause`. Reading the top level alone (the original behavior)
    // made this whole branch unreachable, so a user who double-clicked got
    // an INTERNAL_SERVER_ERROR even though their check-in had succeeded.
    if (isDuplicateKeyError(error)) {
      const winner = await getDailyCheckinForUserAndDate(userId, checkinDate);
      if (winner) return describeExisting(winner);
    }
    throw error;
  }
}

/** Legacy path: one transaction inserting the coupon and its check-in row. */
async function claimDailyCheckinCouponReward(
  database: any,
  userId: number,
  checkinDate: string
): Promise<DailyCheckinRewardSummary> {
  const config = await getEffectiveDailyCheckinConfig();

  return database.transaction(async (tx: any) => {
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
    const code = buildDailyCheckinCouponCode(userId, checkinDate);
    const expiresAt = new Date(Date.now() + config.validityDays * 24 * 60 * 60 * 1000);
    const discountValue = config.rewardPercent.toFixed(2);
    const maxDiscountAmount = config.maxDiscountAmount.toFixed(2);
    const minPurchaseAmount = config.minPurchaseAmount.toFixed(2);

    const couponResult = await tx.insert(coupons).values({
      code,
      discountType: "percentage",
      discountValue,
      maxDiscountAmount,
      minPurchaseAmount,
      maxUsageCount: 1,
      usageCount: 0,
      isActive: true,
      expiresAt,
      // Explicit ownership (in addition to, not instead of, the
      // dailyCheckins row inserted below - getRewardCouponOwnership's
      // join-based check remains the authoritative fallback for coupons
      // issued before this column existed).
      scope: "user",
      ownerUserId: userId,
    });
    const couponId = extractInsertId(couponResult);

    // The race arbiter - a concurrent request that already committed this
    // (userId, checkinDate, campaignKey) makes this throw ER_DUP_ENTRY and
    // rolls the whole transaction back, coupon insert included.
    await tx.insert(dailyCheckins).values({
      userId,
      checkinDate,
      campaignKey: DAILY_CHECKIN_CAMPAIGN_KEY,
      couponId,
      status: "issued",
      issuedAt: new Date(),
    });

    return {
      couponId,
      couponCode: code,
      discountType: "percentage",
      discountValue,
      maxDiscountAmount,
      minPurchaseAmount,
      expiresAt,
      status: "issued",
    };
  });
}

/**
 * Point path. All three rows - dailyCheckins, pointsTransactions and
 * dailyCheckinRewardGrants - commit or roll back together, so a failure at
 * any step leaves no check-in, no ledger entry, no grant, and an unchanged
 * balance.
 *
 * Ordering inside the transaction is deliberate:
 *   1. lockUserForPoints  - serializes this user's balance arithmetic
 *                           against any other points writer.
 *   2. re-read the check-in row UNDER the lock - a racer that committed
 *                           while we waited is detected here without ever
 *                           touching the ledger.
 *   3. read the balance once, then compute the new balance from it.
 *   4. insert the check-in row (the arbiter) BEFORE the ledger write, so a
 *                           loser fails before crediting anything.
 *   5. insert the points transaction, then the grant that links them.
 */
async function claimDailyCheckinPointReward(
  database: any,
  userId: number,
  checkinDate: string,
  runtime: Extract<DailyCheckinRuntimeMode, { mode: "points" }>
): Promise<{ granted: boolean; reward: DailyCheckinReward | undefined; currentBalance: string }> {
  const result = await database.transaction(async (tx: any) => {
    await lockUserForPoints(userId, tx);

    // Re-read under the lock; never trust the pre-lock fast path.
    const alreadyExists = await getDailyCheckinForUserAndDate(userId, checkinDate, tx);
    if (alreadyExists) return { existing: alreadyExists as DailyCheckinJoinedRow };

    const previousBalance = await getUserPointsBalance(userId, tx);
    const balanceAfter = formatMoney(
      moneyAdd(previousBalance, runtime.pointsAmount),
      "dailyCheckinBalanceAfter"
    );
    const streakCountAtGrant = await calculateDailyCheckinStreak(userId, checkinDate, tx);

    // Race arbiter, and deliberately before any ledger write.
    const checkinResult = await tx.insert(dailyCheckins).values({
      userId,
      checkinDate,
      campaignKey: DAILY_CHECKIN_CAMPAIGN_KEY,
      couponId: null,
      status: "issued",
      issuedAt: new Date(),
    });
    const dailyCheckinId = extractInsertId(checkinResult);

    const pointsTransactionId = await recordPointsTransactionReturningId(
      {
        userId,
        type: "earn",
        amount: runtime.pointsAmount,
        balanceAfter,
        referenceType: DAILY_CHECKIN_POINTS_REFERENCE_TYPE,
        referenceId: dailyCheckinId,
        // Non-PII: a Bangkok business date and nothing else.
        note: `Daily check-in reward ${checkinDate}`,
      },
      tx
    );

    await tx.insert(dailyCheckinRewardGrants).values({
      dailyCheckinId,
      userId,
      campaignId: runtime.campaign.id,
      ruleId: runtime.rule.id,
      rewardKind: "points",
      grantReason: "daily",
      milestoneDay: null,
      milestoneInstanceNumber: null,
      // NOT NULL with no database default - must always be set explicitly.
      streakCountAtGrant,
      pointsAmount: runtime.pointsAmount,
      pointsTransactionId,
      couponId: null,
      status: "granted",
    });

    return {
      granted: {
        reward: {
          kind: "points" as const,
          pointsAmount: runtime.pointsAmount,
          pointsTransactionId,
          balanceAfterGrant: balanceAfter,
          streakCountAtGrant,
        },
        currentBalance: balanceAfter,
      },
    };
  });

  if ("existing" in result && result.existing) {
    // A racer won while we waited on the user lock. Surface its reward, but
    // report granted:false - this call created nothing.
    const rewards = await buildDailyCheckinRewards(result.existing);
    const points = rewards.find((r) => r.kind === "points");
    return {
      granted: false,
      reward: points ?? rewards[0],
      currentBalance: await getUserPointsBalance(userId),
    };
  }

  return { granted: true, ...(result as any).granted };
}

export async function markDailyCheckinCouponUsed(couponId: number, userId: number, tx?: any): Promise<void> {
  if (!tx) {
    await withAccountMergeClassifiedMutationGuard(userId, undefined, async (guardedTx) =>
      markDailyCheckinCouponUsed(couponId, userId, guardedTx)
    );
    return;
  }
  const database = tx;
  await assertAccountMergeClassifiedMutationAllowed(userId, tx);

  const reward = await database
    .select()
    .from(dailyCheckins)
    .where(and(eq(dailyCheckins.couponId, couponId), eq(dailyCheckins.userId, userId)))
    .limit(1);

  if (reward.length > 0 && reward[0].status === "issued") {
    await database
      .update(dailyCheckins)
      .set({ status: "used", usedAt: new Date() })
      .where(eq(dailyCheckins.id, reward[0].id));
  }
}

/**
 * Update wallet top-up with OCR results and approval
 */
/**
 * Statuses a wallet top-up may still be moved out of. `approved` and
 * `rejected` are FINAL: no OCR write may ever bring one back.
 */
const REVIEWABLE_TOPUP_STATUSES = ["pending", "pending_review"] as const;

/**
 * Applies an OCR-derived update to a wallet top-up.
 *
 * DEFENSE IN DEPTH: any update that moves a top-up INTO `pending_review` is
 * conditional on the row still being reviewable. An unconditional
 * `WHERE id = ?` let a late-finishing OCR pass reopen a top-up an admin had
 * already approved or rejected - and a reopened, already-credited top-up
 * could be approved a second time. The guard is applied by the destination
 * status rather than by an opt-in flag so a future caller cannot forget it.
 *
 * Returns `applied: false` when the guard rejected the write; the row is then
 * returned UNCHANGED so the caller can reflect the authoritative current
 * state instead of asserting one it did not create.
 */
export async function applyWalletTopupOcrUpdate(
  topupId: number,
  updates: {
    status?: string;
    slipSubmittedAt?: Date;
    extractedData?: string;
    ocrConfidence?: number;
    visionConfidence?: number;
    structuredConfidence?: number;
    finalConfidence?: number;
    duplicateStatus?: string;
    ocrDecision?: string;
    reviewReason?: string;
    approvalSource?: string;
    approvedAt?: Date;
    creditedAmount?: string;
  },
  /**
   * When provided (alongside a "pending_review" write), the write also
   * requires `slipImageUrl`/`slipSubmittedAt` to still match this exact
   * pair. This OCR run's extractedData was computed against a specific slip
   * snapshot; if the customer replaces the slip while the run is still in
   * flight, the version no longer matches and the write is refused - a
   * status-only CAS would have let a run for the OLD slip land its result
   * on the NEW one, since replacing a slip does not change status.
   */
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updateData: any = {
    updatedAt: new Date(),
  };

  if (updates.status) updateData.status = updates.status;
  if (updates.slipSubmittedAt) updateData.slipSubmittedAt = updates.slipSubmittedAt;
  if (updates.extractedData) updateData.extractedData = updates.extractedData;
  if (updates.ocrConfidence !== undefined) updateData.ocrConfidence = updates.ocrConfidence;
  if (updates.visionConfidence !== undefined) updateData.visionConfidence = updates.visionConfidence;
  if (updates.structuredConfidence !== undefined) updateData.structuredConfidence = updates.structuredConfidence;
  if (updates.finalConfidence !== undefined) updateData.finalConfidence = updates.finalConfidence;
  if (updates.duplicateStatus) updateData.duplicateStatus = updates.duplicateStatus;
  if (updates.ocrDecision) updateData.ocrDecision = updates.ocrDecision;
  if (updates.reviewReason) updateData.reviewReason = updates.reviewReason;
  if (updates.approvalSource) updateData.approvalSource = updates.approvalSource;
  if (updates.approvedAt) updateData.approvedAt = updates.approvedAt;
  if (updates.creditedAmount) updateData.creditedAmount = updates.creditedAmount;

  const guarded = updates.status === "pending_review";
  const guardConditions = [
    eq(walletTopups.id, topupId),
    or(
      eq(walletTopups.status, REVIEWABLE_TOPUP_STATUSES[0] as any),
      eq(walletTopups.status, REVIEWABLE_TOPUP_STATUSES[1] as any)
    ),
  ];
  if (expectedSlipVersion) {
    guardConditions.push(
      expectedSlipVersion.slipImageUrl === null
        ? isNull(walletTopups.slipImageUrl)
        : eq(walletTopups.slipImageUrl, expectedSlipVersion.slipImageUrl)
    );
    guardConditions.push(
      expectedSlipVersion.slipSubmittedAt === null
        ? isNull(walletTopups.slipSubmittedAt)
        : eq(walletTopups.slipSubmittedAt, expectedSlipVersion.slipSubmittedAt)
    );
  }
  const whereClause = guarded ? and(...guardConditions) : eq(walletTopups.id, topupId);

  return withAccountMergeWalletTopupMutationGuard(topupId, undefined, async (guardedDb) => {
    const result = await guardedDb.update(walletTopups).set(updateData).where(whereClause);
    const header = Array.isArray(result) ? result[0] : result;
    const affectedRows = (header as any)?.affectedRows || 0;

    const topup = (
      await guardedDb.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1)
    )[0];

    return { applied: !guarded || affectedRows > 0, topup };
  });
}

/**
 * Backwards-compatible wrapper. Carries the same reopen guard as
 * `applyWalletTopupOcrUpdate` - callers that need to know whether the write
 * actually landed should use that function directly.
 */
export async function updateWalletTopupWithOCRApproval(
  topupId: number,
  updates: Parameters<typeof applyWalletTopupOcrUpdate>[1]
) {
  const { topup } = await applyWalletTopupOcrUpdate(topupId, updates);
  return topup;
}

/**
 * Get wallet transaction by reference (for idempotency check)
 */
export async function getWalletTransactionByReference(
  userId: number,
  referenceType: string,
  referenceId: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return (
    await db
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, userId),
          eq(walletTransactions.referenceType, referenceType),
          eq(walletTransactions.referenceId, parseInt(referenceId))
        )
      )
      .limit(1)
  )[0];
}

export async function getWalletTransactionsByReference(
  userId: number,
  referenceType: string,
  referenceId: string,
  limit: number = 20
) {
  const db = await getDb();
  if (!db) return [];

  return await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.userId, userId),
        eq(walletTransactions.referenceType, referenceType),
        eq(walletTransactions.referenceId, parseInt(referenceId))
      )
    )
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit);
}

/**
 * Get all wallet top-ups for a user (for duplicate detection)
 */
export async function getWalletTopupsByUserId(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.userId, userId))
    .orderBy(desc(walletTopups.createdAt));
}


/**
 * Transactional approve wallet top-up with OCR data (idempotent)
 * Used by OCR auto-approval flow to ensure atomicity and prevent double-crediting
 */
export async function approveWalletTopupWithOCR(
  topupId: number,
  ocrData: {
    status: "approved" | "pending_review";
    slipSubmittedAt: Date;
    extractedData: string;
    ocrConfidence?: number;
    visionConfidence?: number;
    structuredConfidence?: number;
    finalConfidence?: number;
    duplicateStatus?: string;
    ocrDecision: string;
    reviewReason?: string;
    approvalSource: string;
    approvedAt?: Date;
    creditedAmount: string;
  },
  adminUserId?: number,
  /**
   * The slip version this OCR run actually processed, captured before it
   * started. `ocrData` was computed against that snapshot BEFORE this
   * transaction opened; if the customer published a replacement slip while
   * the run was still in flight, the reloaded row's slip identity no longer
   * matches it, and claiming/writing now would attribute the OLD slip's
   * evidence to a row that now displays a different one. Mirrors the
   * order-side SlipVersionChangedError check inside
   * lockAndRequireReviewablePayment.
   */
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ownerCandidate = (
    await db.select({ userId: walletTopups.userId }).from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1)
  )[0];
  if (!ownerCandidate) throw new Error("Wallet top-up not found");

  // REAL DATABASE TRANSACTION: All operations succeed or all rollback
  return await db.transaction(async (tx) => {
    // IPE-005 canonical lock hierarchy: Source user/merge guard first,
    // walletTopup subject second. OCR evidence/version checks remain under
    // the same subject row lock as before.
    await assertAccountMergeClassifiedMutationAllowed(ownerCandidate.userId, tx);
    // Step 0: LOCK the subject row BEFORE reading the version this run
    // validates against - same reasoning as approveWalletTopup's Step 0.
    //
    // Without this, the version check below reads an UNLOCKED row: a
    // concurrent publishWalletTopupReplacementIfReviewable can commit a
    // replacement to slip B in the window between that read and the
    // status-only CAS further down, which does not itself check slip
    // identity. Because a replacement re-opens status to "pending" without
    // changing it further, the status-only CAS would still match - claiming
    // and crediting slip A's evidence onto a row whose current slip is B,
    // leaving B completely unclaimed and reusable. Locking first serializes
    // this transaction against the replacement publisher, which also takes
    // this same lock (mirrors lockPaymentForUpdate on the order side).
    await lockWalletTopupForUpdate(topupId, tx);

    // Step 1: Fetch topup INSIDE transaction for consistency - now
    // guaranteed to be the current row, not a pre-lock snapshot.
    const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topupResult || topupResult.length === 0) {
      throw new Error("Wallet top-up not found");
    }
    const topup = topupResult[0];
    if (topup.userId !== ownerCandidate.userId) {
      throw new Error("Wallet top-up owner changed while OCR approval was waiting for account lock");
    }

    // Step 1a: SLIP-VERSION GATE - before any claim or write, and before the
    // status-only CAS below, since a replacement re-opens status to
    // "pending" and would otherwise pass that check while still describing
    // the slip it replaced.
    if (expectedSlipVersion) {
      const currentSlipImageUrl = topup.slipImageUrl as string | null;
      const currentSlipSubmittedAt = topup.slipSubmittedAt as Date | null;
      const versionMatches =
        currentSlipImageUrl === expectedSlipVersion.slipImageUrl &&
        (currentSlipSubmittedAt?.getTime() ?? null) ===
          (expectedSlipVersion.slipSubmittedAt?.getTime() ?? null);
      if (!versionMatches) {
        throw new WalletSlipClaimError(
          "TOPUP_SLIP_VERSION_CHANGED",
          "This top-up's slip was replaced while this OCR run was in flight. The " +
            "identifiers/extraction this run computed belong to a slip that is no longer " +
            "current, so nothing was claimed, approved or written."
        );
      }
    }

    // Step 1b: ANTI-REPLAY GATE.
    //
    // Claimed in THIS transaction, immediately before any wallet credit, so
    // one bank transaction can create value exactly once - across wallet
    // top-ups AND order payments AND users.
    //
    // This closes three concrete holes in the previous read-then-decide
    // duplicate check: it was scoped to a single userId (so another user
    // could replay the same slip), it scanned only PENDING order payments
    // (so an already-APPROVED slip was invisible), and being a plain SELECT
    // it could not stop two concurrent submissions from both passing.
    //
    // A slip with no strong identifier cannot be claimed, and therefore must
    // not auto-approve; it is routed to manual review instead. Rejection is
    // never performed here - only an admin may reject.
    if (ocrData.status === "approved") {
      const { identifiers, semanticFingerprint } = deriveStrongIdentifiersFromExtractedData(
        ocrData.extractedData
      );
      const autoRawReference = getRawReferenceForLegacyLookup(ocrData.extractedData);

      if (!hasStrongIdentifier(identifiers)) {
        throw new WalletSlipClaimError(
          "NO_STRONG_IDENTIFIER",
          "This slip has no readable transaction reference, so replay cannot be prevented automatically."
        );
      }

      const claim = await claimSlip(
        {
          sourceType: "wallet_topup",
          sourceId: topupId,
          userId: topup.userId,
          identifiers,
          semanticFingerprint,
          // Legacy lookup only - never used for the claim itself.
          referenceRawForLegacyLookup: autoRawReference,
        },
        tx
      );

      if (!claim.claimed) {
        // A legacy case ambiguity is NOT a duplicate verdict - the alias is
        // lossy. Auto-approval simply stops; no claim was inserted and no
        // value is created. A human decides via the resolution flow.
        if (claim.reason === "legacy_case_ambiguity") {
          throw new WalletSlipClaimError(
            "LEGACY_REFERENCE_CASE_AMBIGUITY",
            describeClaimFailure(claim)
          );
        }

        // An approved historical row exists that could not be verified - not
        // a proven duplicate, not provably clean. Auto-approval must not
        // guess either way; it stops and asks for manual review.
        if (claim.reason === "legacy_scan_unresolved") {
          throw new WalletSlipClaimError(
            "LEGACY_APPROVED_SLIP_UNRESOLVED",
            describeClaimFailure(claim)
          );
        }

        // MORE THAN ONE historical source shares this alias - never
        // resolvable by the single-member "confirm distinct" flow.
        if (claim.reason === "legacy_alias_group_ambiguity") {
          throw new WalletSlipClaimError(
            "LEGACY_ALIAS_GROUP_AMBIGUITY",
            describeClaimFailure(claim)
          );
        }

        // This top-up's own strong identifier durably matches a KNOWN
        // historical collision. No winner was ever picked, so nothing owns
        // it in the registry - auto-approval must still stop here.
        if (claim.reason === "known_collision") {
          throw new WalletSlipClaimError(
            "LEGACY_KNOWN_COLLISION",
            describeClaimFailure(claim)
          );
        }

        const ownedByThisTopup =
          claim.reason === "already_claimed" &&
          claim.existingSourceType === "wallet_topup" &&
          claim.existingSourceId === topupId;

        if (!ownedByThisTopup) {
          const code =
            claim.reason === "no_strong_identifier"
              ? "NO_STRONG_IDENTIFIER"
              : claim.reason === "already_claimed" && claim.conflictKind === "file"
                ? "DUPLICATE_FILE"
                : claim.reason === "already_claimed" && claim.conflictKind === "qr"
                  ? "DUPLICATE_QR"
                  : "DUPLICATE_REFERENCE";
          throw new WalletSlipClaimError(code, describeClaimFailure(claim));
        }
      }
    }

    // Step 2: Only proceed if status is pending or pending_review (idempotency)
    if (ocrData.status === "approved") {
      // For auto-approval: only update if still pending. The row lock above
      // already makes this safe on its own - nothing can change slip
      // identity while it is held - but the WHERE clause also re-binds the
      // expected slip version as defense-in-depth: this write must never
      // depend solely on a pre-lock read remaining correct.
      const approveConditions = [eq(walletTopups.id, topupId), eq(walletTopups.status, "pending" as any)];
      if (expectedSlipVersion) {
        approveConditions.push(
          expectedSlipVersion.slipImageUrl === null
            ? isNull(walletTopups.slipImageUrl)
            : eq(walletTopups.slipImageUrl, expectedSlipVersion.slipImageUrl)
        );
        approveConditions.push(
          expectedSlipVersion.slipSubmittedAt === null
            ? isNull(walletTopups.slipSubmittedAt)
            : eq(walletTopups.slipSubmittedAt, expectedSlipVersion.slipSubmittedAt)
        );
      }
      const updateResult = await tx
        .update(walletTopups)
        .set({
          status: "approved" as any,
          slipSubmittedAt: ocrData.slipSubmittedAt,
          extractedData: ocrData.extractedData,
          ocrConfidence: ocrData.ocrConfidence ? String(ocrData.ocrConfidence) : undefined,
          visionConfidence: ocrData.visionConfidence ? String(ocrData.visionConfidence) : undefined,
          structuredConfidence: ocrData.structuredConfidence ? String(ocrData.structuredConfidence) : undefined,
          finalConfidence: ocrData.finalConfidence ? String(ocrData.finalConfidence) : undefined,
          duplicateStatus: ocrData.duplicateStatus,
          ocrDecision: ocrData.ocrDecision as any,
          reviewReason: ocrData.reviewReason,
          approvalSource: ocrData.approvalSource as any,
          approvedAt: ocrData.approvedAt || new Date(),
          creditedAmount: ocrData.creditedAmount,
          reviewedByUserId: adminUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(...approveConditions));

      const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
      const affectedRows = (resultHeader as any)?.affectedRows || 0;
      if (affectedRows === 0) {
        // LOST THE STATE RACE - and this MUST throw, not return.
        //
        // The slip claim was already inserted above in this same transaction.
        // Returning normally here committed that claim while the conditional
        // update created no approval and no wallet credit, permanently
        // consuming the transaction reference and file hash for a top-up that
        // was never funded (e.g. an admin rejected it mid-flight).
        //
        // Invariant: A CLAIM MUST NEVER COMMIT WITHOUT THE VALUE CREATION IT
        // PROTECTS. Throwing rolls the claim back with everything else.
        throw new WalletSlipClaimError(
          "TOPUP_STATE_RACE",
          "This top-up is no longer pending - it was approved, rejected or cancelled while " +
            "OCR was running. No wallet credit was created and no slip claim was recorded."
        );
      }
    } else {
      // For pending_review: ONLY while the top-up is still reviewable.
      //
      // This previously updated regardless of current status, so an OCR pass
      // finishing after an admin approved or rejected the top-up moved a
      // FINAL record back to pending_review - and an already-credited top-up
      // could then be approved and credited a second time. A losing write is
      // a no-op: the persisted state is authoritative and is returned as-is.
      const reviewUpdate = await tx
        .update(walletTopups)
        .set({
          status: "pending_review" as any,
          slipSubmittedAt: ocrData.slipSubmittedAt,
          extractedData: ocrData.extractedData,
          ocrConfidence: ocrData.ocrConfidence ? String(ocrData.ocrConfidence) : undefined,
          visionConfidence: ocrData.visionConfidence ? String(ocrData.visionConfidence) : undefined,
          structuredConfidence: ocrData.structuredConfidence ? String(ocrData.structuredConfidence) : undefined,
          finalConfidence: ocrData.finalConfidence ? String(ocrData.finalConfidence) : undefined,
          duplicateStatus: ocrData.duplicateStatus,
          ocrDecision: ocrData.ocrDecision as any,
          reviewReason: ocrData.reviewReason,
          approvalSource: ocrData.approvalSource as any,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(walletTopups.id, topupId),
            or(
              eq(walletTopups.status, "pending" as any),
              eq(walletTopups.status, "pending_review" as any)
            )
          )
        );

      const reviewHeader = Array.isArray(reviewUpdate) ? reviewUpdate[0] : reviewUpdate;
      const reviewAffected = (reviewHeader as any)?.affectedRows || 0;
      if (reviewAffected === 0) {
        // Lost the race to a human decision. Nothing was mutated; surface the
        // finalized row rather than pretending this call set it.
        throw new WalletSlipClaimError(
          "TOPUP_STATE_RACE",
          "This top-up is no longer pending - it was approved, rejected or cancelled while " +
            "OCR was running. Nothing was changed."
        );
      }

      const updated = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
      return updated[0];
    }

    // Step 3: Credit wallet only if approved (not for pending_review)
    if (ocrData.status === "approved") {
      const creditAmount = ocrData.creditedAmount;
      
      // Get or create wallet account
      let account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
      if (!account || account.length === 0) {
        await tx.insert(walletAccounts).values({
          userId: topup.userId,
          balance: "0.00",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        account = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, topup.userId)).limit(1);
        if (!account || account.length === 0) {
          throw new Error("Failed to create wallet account");
        }
      }

      const currentBalance = parseFloat(account[0].balance);
      const creditAmountNum = parseFloat(creditAmount);
      const newBalance = (currentBalance + creditAmountNum).toFixed(2);

      // Update wallet balance
      await tx
        .update(walletAccounts)
        .set({ balance: newBalance, updatedAt: new Date() })
        .where(eq(walletAccounts.userId, topup.userId));

      // Create wallet transaction record
      await tx.insert(walletTransactions).values({
        userId: topup.userId,
        type: "topup_approved" as any,
        amount: creditAmount,
        balanceBefore: account[0].balance,
        balanceAfter: newBalance,
        referenceType: "wallet_topup",
        referenceId: topupId,
      });

      // Create topup log
      await tx.insert(topupLogs).values({
        userId: topup.userId,
        amount: topup.requestedAmount,
        bonus: topup.bonusAmount || "0.00",
        total: creditAmount,
        method: "slip" as any,
        reference: `topup-${topupId}`,
        note: `Slip approved by ${ocrData.approvalSource === "ocr_auto" ? "OCR" : "admin"}`,
        createdBy: adminUserId || 0,
        createdAt: new Date(),
      });
    }

    // Return updated topup
    const updated = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    return updated[0];
  });
}

// ============ ACCOUNT RECOVERY WORKFLOW ============
// Backs the post-VPS-migration admin account recovery feature - see
// server/services/accountRecoveryService.ts for the safety-assessment and
// transactional-approval logic these are composed into, and
// drizzle/schema.ts's accountRecoveryRequests/accountRecoveryAuditLogs doc
// comments for the schema rationale. Every function accepts an optional
// `tx` for the same in-flight-transaction composability reasons as the
// Google-identity helpers above.

export type AccountRecoveryEconomicDataFinding = {
  table: string;
  count: number;
};

/** One pending request per requester - the check createAccountRecoveryRequest's
 *  caller (accountRecoveryService.submitAccountRecoveryRequest) uses before
 *  inserting a new row. */
export async function getPendingAccountRecoveryRequestForUser(requesterUserId: number, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return undefined;
  const result = await db
    .select()
    .from(accountRecoveryRequests)
    .where(
      and(
        eq(accountRecoveryRequests.requesterUserId, requesterUserId),
        eq(accountRecoveryRequests.status, "pending" as any)
      )
    )
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createAccountRecoveryRequest(
  input: {
    requesterUserId: number;
    requestedLegacyUserId?: number | null;
    claimedLegacyEmail?: string | null;
    claimedLegacyOpenId?: string | null;
    claimedDisplayName?: string | null;
    evidenceNote?: string | null;
    referenceOrderNumber?: string | null;
  },
  tx?: any
) {
  const db = tx ?? (await getDb());
  if (!db) throw new Error("Database not available");

  const result = await db.insert(accountRecoveryRequests).values({
    requesterUserId: input.requesterUserId,
    requestedLegacyUserId: input.requestedLegacyUserId ?? null,
    claimedLegacyEmail: input.claimedLegacyEmail ?? null,
    claimedLegacyOpenId: input.claimedLegacyOpenId ?? null,
    claimedDisplayName: input.claimedDisplayName ?? null,
    evidenceNote: input.evidenceNote ?? null,
    referenceOrderNumber: input.referenceOrderNumber ?? null,
    status: "pending" as any,
  });

  // Extract insertId from Drizzle MySQL result (same extraction pattern as
  // createNovel/createEpisode elsewhere in this file).
  let insertedId: number | undefined;
  if (typeof result === "object" && result !== null) {
    insertedId = (result as any).insertId;
    if (!insertedId && Array.isArray(result) && result[0]) {
      insertedId = (result[0] as any).insertId;
    }
    if (!insertedId && (result as any).meta) {
      insertedId = (result as any).meta.insertId;
    }
  }
  if (!insertedId) {
    throw new Error("Failed to extract inserted account recovery request ID from database result");
  }

  const created = await db
    .select()
    .from(accountRecoveryRequests)
    .where(eq(accountRecoveryRequests.id, insertedId))
    .limit(1);
  return created[0];
}

export async function getAccountRecoveryRequestById(id: number, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return undefined;
  const result = await db.select().from(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/** Every request the given user has ever made, most recent first - backs
 *  /account/recovery's own status view. Never accepts anyone else's id from
 *  the client - the caller (accountRecovery.myRequests) always passes
 *  ctx.user.id. */
export async function listAccountRecoveryRequestsForUser(requesterUserId: number, tx?: any) {
  const db = tx ?? (await getDb());
  if (!db) return [];
  return db
    .select()
    .from(accountRecoveryRequests)
    .where(eq(accountRecoveryRequests.requesterUserId, requesterUserId))
    .orderBy(desc(accountRecoveryRequests.createdAt));
}

/** Paginated admin pending queue - anti-enumeration by construction (no
 *  free-text/user-supplied filter beyond page/pageSize; searching a
 *  SPECIFIC legacy account is a separate, exact-match-only lookup, never
 *  this list). */
export async function listPendingAccountRecoveryRequests(
  options: { page?: number; pageSize?: number } = {},
  tx?: any
) {
  const db = tx ?? (await getDb());
  if (!db) return { requests: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };

  const pageSize = Math.min(Math.max(options.pageSize || 20, 1), 100);
  const page = Math.max(1, options.page || 1);
  const offset = (page - 1) * pageSize;

  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(accountRecoveryRequests)
      .where(eq(accountRecoveryRequests.status, "pending" as any))
      .orderBy(asc(accountRecoveryRequests.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: count() })
      .from(accountRecoveryRequests)
      .where(eq(accountRecoveryRequests.status, "pending" as any)),
  ]);

  const total = totalResult[0]?.value ?? 0;
  return {
    requests: rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Conditional status transition - ONLY succeeds while the row is still in
 *  `fromStatuses`, exactly the same "conditional UPDATE, inspect
 *  affectedRows" concurrency-safety pattern as approveWalletTopup/
 *  rejectWalletTopup above. Returns true iff THIS call won the race; a
 *  caller seeing false must report a safe "already processed" outcome,
 *  never retry the same transition as if it were still pending. */
export async function transitionAccountRecoveryRequestStatus(
  params: {
    id: number;
    fromStatuses: Array<"pending">;
    toStatus: "approved" | "rejected" | "cancelled" | "blocked";
    reviewedByAdminId?: number | null;
    reviewReason?: string | null;
    sourceUserId?: number | null;
    targetUserId?: number | null;
  },
  tx: any
): Promise<boolean> {
  const statusConditions = params.fromStatuses.map((s) => eq(accountRecoveryRequests.status, s as any));
  const updateResult = await tx
    .update(accountRecoveryRequests)
    .set({
      status: params.toStatus as any,
      reviewedByAdminId: params.reviewedByAdminId ?? null,
      reviewedAt: new Date(),
      reviewReason: params.reviewReason ?? null,
      ...(params.sourceUserId !== undefined ? { sourceUserId: params.sourceUserId } : {}),
      ...(params.targetUserId !== undefined ? { targetUserId: params.targetUserId } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accountRecoveryRequests.id, params.id),
        statusConditions.length === 1 ? statusConditions[0] : or(...statusConditions)
      )
    );

  const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  const affectedRows = (resultHeader as any)?.affectedRows || 0;
  return affectedRows > 0;
}

export async function insertAccountRecoveryAuditLog(
  input: {
    recoveryRequestId: number;
    actorAdminId?: number | null;
    action: string;
    sourceUserId?: number | null;
    targetUserId?: number | null;
    authIdentityId?: number | null;
    safeMetadata?: Record<string, unknown> | null;
  },
  tx?: any
) {
  const db = tx ?? (await getDb());
  if (!db) throw new Error("Database not available");
  await db.insert(accountRecoveryAuditLogs).values({
    recoveryRequestId: input.recoveryRequestId,
    actorAdminId: input.actorAdminId ?? null,
    action: input.action,
    sourceUserId: input.sourceUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    authIdentityId: input.authIdentityId ?? null,
    safeMetadata: input.safeMetadata ? JSON.stringify(input.safeMetadata) : null,
  });
}

/** Moves ONE authIdentities row from its current owner to `targetUserId` -
 *  conditional on it STILL belonging to `expectedCurrentUserId` (re-checked
 *  inside the same transaction as every other recovery safety rule - see
 *  executeAccountRecovery), so a concurrent change between the assessment
 *  read and this write cannot silently move the wrong row. Never touches
 *  users.id or users.openId - only authIdentities.userId. Relies on the
 *  pre-existing UNIQUE(userId, provider) constraint as the final backstop
 *  against the target somehow already having a google identity by the time
 *  this runs. */
export async function moveAuthIdentityOwner(
  params: { authIdentityId: number; expectedCurrentUserId: number; targetUserId: number },
  tx: any
): Promise<boolean> {
  const updateResult = await tx
    .update(authIdentities)
    .set({ userId: params.targetUserId, updatedAt: new Date() })
    .where(and(eq(authIdentities.id, params.authIdentityId), eq(authIdentities.userId, params.expectedCurrentUserId)));

  const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  const affectedRows = (resultHeader as any)?.affectedRows || 0;
  return affectedRows > 0;
}

/**
 * Migration-safe compare-and-swap writers for server/services/
 * legacyManusAssetMigrationService.ts - same "conditional UPDATE, inspect
 * affectedRows" concurrency-safety pattern as moveAuthIdentityOwner/
 * transitionAccountRecoveryRequestStatus above, applied to a single legacy-
 * asset column instead of a status field. Each WHERE clause requires BOTH
 * the row id AND the column still holding the exact value the migration
 * read at candidate-discovery time - not just the id - so a row whose
 * source value changed (or was deleted) between discovery and this write
 * (e.g. the user re-submitted a new slip while a slow download/upload for
 * the OLD value was still in flight) is left completely untouched: the
 * UPDATE simply matches zero rows and this returns false. The caller
 * (legacyManusAssetMigrationService.ts) must treat false as "not migrated"
 * and never report success. Deliberately NOT reused for anything else -
 * these exist only for this one migration path, so their WHERE-clause
 * safety can never be silently loosened by an unrelated future caller
 * needing a plain unconditional update.
 */
export async function updatePaymentSlipUrlIfUnchanged(
  paymentId: number,
  expectedCurrentSlipImageUrl: string,
  newSlipImageUrl: string
): Promise<boolean> {
  return withAccountMergePaymentMutationGuard(paymentId, undefined, async (guardedDb) => {
    const updateResult = await guardedDb
      .update(payments)
      .set({ slipImageUrl: newSlipImageUrl })
      .where(and(eq(payments.id, paymentId), eq(payments.slipImageUrl, expectedCurrentSlipImageUrl)));

    const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    const affectedRows = (resultHeader as any)?.affectedRows || 0;
    return affectedRows === 1;
  });
}

export async function updateWalletTopupSlipUrlIfUnchanged(
  topupId: number,
  expectedCurrentSlipImageUrl: string,
  newSlipImageUrl: string
): Promise<boolean> {
  return withAccountMergeWalletTopupMutationGuard(topupId, undefined, async (guardedDb) => {
    const updateResult = await guardedDb
      .update(walletTopups)
      .set({ slipImageUrl: newSlipImageUrl })
      .where(and(eq(walletTopups.id, topupId), eq(walletTopups.slipImageUrl, expectedCurrentSlipImageUrl)));

    const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    const affectedRows = (resultHeader as any)?.affectedRows || 0;
    return affectedRows === 1;
  });
}

/** `column` selects exactly one of sportsMatches' three legacy-asset image
 *  columns - the CAS condition is on THAT SAME column, never a different
 *  one, so migrating `cover` can never be fooled by a concurrent change to
 *  `home`/`away` on the same row. */
export async function updateSportsMatchImageUrlIfUnchanged(
  matchId: number,
  column: "homeTeamImageUrl" | "awayTeamImageUrl" | "coverImageUrl",
  expectedCurrentValue: string,
  newValue: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const columnRef =
    column === "homeTeamImageUrl"
      ? sportsMatches.homeTeamImageUrl
      : column === "awayTeamImageUrl"
        ? sportsMatches.awayTeamImageUrl
        : sportsMatches.coverImageUrl;

  const updateResult = await db
    .update(sportsMatches)
    .set({ [column]: newValue } as any)
    .where(and(eq(sportsMatches.id, matchId), eq(columnRef, expectedCurrentValue)));

  const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  const affectedRows = (resultHeader as any)?.affectedRows || 0;
  return affectedRows === 1;
}

/** Finalizes the target account after a successful identity move -
 *  loginMethod becomes "google" unconditionally; email is backfilled ONLY
 *  when the target currently has none (never overwrites an existing
 *  address - rule 11). Never touches id/openId. */
export async function finalizeAccountRecoveryTargetUser(
  params: { targetUserId: number; fallbackEmail: string | null },
  tx: any
): Promise<void> {
  const target = await getUserById(params.targetUserId, tx);
  if (!target) throw new Error("[AccountRecovery] Target user disappeared mid-transaction");

  const updates: Record<string, unknown> = { loginMethod: "google", updatedAt: new Date() };
  if (!target.email && params.fallbackEmail) {
    updates.email = params.fallbackEmail;
  }
  await tx.update(users).set(updates).where(eq(users.id, params.targetUserId));
}

const ACCOUNT_RECOVERY_ECONOMIC_DATA_CHECKS: Array<{
  table: string;
  check: (userId: number, db: any) => Promise<number>;
}> = [
  { table: "orders", check: async (userId, db) => (await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, userId)).limit(1)).length },
  { table: "purchases", check: async (userId, db) => (await db.select({ id: purchases.id }).from(purchases).where(eq(purchases.userId, userId)).limit(1)).length },
  { table: "episodePurchases", check: async (userId, db) => (await db.select({ id: episodePurchases.id }).from(episodePurchases).where(eq(episodePurchases.userId, userId)).limit(1)).length },
  { table: "walletAccounts", check: async (userId, db) => (await db.select({ id: walletAccounts.id }).from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1)).length },
  { table: "walletTransactions", check: async (userId, db) => (await db.select({ id: walletTransactions.id }).from(walletTransactions).where(eq(walletTransactions.userId, userId)).limit(1)).length },
  { table: "walletTopups", check: async (userId, db) => (await db.select({ id: walletTopups.id }).from(walletTopups).where(eq(walletTopups.userId, userId)).limit(1)).length },
  { table: "pointsTransactions", check: async (userId, db) => (await db.select({ id: pointsTransactions.id }).from(pointsTransactions).where(eq(pointsTransactions.userId, userId)).limit(1)).length },
  { table: "couponUsages", check: async (userId, db) => (await db.select({ id: couponUsagesTable.id }).from(couponUsagesTable).where(eq(couponUsagesTable.userId, userId)).limit(1)).length },
  { table: "sportsMatchVotes", check: async (userId, db) => (await db.select({ id: sportsMatchVotes.id }).from(sportsMatchVotes).where(eq(sportsMatchVotes.userId, userId)).limit(1)).length },
  { table: "sportsMatchRewards", check: async (userId, db) => (await db.select({ id: sportsMatchRewards.id }).from(sportsMatchRewards).where(eq(sportsMatchRewards.userId, userId)).limit(1)).length },
  { table: "dailyCheckinRewardGrants", check: async (userId, db) => (await db.select({ id: dailyCheckinRewardGrants.id }).from(dailyCheckinRewardGrants).where(eq(dailyCheckinRewardGrants.userId, userId)).limit(1)).length },
  { table: "topupLogs", check: async (userId, db) => (await db.select({ id: topupLogs.id }).from(topupLogs).where(eq(topupLogs.userId, userId)).limit(1)).length },
  // A personal coupon (scope="user") is itself an unredeemed financial
  // right, distinct from couponUsages (a coupon already spent on an
  // order) - gap found and closed by the exhaustive user-data audit (see
  // server/services/accountRecoveryDataClassification.ts).
  { table: "coupons", check: async (userId, db) => (await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.ownerUserId, userId)).limit(1)).length },
];

/** Category A ("Economic/Entitlement data") from the recovery-safety spec -
 *  wallet/balance/points, purchases, orders, payments (via orders),
 *  transactions, purchased episodes, coupons/financial rights (including
 *  an unredeemed personal coupon via coupons.ownerUserId). ANY hit here
 *  means the source account can never be auto-recovered - see
 *  accountRecoveryService.assessAccountRecoverySafety, which turns a
 *  non-empty result into a hard BLOCK, never overridable by an admin - the
 *  SAME no-override treatment Category B (findAccountRecoveryUserOwnedData
 *  below) now also gets under the empty-source-account invariant. See
 *  server/services/accountRecoveryDataClassification.ts for the
 *  exhaustive, test-verified inventory this check list is derived from.
 *  Runs each check independently rather than one big UNION query so a
 *  single slow/locked table never masks the others, and so the returned
 *  finding list stays precise for the admin UI. */
export async function findAccountRecoveryEconomicData(
  userId: number,
  tx?: any
): Promise<AccountRecoveryEconomicDataFinding[]> {
  const db = tx ?? (await getDb());
  if (!db) return [];
  const findings: AccountRecoveryEconomicDataFinding[] = [];
  for (const { table, check } of ACCOUNT_RECOVERY_ECONOMIC_DATA_CHECKS) {
    const hitCount = await check(userId, db);
    if (hitCount > 0) findings.push({ table, count: hitCount });
  }
  return findings;
}

const ACCOUNT_RECOVERY_USER_OWNED_DATA_CHECKS: Array<{
  table: string;
  check: (userId: number, db: any) => Promise<number>;
}> = [
  { table: "carts", check: async (userId, db) => (await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, userId)).limit(1)).length },
  { table: "wishlists", check: async (userId, db) => (await db.select({ id: wishlists.id }).from(wishlists).where(eq(wishlists.userId, userId)).limit(1)).length },
  { table: "readingProgress", check: async (userId, db) => (await db.select({ id: readingProgress.id }).from(readingProgress).where(eq(readingProgress.userId, userId)).limit(1)).length },
  { table: "dailyCheckins", check: async (userId, db) => (await db.select({ id: dailyCheckins.id }).from(dailyCheckins).where(eq(dailyCheckins.userId, userId)).limit(1)).length },
];

/** Category B ("User-owned data") from the recovery-safety spec - cart,
 *  library/wishlist, reading progress, check-ins, and other recovery
 *  requests by the same user. As of the empty-source-account invariant,
 *  ANY hit here is ALSO an unconditional, no-admin-override block -
 *  identical in effect to Category A above (see
 *  accountRecoveryService.assessAccountRecoverySafety). This tool never
 *  moves, merges, or deletes this data, and never deletes the source
 *  user - automated recovery is only permitted when the source account is
 *  genuinely, completely empty; anything else routes to "blocked"
 *  (Advanced Account Merge, handled outside this tool). See
 *  server/services/accountRecoveryDataClassification.ts for the
 *  exhaustive, test-verified inventory this check list is derived from.
 *  `excludeRequestId` leaves the CURRENT request itself out of the "other
 *  recovery requests" count. */
/** Purely for cross-verification by
 *  server/services/accountRecoveryDataClassification.test.ts - the actual
 *  table names findAccountRecoveryEconomicData queries, kept in one place
 *  so the static-safety test can assert they match
 *  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION's economic_hard_block
 *  entries exactly, with no manual re-typing (and thus no drift risk). */
export const ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES: string[] = ACCOUNT_RECOVERY_ECONOMIC_DATA_CHECKS.map(
  (c) => c.table
);

/** Same purpose as ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES, for
 *  findAccountRecoveryUserOwnedData/user_owned_hard_block. */
export const ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES: string[] = ACCOUNT_RECOVERY_USER_OWNED_DATA_CHECKS.map(
  (c) => c.table
);

export async function findAccountRecoveryUserOwnedData(
  userId: number,
  excludeRequestId: number,
  tx?: any
): Promise<AccountRecoveryEconomicDataFinding[]> {
  const db = tx ?? (await getDb());
  if (!db) return [];
  const findings: AccountRecoveryEconomicDataFinding[] = [];
  for (const { table, check } of ACCOUNT_RECOVERY_USER_OWNED_DATA_CHECKS) {
    const hitCount = await check(userId, db);
    if (hitCount > 0) findings.push({ table, count: hitCount });
  }

  const otherRequests = await db
    .select({ id: accountRecoveryRequests.id })
    .from(accountRecoveryRequests)
    .where(buildOtherBlockingAccountRecoveryRequestsCondition(userId, excludeRequestId))
    .limit(1);
  if (otherRequests.length > 0) findings.push({ table: "accountRecoveryRequests", count: otherRequests.length });

  return findings;
}

/**
 * The "does this requester have another request that must still block
 * approval" condition used by findAccountRecoveryUserOwnedData above -
 * pulled into its own exported, pure function so its exact generated SQL
 * shape can be unit-tested directly via a connection-free `.toSQL()` render
 * (see server/findAccountRecoveryUserOwnedData.test.ts, same pattern as
 * server/services/hybridHealthQueries.ts's buildEpisodeLevelPredicate/
 * buildCandidateWhereClause), without needing a live database.
 *
 * Only an OTHER request still in "pending" or "approved" blocks - a
 * terminal-but-unsuccessful outcome (rejected/cancelled/blocked) is a
 * resolved history record, not user-owned data or an entitlement left
 * behind, and must never permanently prevent a legitimate resubmission
 * (see client/src/pages/AccountRecoveryPage.tsx's own resubmit flow, which
 * re-enables the form after exactly these terminal-unsuccessful statuses -
 * previously, ANY other request row of any status blocked forever, which
 * is exactly the bug this function's status filter fixes). "pending" is
 * fail-closed defense-in-depth on top of the one-pending-per-requester DB
 * constraint (accountRecoveryRequests' generated-column unique index),
 * never relied on as the only guard. "approved" is fail-closed because it
 * means this source account's identity already moved once before - that
 * requires Advanced Account Merge review, never a second automated move.
 */
type AccountRecoveryRequestStatus = (typeof accountRecoveryRequests.$inferSelect)["status"];

/** The only two statuses buildOtherBlockingAccountRecoveryRequestsCondition
 *  treats as still blocking - see that function's own docstring for why.
 *  Typed directly off the schema's own inferred `status` column (never a
 *  hand-written union) so a typo or a status renamed/removed in
 *  drizzle/schema.ts fails to compile here instead of silently matching
 *  nothing (or, worse, everything). */
const BLOCKING_ACCOUNT_RECOVERY_REQUEST_STATUSES: AccountRecoveryRequestStatus[] = ["pending", "approved"];

export function buildOtherBlockingAccountRecoveryRequestsCondition(userId: number, excludeRequestId: number) {
  return and(
    eq(accountRecoveryRequests.requesterUserId, userId),
    ne(accountRecoveryRequests.id, excludeRequestId),
    inArray(accountRecoveryRequests.status, BLOCKING_ACCOUNT_RECOVERY_REQUEST_STATUSES)
  );
}

// ============ ADVANCED ACCOUNT MERGE - GUARD & CONCURRENCY (IPE-005) ============

export const ACCOUNT_MERGE_GUARDED_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
export type AccountMergeGuardedStatus = (typeof ACCOUNT_MERGE_GUARDED_STATUSES)[number];

/**
 * Stable server-side refusal for a classified Source-account write while an
 * account merge guard is durable. Client routes may map this to their own
 * generic error message; the important contract is that the mutation throws
 * before any classified write in the surrounding transaction can commit.
 */
export class AccountMergeWriteGuardError extends Error {
  readonly code = "ACCOUNT_MERGE_SOURCE_GUARDED";
  constructor(
    readonly sourceUserId: number,
    readonly mergeCaseId: number,
    readonly mergeStatus: AccountMergeGuardedStatus
  ) {
    super(`Classified account mutation refused while merge case ${mergeCaseId} is ${mergeStatus}`);
    this.name = "AccountMergeWriteGuardError";
  }
}

function unwrapMysqlRows(rawResult: any): any[] {
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Canonical account-merge user lock hierarchy. Every multi-account merge
 * lifecycle operation and every multi-user classified mutation must acquire
 * `users` rows in ascending id order before touching merge-case rows or any
 * classified table. That one ordering rule prevents the source/target and
 * multi-reward deadlock shapes from acquiring the same two users in opposite
 * order.
 */
export async function lockAccountMergeUserRows(userIds: number[], tx: any): Promise<number[]> {
  const ordered = Array.from(new Set(userIds)).sort((a, b) => a - b);
  if (ordered.length === 0) throw new Error("At least one user id is required for account-merge locking");

  for (const userId of ordered) {
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user id for account-merge locking");
    const rows = unwrapMysqlRows(
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`)
    );
    if (rows.length !== 1) throw new Error(`User ${userId} not found while acquiring account-merge lock`);
  }

  return ordered;
}

/**
 * Locking read of every merge case for one Source. This MUST be a FOR UPDATE
 * read rather than a plain ORM SELECT: after waiting behind another holder of
 * the Source users-row lock, TiDB/MySQL-compatible snapshot semantics can
 * otherwise return a transaction-start snapshot that predates the case that
 * just activated. The locking read guarantees the mutation decides from the
 * latest committed guard state.
 */
export async function getAccountMergeCasesForSourceForUpdate(sourceUserId: number, tx: any) {
  return unwrapMysqlRows(
    await tx.execute(
      sql`SELECT id, sourceUserId, targetUserId, status, originAccountRecoveryRequestId, createdByAdminId, startedAt, completedAt, failedAt, cancelledAt FROM accountMergeCases WHERE sourceUserId = ${sourceUserId} ORDER BY id FOR UPDATE`
    )
  );
}

/**
 * Shared correctness gate for all classified Source-account mutations.
 * Locks every involved user first, then reads merge guards under lock. A
 * mutation that got the user lock BEFORE prepare is therefore guaranteed to
 * commit before prepare can activate its guard/snapshot; a mutation arriving
 * AFTER activation waits, then sees the durable guard and fails before its
 * transaction can commit. `cancelled` is the only released state; unknown or
 * duplicate non-cancelled state fails closed.
 */
export async function assertAccountMergeClassifiedMutationsAllowed(userIds: number[], tx: any): Promise<void> {
  const ordered = await lockAccountMergeUserRows(userIds, tx);
  const guardedStatuses = new Set<string>(ACCOUNT_MERGE_GUARDED_STATUSES);

  for (const sourceUserId of ordered) {
    const cases = await getAccountMergeCasesForSourceForUpdate(sourceUserId, tx);
    const nonCancelled = cases.filter((row: any) => row.status !== "cancelled");
    if (nonCancelled.length > 1) {
      throw new Error(`Inconsistent account-merge guard state for source ${sourceUserId}`);
    }
    const active = nonCancelled[0];
    if (!active) continue;
    if (!guardedStatuses.has(active.status)) {
      throw new Error(`Unknown account-merge guard state '${String(active.status)}' for source ${sourceUserId}`);
    }
    throw new AccountMergeWriteGuardError(sourceUserId, Number(active.id), active.status as AccountMergeGuardedStatus);
  }
}

export async function assertAccountMergeClassifiedMutationAllowed(userId: number, tx: any): Promise<void> {
  return assertAccountMergeClassifiedMutationsAllowed([userId], tx);
}

/**
 * Transaction wrapper for a classified mutation entry point. Existing callers
 * that already own a transaction keep that transaction; stand-alone mutation
 * helpers get a short transaction whose lifetime exactly matches the guard
 * lock plus the write.
 */
export async function withAccountMergeClassifiedMutationGuard<T>(
  userId: number,
  tx: any | undefined,
  fn: (guardedTx: any) => Promise<T>
): Promise<T> {
  if (tx) {
    await assertAccountMergeClassifiedMutationAllowed(userId, tx);
    return fn(tx);
  }
  const database = await getDb();
  if (!database) throw new Error("Database not available");
  return database.transaction(async (newTx: any) => {
    await assertAccountMergeClassifiedMutationAllowed(userId, newTx);
    return fn(newTx);
  });
}

async function withAccountMergeOwnedSubjectGuard<T>(
  subjectType: "order" | "payment" | "wallet_topup",
  subjectId: number,
  tx: any | undefined,
  fn: (guardedTx: any, ownerUserId: number) => Promise<T>
): Promise<T> {
  const database = tx || (await getDb());
  if (!database) throw new Error("Database not available");

  const resolveOwner = async (readDb: any): Promise<number | undefined> => {
    if (subjectType === "order") {
      const rows = await readDb.select({ userId: orders.userId }).from(orders).where(eq(orders.id, subjectId)).limit(1);
      return rows[0]?.userId ?? undefined;
    }
    if (subjectType === "wallet_topup") {
      const rows = await readDb.select({ userId: walletTopups.userId }).from(walletTopups).where(eq(walletTopups.id, subjectId)).limit(1);
      return rows[0]?.userId ?? undefined;
    }
    const paymentRows = await readDb
      .select({ orderId: payments.orderId })
      .from(payments)
      .where(eq(payments.id, subjectId))
      .limit(1);
    const orderId = paymentRows[0]?.orderId;
    if (!orderId) return undefined;
    const orderRows = await readDb
      .select({ userId: orders.userId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    return orderRows[0]?.userId ?? undefined;
  };

  const run = async (guardedTx: any): Promise<T> => {
    const ownerCandidate = await resolveOwner(guardedTx);
    if (!ownerCandidate) throw new Error(`${subjectType} ${subjectId} owner not found`);
    await assertAccountMergeClassifiedMutationAllowed(ownerCandidate, guardedTx);

    // Lock the subject only AFTER Source users/merge guard. Keep the lock
    // query concerned only with subject existence; ownership is re-resolved
    // immediately afterwards from the locked/current relationship. This is
    // both simpler than a locking join and preserves compatibility with the
    // repo's existing transaction test doubles, which intentionally model
    // FOR UPDATE rows as `{ id }` only.
    if (subjectType === "order") {
      const lockedRows = unwrapMysqlRows(
        await guardedTx.execute(sql`SELECT id FROM orders WHERE id = ${subjectId} FOR UPDATE`)
      );
      if (lockedRows.length !== 1) throw new Error(`order ${subjectId} not found while acquiring account lock`);
    } else if (subjectType === "wallet_topup") {
      const locked = await lockWalletTopupForUpdate(subjectId, guardedTx);
      if (!locked) throw new Error(`wallet_topup ${subjectId} not found while acquiring account lock`);
    } else {
      const locked = await lockPaymentForUpdate(subjectId, guardedTx);
      if (!locked) throw new Error(`payment ${subjectId} not found while acquiring account lock`);
    }

    const lockedOwner = await resolveOwner(guardedTx);
    if (lockedOwner !== ownerCandidate) {
      throw new Error(`${subjectType} ${subjectId} owner changed while waiting for account lock`);
    }
    return fn(guardedTx, ownerCandidate);
  };

  if (tx) return run(tx);
  return database.transaction(run);
}

export function withAccountMergeOrderMutationGuard<T>(orderId: number, tx: any | undefined, fn: (guardedTx: any, ownerUserId: number) => Promise<T>) {
  return withAccountMergeOwnedSubjectGuard("order", orderId, tx, fn);
}

export function withAccountMergePaymentMutationGuard<T>(paymentId: number, tx: any | undefined, fn: (guardedTx: any, ownerUserId: number) => Promise<T>) {
  return withAccountMergeOwnedSubjectGuard("payment", paymentId, tx, fn);
}

export function withAccountMergeWalletTopupMutationGuard<T>(topupId: number, tx: any | undefined, fn: (guardedTx: any, ownerUserId: number) => Promise<T>) {
  return withAccountMergeOwnedSubjectGuard("wallet_topup", topupId, tx, fn);
}

// ============ ADVANCED ACCOUNT MERGE - FOUNDATION & PREVIEW (IPE-003) ============
// Backs the read-only merge preview - see
// server/services/accountMergePreviewService.ts for the orchestration these
// compose into, and server/services/accountMergeTypes.ts for the returned
// shapes. EVERY function in this section is READ-ONLY: no INSERT/UPDATE/
// DELETE appears anywhere below - see accountMergePreviewService.ts's own
// docstring for why that is exhaustively true, not merely a convention.

export type AccountMergeTableInventoryFinding = {
  table: string;
  category: "economic" | "user_owned" | "indirect_economic" | "indirect_user_owned";
  sourceCount: number;
  targetCount: number;
  conflictCount: number;
};

/** Exact row count for one userId-column table. Unlike Account Recovery's
 *  own presence-only `.limit(1)` checks (findAccountRecoveryEconomicData/
 *  findAccountRecoveryUserOwnedData above), the merge preview needs the
 *  REAL count for the admin to judge scale before a later phase acts on
 *  it, so every check below is a genuine `count()` aggregate. */
function plainUserIdCount(table: any, userIdColumn: any) {
  return async (userId: number, database: any): Promise<number> => {
    const rows = await database.select({ value: count() }).from(table).where(eq(userIdColumn, userId));
    return Number(rows[0]?.value ?? 0);
  };
}

/** Same shape, for the no-direct-userId-column indirect tables - counted
 *  via a join back to the parent's own already-classified userId column
 *  (cartItems -> carts.userId; orderItems/payments/orderHistory ->
 *  orders.userId - see ACCOUNT_RECOVERY_INDIRECT_TABLES's own doc comment
 *  for why these tables have no direct column to reflect over, and
 *  accountMergeInventory.ts's ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES for
 *  the payment/top-up-descendant tables deliberately left out). */
function joinedParentUserIdCount(
  childTable: any,
  childParentIdColumn: any,
  parentTable: any,
  parentIdColumn: any,
  parentUserIdColumn: any
) {
  return async (userId: number, database: any): Promise<number> => {
    const rows = await database
      .select({ value: count() })
      .from(childTable)
      .innerJoin(parentTable, eq(childParentIdColumn, parentIdColumn))
      .where(eq(parentUserIdColumn, userId));
    return Number(rows[0]?.value ?? 0);
  };
}

/**
 * Renders the "how many of source's rows share a per-account unique key
 * with one of target's rows" query for one table - a plain re-parent of
 * exactly these rows would violate that table's own UNIQUE(userId, ...)
 * constraint (e.g. wishlists' unique_user_novel, purchases'
 * unique_user_episode). Exported (not just a local closure) purely so
 * server/accountMergeKeyOverlap.static.test.ts can assert the generated
 * SQL shape with a connection-free `.toSQL()`-style dialect render - the
 * same pattern already used by
 * buildOtherBlockingAccountRecoveryRequestsCondition above.
 *
 * `table`/`userIdColumn`/`keyColumns` are ALWAYS literal string constants
 * from ACCOUNT_MERGE_TABLE_CHECKS below - never derived from request
 * input - so embedding them as SQL identifiers (via `sql.identifier`,
 * which quotes and escapes them) rather than bound parameters (which
 * MySQL/TiDB cannot accept identifiers as at all) carries no injection
 * risk. `sourceUserId`/`targetUserId` remain real bound parameters.
 */
export function buildAccountMergeKeyOverlapQuery(
  table: string,
  userIdColumn: string,
  keyColumns: string[],
  sourceUserId: number,
  targetUserId: number
) {
  const tableIdent = sql.identifier(table);
  const userIdIdent = sql.identifier(userIdColumn);
  const keyEquality = sql.join(
    keyColumns.map((c) => sql`s.${sql.identifier(c)} = t.${sql.identifier(c)}`),
    sql` AND `
  );
  return sql`SELECT COUNT(*) AS cnt FROM ${tableIdent} s WHERE s.${userIdIdent} = ${sourceUserId} AND EXISTS (SELECT 1 FROM ${tableIdent} t WHERE t.${userIdIdent} = ${targetUserId} AND ${keyEquality})`;
}

async function countAccountMergeKeyOverlap(
  database: any,
  table: string,
  userIdColumn: string,
  keyColumns: string[],
  sourceUserId: number,
  targetUserId: number
): Promise<number> {
  const raw: any = await database.execute(
    buildAccountMergeKeyOverlapQuery(table, userIdColumn, keyColumns, sourceUserId, targetUserId)
  );
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Number(rows?.[0]?.cnt ?? 0);
}

type AccountMergeTableCheck = {
  table: string;
  category: AccountMergeTableInventoryFinding["category"];
  countFor: (userId: number, database: any) => Promise<number>;
  /** The column countFor/the overlap query key off - always the SAME
   *  column classified for this table in
   *  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION (coupons is the one direct
   *  table using `ownerUserId` instead of `userId`). */
  userIdColumnName: string;
  /** Present only for a table with a real UNIQUE(userId, <content>)
   *  constraint - the columns forming <content>. Omitted entirely for an
   *  append-only ledger table with no such constraint (conflictCount is
   *  always 0 for those) and for the indirect (no-direct-column) tables,
   *  where per-row dedupe is deferred to the phase that actually
   *  implements cart/order consolidation - see this file's own inventory
   *  orchestrator below for how each shape is handled. */
  conflictKeyColumns?: string[];
  /** true only for a table with UNIQUE(userId) (at most one row per
   *  account) - conflictCount there comes from "both sides already have
   *  their one row" (sourceCount>0 && targetCount>0), never an extra
   *  query. */
  isSingleton?: boolean;
};

/**
 * The merge inventory's real query registry. Table NAMES here must match
 * accountMergeInventory.ts's ACCOUNT_MERGE_DIRECT_TABLES/
 * ACCOUNT_MERGE_INDIRECT_TABLES exactly (as a set) - proven by
 * server/services/accountMergeInventory.test.ts, the same
 * "no drift between the inventory and the real queries" pattern as
 * ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES/ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES
 * above.
 */
const ACCOUNT_MERGE_TABLE_CHECKS: AccountMergeTableCheck[] = [
  // ---- economic (direct) ----
  { table: "orders", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(orders, orders.userId) },
  {
    table: "purchases",
    category: "economic",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(purchases, purchases.userId),
    conflictKeyColumns: ["episodeId"],
  },
  {
    table: "episodePurchases",
    category: "economic",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(episodePurchases, episodePurchases.userId),
    conflictKeyColumns: ["episodeId"],
  },
  {
    table: "walletAccounts",
    category: "economic",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(walletAccounts, walletAccounts.userId),
    isSingleton: true,
  },
  { table: "walletTransactions", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(walletTransactions, walletTransactions.userId) },
  { table: "walletTopups", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(walletTopups, walletTopups.userId) },
  { table: "topupLogs", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(topupLogs, topupLogs.userId) },
  { table: "pointsTransactions", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(pointsTransactions, pointsTransactions.userId) },
  { table: "couponUsages", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(couponUsagesTable, couponUsagesTable.userId) },
  {
    table: "coupons",
    category: "economic",
    userIdColumnName: "ownerUserId",
    countFor: plainUserIdCount(coupons, coupons.ownerUserId),
  },
  {
    table: "sportsMatchVotes",
    category: "economic",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(sportsMatchVotes, sportsMatchVotes.userId),
    conflictKeyColumns: ["matchId"],
  },
  { table: "sportsMatchRewards", category: "economic", userIdColumnName: "userId", countFor: plainUserIdCount(sportsMatchRewards, sportsMatchRewards.userId) },
  {
    table: "dailyCheckinRewardGrants",
    category: "economic",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(dailyCheckinRewardGrants, dailyCheckinRewardGrants.userId),
    conflictKeyColumns: ["ruleId", "milestoneInstanceNumber"],
  },

  // ---- user_owned (direct) ----
  {
    table: "carts",
    category: "user_owned",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(carts, carts.userId),
    isSingleton: true,
  },
  {
    table: "wishlists",
    category: "user_owned",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(wishlists, wishlists.userId),
    conflictKeyColumns: ["novelId"],
  },
  {
    table: "readingProgress",
    category: "user_owned",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(readingProgress, readingProgress.userId),
    conflictKeyColumns: ["episodeId"],
  },
  {
    table: "dailyCheckins",
    category: "user_owned",
    userIdColumnName: "userId",
    countFor: plainUserIdCount(dailyCheckins, dailyCheckins.userId),
    conflictKeyColumns: ["checkinDate", "campaignKey"],
  },

  // ---- indirect (no direct userId column - counted via a join to the
  // already-classified parent column; per-row dedupe within them is
  // deferred to whichever later phase actually implements cart/order
  // consolidation, not guessed at here - conflictCount stays 0). ----
  {
    table: "cartItems",
    category: "indirect_user_owned",
    userIdColumnName: "userId",
    countFor: joinedParentUserIdCount(cartItems, cartItems.cartId, carts, carts.id, carts.userId),
  },
  {
    table: "orderItems",
    category: "indirect_economic",
    userIdColumnName: "userId",
    countFor: joinedParentUserIdCount(orderItems, orderItems.orderId, orders, orders.id, orders.userId),
  },
  {
    table: "payments",
    category: "indirect_economic",
    userIdColumnName: "userId",
    countFor: joinedParentUserIdCount(payments, payments.orderId, orders, orders.id, orders.userId),
  },
  {
    // The status-transition audit trail of the source account's own orders.
    // No direct userId column - every row is owned transitively via
    // orderId -> orders.userId, exactly like orderItems above. Its
    // orderHistory.actorUserId column records WHO made a transition (often
    // an admin/system actor) and is classified deliberately_ignored, which
    // is why a naive "is this table already classified?" scan treated
    // orderHistory as covered when it was not - the ROW's ownership runs
    // through its order, not through the actor column.
    table: "orderHistory",
    category: "indirect_economic",
    userIdColumnName: "userId",
    countFor: joinedParentUserIdCount(orderHistory, orderHistory.orderId, orders, orders.id, orders.userId),
  },
];

/** Table names this registry actually queries - cross-checked against
 *  accountMergeInventory.ts's derived lists by
 *  server/services/accountMergeInventory.test.ts. */
export const ACCOUNT_MERGE_TABLE_NAMES: string[] = ACCOUNT_MERGE_TABLE_CHECKS.map((c) => c.table);

/**
 * Every classified direct/indirect table's exact source and target counts,
 * plus a conflictCount wherever this table's own UNIQUE constraint means a
 * plain re-parent of overlapping rows would fail (see
 * AccountMergeTableCheck's own doc comments for the two shapes:
 * `isSingleton` and `conflictKeyColumns`). Purely read-only; runs every
 * check independently (never one giant UNION) so one slow/locked table
 * never masks the others, matching getAdminUserDeleteAssessment's own
 * established pattern above.
 *
 * The overlap query only ever runs when BOTH sides are non-empty - if
 * either side has zero rows, no overlap is possible and the extra query
 * would only ever return 0.
 */
export async function findAccountMergeTableInventory(
  sourceUserId: number,
  targetUserId: number,
  tx?: any
): Promise<AccountMergeTableInventoryFinding[]> {
  const database = tx ?? (await getDb());
  if (!database) return [];

  const findings: AccountMergeTableInventoryFinding[] = [];
  for (const check of ACCOUNT_MERGE_TABLE_CHECKS) {
    const [sourceCount, targetCount] = await Promise.all([
      check.countFor(sourceUserId, database),
      check.countFor(targetUserId, database),
    ]);

    let conflictCount = 0;
    if (check.isSingleton) {
      conflictCount = sourceCount > 0 && targetCount > 0 ? 1 : 0;
    } else if (check.conflictKeyColumns && sourceCount > 0 && targetCount > 0) {
      conflictCount = await countAccountMergeKeyOverlap(
        database,
        check.table,
        check.userIdColumnName,
        check.conflictKeyColumns,
        sourceUserId,
        targetUserId
      );
    }

    findings.push({ table: check.table, category: check.category, sourceCount, targetCount, conflictCount });
  }
  return findings;
}

/** Current wallet balance for one user - "0.00" (never null/undefined)
 *  when the user has no walletAccounts row yet, so callers can always
 *  safely formatMoney/moneyAdd the result without a separate null check.
 *  Read straight off the walletAccounts row - never recomputed/summed from
 *  walletTransactions (that ledger is Category-A evidence for the
 *  inventory above, not itself the source of truth for the CURRENT
 *  balance - see approveWalletTopup's own identical convention). */
export async function getAccountMergeWalletBalance(userId: number, tx?: any): Promise<string> {
  const database = tx ?? (await getDb());
  if (!database) return "0.00";
  const rows = await database
    .select({ balance: walletAccounts.balance })
    .from(walletAccounts)
    .where(eq(walletAccounts.userId, userId))
    .limit(1);
  return rows[0]?.balance ?? "0.00";
}

/** Current points balance for one user - the most recent
 *  pointsTransactions.balanceAfter (the ledger's own running total, the
 *  same source of truth every points-spending code path already reads),
 *  "0.00" when the user has never had a points transaction.
 *
 *  Delegates verbatim to the canonical getUserPointsBalance so the merge
 *  preview projects EXACTLY the balance production shows: the latest row by
 *  `(createdAt DESC, id DESC)`, never by `id` alone. pointsTransactions
 *  .createdAt is a second-precision MySQL timestamp, and an imported or
 *  backfilled ledger can carry rows whose `id` order does not match their
 *  chronological order - ordering on `id` alone would then read a stale
 *  balanceAfter and mis-project both the per-account balance and the merged
 *  total. The `id DESC` tiebreaker still disambiguates same-second rows.
 *  See getUserPointsBalance's own doc comment for the full rationale. */
export async function getAccountMergePointsBalance(userId: number, tx?: any): Promise<string> {
  return getUserPointsBalance(userId, tx);
}

/** Read-only count of paymentSlipClaims rows owned by the source account -
 *  see accountRecoveryDataClassification.ts's paymentSlipClaims.userId
 *  entry for why this registry is never itself moved/merged/deleted by any
 *  account workflow: doing so would reopen every slip the source ever used
 *  for anti-replay. This function only ever SELECTs - proof (together with
 *  every other function in this section) that the merge preview is
 *  read-only with respect to paymentSlipClaims/OCR anti-replay evidence. */
export async function getAccountMergePaymentSlipClaimsCount(userId: number, tx?: any): Promise<number> {
  const database = tx ?? (await getDb());
  if (!database) return 0;
  const rows = await database.select({ value: count() }).from(paymentSlipClaims).where(eq(paymentSlipClaims.userId, userId));
  return Number(rows[0]?.value ?? 0);
}

/**
 * Minimal stale-session lookup for IPE-008. A completed merge deliberately
 * keeps the Source users row/openId so historical references remain valid,
 * which means an already-issued Source JWT can still authenticate. This read
 * lets the server distinguish that retained historical account from an active
 * account without exposing Target identity details to the client.
 */
export async function getCompletedAccountMergeForSource(userId: number, tx?: any) {
  const database = tx ?? (await getDb());
  if (!database) return undefined;
  const rows = await database
    .select({
      id: accountMergeCases.id,
      sourceUserId: accountMergeCases.sourceUserId,
      targetUserId: accountMergeCases.targetUserId,
      completedAt: accountMergeCases.completedAt,
    })
    .from(accountMergeCases)
    .where(and(eq(accountMergeCases.sourceUserId, userId), eq(accountMergeCases.status, "completed")))
    .orderBy(desc(accountMergeCases.id))
    .limit(1);
  return rows[0];
}

// ============ ADMIN USERS MANAGEMENT ============
// Backs the Admin Users Management page (client/src/pages/AdminUsersPage.tsx)
// - list/search/filter/sort, name+role edit, and safe hard-delete. See
// server/services/adminUserManagementService.ts for the orchestration/
// transaction logic layered on top of these low-level query helpers, the
// same split as accountRecoveryService.ts over this file's account-recovery
// helpers above.

export type AdminUsersListRow = {
  id: number;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "user" | "admin";
  googleConnected: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

/**
 * A user is "Google connected" exactly when it has an authIdentities row
 * for the "google" provider specifically - checked via EXISTS (never a
 * LEFT JOIN) so a future second provider can never duplicate a users row
 * in the result set (see authIdentities' UNIQUE(userId, provider) - a join
 * could still produce more than one row per user if that ever changes;
 * EXISTS structurally cannot).
 *
 * MUST filter on provider = 'google', not merely "has ANY authIdentities
 * row" - review finding on PR #45: authIdentities is provider-agnostic
 * (see drizzle/schema.ts's own doc comment: "google" today; deliberately a
 * plain varchar, not an enum, so a future second provider never requires a
 * schema migration"), so once a second provider ever exists, a user linked
 * to ONLY that other provider would incorrectly show as Google-connected
 * without this filter. Exported (not a local const) purely so
 * server/adminUsersGoogleConnected.test.ts can assert the generated SQL
 * shape via a connection-free `.toSQL()` render (same pattern as
 * buildOtherBlockingAccountRecoveryRequestsCondition), without needing a
 * live database.
 */
export function buildAdminUsersGoogleConnectedExistsCondition() {
  return sql<number>`EXISTS (SELECT 1 FROM ${authIdentities} WHERE ${authIdentities.userId} = ${users.id} AND ${authIdentities.provider} = 'google')`;
}

const ADMIN_USERS_GOOGLE_CONNECTED_EXPR = buildAdminUsersGoogleConnectedExistsCondition();

const ADMIN_USERS_SORT_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  createdAt: users.createdAt,
  lastSignedIn: users.lastSignedIn,
} as const;

/**
 * Server-side paginated/searched/filtered/sorted user list for the Admin
 * Users Management page. Deliberately selects an explicit, allowlisted
 * column set (never getTableColumns(users)) so openId/passwordHash can
 * never leak into this response even if a future column is added to
 * `users` - see drizzle/schema.ts's users table. `googleConnection`
 * filters BEFORE the count and BEFORE limit/offset (both the count query
 * and the data query share the exact same `conditions` array), and the
 * count is a dedicated COUNT(*) query - never "fetch everything, measure
 * .length" - so this stays a fixed two-query cost regardless of result
 * size (no N+1).
 */
export async function getAdminUsersList(options: {
  page: number;
  pageSize: 20 | 50 | 100;
  search?: string;
  role?: "user" | "admin";
  googleConnection?: "connected" | "not_connected";
  sortBy?: "id" | "name" | "email" | "createdAt" | "lastSignedIn";
  sortOrder?: "asc" | "desc";
}): Promise<{ users: AdminUsersListRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const page = Math.max(1, options.page || 1);
  const pageSize = options.pageSize || 20;

  const database = await getDb();
  if (!database) return { users: [], total: 0, page, pageSize, totalPages: 0 };

  const conditions: any[] = [];

  if (options.search) {
    const term = `%${options.search.toLowerCase()}%`;
    const searchConditions: any[] = [
      sql`LOWER(${users.name}) LIKE ${term}`,
      sql`LOWER(${users.email}) LIKE ${term}`,
    ];
    if (/^\d+$/.test(options.search)) {
      searchConditions.push(eq(users.id, Number(options.search)));
    }
    conditions.push(or(...searchConditions));
  }

  if (options.role) {
    conditions.push(eq(users.role, options.role));
  }

  if (options.googleConnection === "connected") {
    conditions.push(sql`${ADMIN_USERS_GOOGLE_CONNECTED_EXPR}`);
  } else if (options.googleConnection === "not_connected") {
    conditions.push(sql`NOT ${ADMIN_USERS_GOOGLE_CONNECTED_EXPR}`);
  }

  let countQuery: any = database.select({ value: count() }).from(users);
  let dataQuery: any = database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      loginMethod: users.loginMethod,
      role: users.role,
      googleConnected: ADMIN_USERS_GOOGLE_CONNECTED_EXPR,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastSignedIn: users.lastSignedIn,
    })
    .from(users);

  if (conditions.length > 0) {
    const whereClause = and(...conditions);
    countQuery = countQuery.where(whereClause);
    dataQuery = dataQuery.where(whereClause);
  }

  const countResult = await countQuery;
  const total = countResult[0]?.value ?? 0;

  const sortBy = options.sortBy ?? "createdAt";
  const sortOrder = options.sortOrder ?? "desc";
  const orderByFn = sortOrder === "asc" ? asc : desc;
  const primaryColumn = ADMIN_USERS_SORT_COLUMNS[sortBy] ?? users.createdAt;

  const rows = await dataQuery
    // `id` as the secondary sort key keeps pagination stable across pages
    // even when the primary sort column has ties (e.g. many rows sharing
    // the same createdAt second) - without it, MySQL/TiDB may return ties
    // in a different relative order per page, causing rows to be skipped
    // or duplicated across pages.
    .orderBy(orderByFn(primaryColumn), asc(users.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    users: rows.map((row: any) => ({ ...row, googleConnected: Boolean(row.googleConnected) })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export type AdminUserDeleteBlockerCategory = "economic" | "user_owned" | "audit_or_actor";

export type AdminUserDeleteBlocker = {
  table: string;
  reference: string;
  count: number;
  category: AdminUserDeleteBlockerCategory;
};

export type AdminUserDeleteAssessment = {
  userId: number;
  canDelete: boolean;
  blockers: AdminUserDeleteBlocker[];
};

/**
 * One entry per group in
 * server/services/adminUserDeletionClassification.ts's
 * ADMIN_USER_DELETION_CLASSIFICATION - grouped by (table, reference) so
 * e.g. payments.reviewedByUserId and payments.approvedByAdminId (both
 * "Payment/Admin Review References") produce ONE blocker with an OR'd
 * condition rather than two separate, double-counted entries. Deliberately
 * excludes authIdentities.userId (login_data - never a blocker, see that
 * classification entry's own reason) and the indirect (no-direct-column)
 * tables (cartItems/orderItems/payments-via-orders - already covered by
 * their parent row).
 */
const ADMIN_USER_DELETE_CHECKS: Array<{
  table: string;
  reference: string;
  category: AdminUserDeleteBlockerCategory;
  from: any;
  condition: (userId: number) => any;
}> = [
  { table: "orders", reference: "Orders", category: "economic", from: orders, condition: (id) => eq(orders.userId, id) },
  { table: "purchases", reference: "Purchases", category: "economic", from: purchases, condition: (id) => eq(purchases.userId, id) },
  { table: "episodePurchases", reference: "Episode Purchases", category: "economic", from: episodePurchases, condition: (id) => eq(episodePurchases.userId, id) },
  { table: "walletAccounts", reference: "Wallet Account", category: "economic", from: walletAccounts, condition: (id) => eq(walletAccounts.userId, id) },
  { table: "walletTransactions", reference: "Wallet Transactions", category: "economic", from: walletTransactions, condition: (id) => eq(walletTransactions.userId, id) },
  { table: "walletTopups", reference: "Wallet Top-ups", category: "economic", from: walletTopups, condition: (id) => eq(walletTopups.userId, id) },
  { table: "topupLogs", reference: "Top-up Logs", category: "economic", from: topupLogs, condition: (id) => eq(topupLogs.userId, id) },
  { table: "pointsTransactions", reference: "Points Transactions", category: "economic", from: pointsTransactions, condition: (id) => eq(pointsTransactions.userId, id) },
  { table: "couponUsages", reference: "Coupon Usages", category: "economic", from: couponUsagesTable, condition: (id) => eq(couponUsagesTable.userId, id) },
  { table: "coupons", reference: "Personal Coupons", category: "economic", from: coupons, condition: (id) => eq(coupons.ownerUserId, id) },
  { table: "sportsMatchVotes", reference: "Sports Votes", category: "economic", from: sportsMatchVotes, condition: (id) => eq(sportsMatchVotes.userId, id) },
  { table: "sportsMatchRewards", reference: "Sports Match Rewards", category: "economic", from: sportsMatchRewards, condition: (id) => eq(sportsMatchRewards.userId, id) },
  { table: "dailyCheckinRewardGrants", reference: "Daily Check-in Reward Grants", category: "economic", from: dailyCheckinRewardGrants, condition: (id) => eq(dailyCheckinRewardGrants.userId, id) },

  { table: "carts", reference: "Cart", category: "user_owned", from: carts, condition: (id) => eq(carts.userId, id) },
  { table: "wishlists", reference: "Wishlist", category: "user_owned", from: wishlists, condition: (id) => eq(wishlists.userId, id) },
  { table: "readingProgress", reference: "Reading Progress", category: "user_owned", from: readingProgress, condition: (id) => eq(readingProgress.userId, id) },
  { table: "dailyCheckins", reference: "Daily Check-ins", category: "user_owned", from: dailyCheckins, condition: (id) => eq(dailyCheckins.userId, id) },

  { table: "orderHistory", reference: "Order History Actor References", category: "audit_or_actor", from: orderHistory, condition: (id) => eq(orderHistory.actorUserId, id) },
  { table: "payments", reference: "Payment/Admin Review References", category: "audit_or_actor", from: payments, condition: (id) => or(eq(payments.reviewedByUserId, id), eq(payments.approvedByAdminId, id)) },
  { table: "walletTopups", reference: "Wallet Review/Approval References", category: "audit_or_actor", from: walletTopups, condition: (id) => or(eq(walletTopups.reviewedByUserId, id), eq(walletTopups.approvedByAdminId, id)) },
  { table: "topupLogs", reference: "Top-up Log Creator References", category: "audit_or_actor", from: topupLogs, condition: (id) => eq(topupLogs.createdBy, id) },
  { table: "dailyCheckinCampaigns", reference: "Daily Check-in Campaign Creator References", category: "audit_or_actor", from: dailyCheckinCampaigns, condition: (id) => eq(dailyCheckinCampaigns.createdBy, id) },
  {
    table: "accountRecoveryRequests",
    reference: "Account Recovery Requests",
    category: "audit_or_actor",
    from: accountRecoveryRequests,
    condition: (id) =>
      or(
        eq(accountRecoveryRequests.requesterUserId, id),
        eq(accountRecoveryRequests.reviewedByAdminId, id),
        eq(accountRecoveryRequests.sourceUserId, id),
        eq(accountRecoveryRequests.targetUserId, id)
      ),
  },
  {
    table: "accountRecoveryAuditLogs",
    reference: "Account Recovery Audit References",
    category: "audit_or_actor",
    from: accountRecoveryAuditLogs,
    condition: (id) =>
      or(
        eq(accountRecoveryAuditLogs.actorAdminId, id),
        eq(accountRecoveryAuditLogs.sourceUserId, id),
        eq(accountRecoveryAuditLogs.targetUserId, id)
      ),
  },
  // IPE-003: Advanced Account Merge's own case/audit rows - same
  // protection as accountRecoveryRequests/accountRecoveryAuditLogs above,
  // for the same reason (a merge case's source/target/creator, or a merge
  // audit entry's actor/source/target, must not be hard-deletable out from
  // under this feature's own audit trail).
  {
    table: "accountMergeCases",
    reference: "Account Merge Cases",
    category: "audit_or_actor",
    from: accountMergeCases,
    condition: (id) =>
      or(
        eq(accountMergeCases.sourceUserId, id),
        eq(accountMergeCases.targetUserId, id),
        eq(accountMergeCases.createdByAdminId, id)
      ),
  },
  {
    table: "accountMergeAuditLogs",
    reference: "Account Merge Audit References",
    category: "audit_or_actor",
    from: accountMergeAuditLogs,
    condition: (id) =>
      or(
        eq(accountMergeAuditLogs.actorAdminId, id),
        eq(accountMergeAuditLogs.sourceUserId, id),
        eq(accountMergeAuditLogs.targetUserId, id)
      ),
  },
  {
    table: "accountMergeFinancialReconciliations",
    reference: "Account Merge Financial Receipts",
    category: "audit_or_actor",
    from: accountMergeFinancialReconciliations,
    condition: (id) =>
      or(
        eq(accountMergeFinancialReconciliations.actorAdminId, id),
        eq(accountMergeFinancialReconciliations.sourceUserId, id),
        eq(accountMergeFinancialReconciliations.targetUserId, id)
      ),
  },
  {
    table: "accountMergeDataReconciliations",
    reference: "Account Merge Data Receipts",
    category: "audit_or_actor",
    from: accountMergeDataReconciliations,
    condition: (id) =>
      or(
        eq(accountMergeDataReconciliations.actorAdminId, id),
        eq(accountMergeDataReconciliations.sourceUserId, id),
        eq(accountMergeDataReconciliations.targetUserId, id)
      ),
  },
  // Review finding on PR #45: a FORMER admin who performed a prior
  // name/role edit or delete (recorded with actorAdminId = their own id,
  // back when they still held role="admin") must not be hard-deletable
  // after being demoted to role="user" - doing so would erase who actually
  // performed that past action from an append-only audit trail whose
  // entire purpose is to preserve that. Deliberately NOT checking
  // targetUserId here (see adminUserDeletionClassification.ts's
  // "never_blocks" entry for that column) - the audit trail is explicitly
  // designed to remain valid after ITS OWN target is deleted; only the
  // ACTOR identity is protected.
  {
    table: "adminUserAuditLogs",
    reference: "Admin User Audit Log Actor References",
    category: "audit_or_actor",
    from: adminUserAuditLogs,
    condition: (id) => eq(adminUserAuditLogs.actorAdminId, id),
  },
];

/**
 * Runs every hard-delete safety check against the CURRENT database state
 * (or, when called with a `tx`, that transaction's own read view - see
 * deleteAdminUserSafely in adminUserManagementService.ts). Never returns
 * row-level data - only a table/reference label and a count, per
 * server/services/adminUserDeletionClassification.ts. Read-only - never
 * throws for a non-deletable user, the caller decides what to do with a
 * non-empty blockers list.
 *
 * IMPORTANT: passing a `tx` here does NOT mean the ~24 tables this function
 * queries are locked - none of them are (only the caller's own target
 * `users` row lock, if any, applies). A concurrent write to any of these
 * tables for the same userId can still commit right after this function
 * returns a clean assessment - see deleteAdminUserSafely's own "NOT
 * CONCURRENCY-SAFE YET" docstring for the full explanation and why that
 * function is not currently wired to any tRPC procedure.
 */
export async function getAdminUserDeleteAssessment(userId: number, tx?: any): Promise<AdminUserDeleteAssessment> {
  const database = tx ?? (await getDb());
  if (!database) return { userId, canDelete: false, blockers: [] };

  const blockers: AdminUserDeleteBlocker[] = [];
  for (const check of ADMIN_USER_DELETE_CHECKS) {
    const result = await database.select({ value: count() }).from(check.from).where(check.condition(userId));
    const hitCount = result[0]?.value ?? 0;
    if (hitCount > 0) {
      blockers.push({ table: check.table, reference: check.reference, count: hitCount, category: check.category });
    }
  }

  return { userId, canDelete: blockers.length === 0, blockers };
}

/**
 * Locks every current admin-role row (SELECT ... FOR UPDATE) for the
 * duration of a role-change/delete transaction, so two concurrent
 * "demote the last two admins at once" (or "delete the last admin's
 * co-admin") requests cannot both read the same pre-transaction admin
 * count and both proceed - the loser blocks on this lock until the
 * winner commits, then re-reads the post-commit row set. Always called
 * with an explicit transaction, exactly like lockCartForCheckout above.
 *
 * `ORDER BY id` before `FOR UPDATE` (PR #45 review finding "Use one lock
 * hierarchy for admin demotions") - this is the FIRST lock any role-
 * changing admin.users mutation acquires (see
 * server/services/adminUserManagementService.ts's updateAdminUserProfile
 * "LOCK HIERARCHY" docstring for the full deadlock scenario this fixes),
 * so its own row-acquisition order must itself be deterministic: without
 * an explicit ORDER BY, MySQL/TiDB give no guarantee two concurrent
 * `WHERE role = 'admin' FOR UPDATE` scans lock the matched rows in the
 * same relative order, which could reintroduce exactly the kind of
 * lock-order-dependent deadlock this whole admin-set-lock-first hierarchy
 * exists to eliminate.
 *
 * DEPENDS ON `users_role_id_idx (role, id)` (PR #45 review finding "Avoid
 * a full-table locking scan for role changes", migration
 * `0036_add_users_role_id_index.sql`) - without a supporting index,
 * `WHERE role = 'admin' ORDER BY id FOR UPDATE` has no way to satisfy
 * either the filter or the sort from an index on MySQL/MariaDB, so it
 * scans (and locks) every row in `users`, not just the small admin set -
 * every unrelated write (including the login-time `upsertUser` update)
 * blocks behind it for as long as the transaction runs. `(role, id)` -
 * role first (matches the WHERE), id second (matches the ORDER BY) - lets
 * one index satisfy both, turning this into a range scan over just the
 * admin rows. Deliberately no `FORCE INDEX` hint here: this query must
 * keep working (just slower, exactly as it always has) on any deployment
 * where migration 0036 has not run yet - a `FORCE INDEX` would instead
 * make every role-change request fail outright until that migration is
 * applied.
 */
export async function lockAdminRoleRows(tx: any): Promise<Array<{ id: number }>> {
  const rawResult: any = await tx.execute(sql`SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE`);
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return rows || [];
}

/**
 * Locks and returns the minimal {id, name, role, openId} shape for ONE
 * users row (SELECT ... FOR UPDATE) - never passwordHash/email or any
 * other sensitive column, since this backs actor/target revalidation
 * checks that only ever need identity + role (+ openId, see below).
 * Returns undefined if the row no longer exists (e.g. deleted
 * concurrently) - callers must treat that as "this account no longer
 * exists", never as an empty/default row.
 *
 * The single shared helper every admin.users mutation must go through to
 * lock a user row - see server/services/adminUserManagementService.ts's
 * updateAdminUserProfile, which calls this once per distinct id it needs
 * (actor and/or target) in ASCENDING id order, so an actor-A/target-B
 * request and a concurrent actor-B/target-A request can never deadlock
 * against each other (same fixed-lock-order technique as
 * executeAccountRecovery's source/target user locks in
 * accountRecoveryService.ts). Always called with an explicit transaction.
 *
 * `openId` (PR #45 P1 review finding "Reject demotion of the configured
 * owner") is included specifically so updateAdminUserProfile can compare
 * the TARGET row against `ENV.ownerOpenId` using the SAME locked read
 * used for every other revalidation - never a second query, never a
 * client-supplied value. It is purely a server-side comparison key here:
 * `UpdateAdminUserResult` (this function's caller's own return shape) and
 * every audit log entry never include it - see
 * adminUserManagementService.ts's own docstring for that boundary.
 */
export async function lockUserRowForUpdate(
  userId: number,
  tx: any
): Promise<{ id: number; name: string | null; role: "user" | "admin"; openId: string } | undefined> {
  const rawResult: any = await tx.execute(
    sql`SELECT id, name, role, openId FROM users WHERE id = ${userId} FOR UPDATE`
  );
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return rows?.[0];
}

/** Conditional single-row UPDATE for name/role - `expectedRole` is the
 *  role read by the SAME transaction's earlier lock, so a concurrent
 *  change between that lock and this write (should be structurally
 *  impossible inside one locked transaction, but this is the cheapest
 *  possible guard) makes this a no-op (0 affected rows) instead of an
 *  unconditional overwrite. Never touches email/openId/loginMethod/
 *  passwordHash/createdAt/lastSignedIn - those are read-only from this
 *  page by design (see server/routers.ts's admin.users.update input
 *  schema, which has no fields for them at all). */
export async function updateAdminUserFields(
  params: { userId: number; expectedRole: "user" | "admin"; name?: string | null; role?: "user" | "admin" },
  tx: any
): Promise<boolean> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.role !== undefined) updates.role = params.role;

  const updateResult = await tx
    .update(users)
    .set(updates)
    .where(and(eq(users.id, params.userId), eq(users.role, params.expectedRole)));

  const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  return ((resultHeader as any)?.affectedRows || 0) > 0;
}

/** Deletes every authIdentities row for `userId` - always called inside the
 *  SAME transaction as deleteUsersRowChecked, immediately before it (see
 *  deleteAdminUserTransaction). Unlike moveAuthIdentityOwner's account-
 *  recovery case, there is no "expected current owner" race to guard here:
 *  once the target `users` row itself is locked, its authIdentities rows
 *  cannot be reassigned to another user by any other code path in this
 *  codebase. */
export async function deleteAuthIdentitiesForUser(userId: number, tx: any): Promise<void> {
  await tx.delete(authIdentities).where(eq(authIdentities.userId, userId));
}

/** Deletes exactly the ONE target `users` row, if it still exists - the
 *  final step of deleteAdminUserTransaction. Returns the actual
 *  affectedRows count so the caller can assert === 1 (see that spec's own
 *  step 8) rather than assuming success. */
export async function deleteUsersRowChecked(userId: number, tx: any): Promise<number> {
  const deleteResult = await tx.delete(users).where(eq(users.id, userId));
  const resultHeader = Array.isArray(deleteResult) ? deleteResult[0] : deleteResult;
  return (resultHeader as any)?.affectedRows || 0;
}

/** Append-only audit log write for the Admin Users Management page - see
 *  drizzle/schema.ts's adminUserAuditLogs doc comment for exactly what
 *  `safeMetadata` may and may not contain. Always called inside the SAME
 *  transaction as the mutation it records (see
 *  server/services/adminUserManagementService.ts), mirroring
 *  insertAccountRecoveryAuditLog's own contract. */
export async function insertAdminUserAuditLog(
  input: {
    actorAdminId: number;
    targetUserId: number;
    action: "update_name" | "update_role" | "delete_user";
    reason: string;
    safeMetadata?: Record<string, unknown> | null;
  },
  tx?: any
): Promise<void> {
  const database = tx ?? (await getDb());
  if (!database) throw new Error("Database not available");
  await database.insert(adminUserAuditLogs).values({
    actorAdminId: input.actorAdminId,
    targetUserId: input.targetUserId,
    action: input.action,
    reason: input.reason,
    safeMetadata: input.safeMetadata ? JSON.stringify(input.safeMetadata) : null,
  });
}
