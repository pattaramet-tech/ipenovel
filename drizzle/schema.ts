import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  mediumtext,
  timestamp,
  varchar,
  decimal,
  boolean,
  uniqueIndex,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

/**
 * Core user table backing auth flow.
 * Extended with role-based access control for admin/user distinction.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).notNull().unique(),
    name: text("name"),
    email: varchar("email", { length: 320 }),
    loginMethod: varchar("loginMethod", { length: 64 }),
    passwordHash: varchar("passwordHash", { length: 255 }),
    role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  },
  (table) => ({
    // Added for Google OpenID Connect direct-login account linking (see
    // server/services/googleIdentityService.ts's findUsersByNormalizedEmail)
    // - every Google sign-in with no existing authIdentities row looks up
    // users by email to decide link-vs-create-vs-fail-closed; without this
    // index that lookup is an unindexed full table scan on every such
    // login. Purely additive - does not change users.id, users.openId, or
    // any existing constraint/behavior.
    emailIdx: index("users_email_idx").on(table.email),
    // PR #45 review finding "Avoid a full-table locking scan for role
    // changes" - server/db.ts's lockAdminRoleRows() runs
    // `WHERE role = 'admin' ORDER BY id FOR UPDATE` as the first lock any
    // admin.users role-change transaction acquires (see
    // server/services/adminUserManagementService.ts's updateAdminUserProfile
    // "LOCK HIERARCHY" docstring). Without a supporting index, that query
    // scans (and locks) the entire `users` table on MySQL/MariaDB, blocking
    // unrelated writes like the login-time upsertUser update for as long as
    // the transaction runs. `(role, id)` - role first, matching the WHERE
    // clause; id second, matching the ORDER BY - lets the same index satisfy
    // both, so the query becomes an index range scan over just the admin
    // rows instead of a full-table scan. Migration 0036 adds this index;
    // purely additive - does not change any existing column, constraint, or
    // behavior.
    roleIdIdx: index("users_role_id_idx").on(table.role, table.id),
  })
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Links a third-party identity provider's subject (e.g. Google's `sub`
 * claim) to an existing ipenovel `users.id`, without ever changing that
 * user's `id` or `openId`. Added for the Google OpenID Connect
 * direct-login feature flag (VITE_AUTH_PROVIDER=google /
 * AUTH_PROVIDER=google), later extended to also back "transition" mode
 * (both Manus and Google active together, including explicitly connecting
 * a Google identity onto an existing Manus-created account - see
 * server/_core/env.ts's isGoogleAuthActive()) - see
 * server/services/googleIdentityService.ts for the account-linking policy
 * this table backs: an existing authIdentities row is used as-is; if none
 * exists but exactly one users.email matches (case-insensitive, trimmed)
 * the provider's verified email, that account is linked; more than one
 * match fails closed (never auto-links, never picks the first row); no
 * match creates a new user.
 *
 * Unlike every other relationship in this schema (see e.g.
 * couponUsages.orderId, purchases.userId, which are plain unenforced int
 * columns), userId below IS a real, named foreign key constraint
 * (authIdentities_userId_users_id_fk) to users.id, ON DELETE CASCADE -
 * deliberately different from this schema's usual convention because an
 * authIdentities row is meaningless once its user is gone (it exists
 * purely to let that user log in), so letting it silently reference a
 * deleted user (or requiring a separate manual cleanup step every place a
 * user might ever be deleted) is strictly worse than the database
 * enforcing it directly.
 */
export const authIdentities = mysqlTable(
  "authIdentities",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    // "google" today; deliberately a plain varchar (not a mysqlEnum) so a
    // future second provider never requires an ALTER TABLE MODIFY COLUMN
    // on this table - an unconditional MODIFY COLUMN has already caused a
    // real production incident once on this schema (see server/db.ts's
    // ocrConfidence column comment / migration 0022).
    provider: varchar("provider", { length: 32 }).notNull(),
    // The provider's stable, opaque subject identifier (Google's `sub`
    // claim). Never the email (which can change) and never looked up on
    // its own - always queried together with `provider` via the unique
    // index below.
    providerSubject: varchar("providerSubject", { length: 255 }).notNull(),
    // The email address the provider reported - already verified
    // (email_verified === true is required before this row is ever
    // written, see googleIdentityService.ts) - at the moment this identity
    // was linked or created. An audit/record field, never re-validated on
    // every login; the account's current email of record is always
    // users.email, not this column.
    emailAtLink: varchar("emailAtLink", { length: 320 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("authIdentities_userId_idx").on(table.userId),
    // One row per (provider, providerSubject) - the same external account
    // can never be linked to two different ipenovel users. This is the
    // exact lookup resolveGoogleIdentity performs first, before any
    // email-based linking decision.
    providerSubjectUnique: uniqueIndex("authIdentities_provider_providerSubject_unique").on(
      table.provider,
      table.providerSubject
    ),
    // One identity per provider per user - a single ipenovel account can't
    // link two different Google accounts. Also what a concurrent
    // second-tab/double-click login race is caught by (see
    // isDuplicateKeyError usage in googleIdentityService.ts) - the loser
    // of the race re-reads this row instead of erroring or creating a
    // duplicate.
    userProviderUnique: uniqueIndex("authIdentities_userId_provider_unique").on(
      table.userId,
      table.provider
    ),
    // ON DELETE CASCADE: an authIdentities row has no meaning independent
    // of the user it lets sign in as - if that user is ever deleted, the
    // identity row should go with it rather than being left behind as an
    // orphan or blocking the delete. Standard MySQL/MariaDB/TiDB
    // REFERENCES syntax - no engine-specific extension.
    userIdFk: foreignKey({
      name: "authIdentities_userId_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  })
);

export type AuthIdentity = typeof authIdentities.$inferSelect;
export type InsertAuthIdentity = typeof authIdentities.$inferInsert;

/**
 * Categories for novels (e.g., Romance, Fantasy, Sci-Fi)
 */
export const categories = mysqlTable("categories", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Category = typeof categories.$inferSelect;
export type InsertCategory = typeof categories.$inferInsert;

/**
 * Novels (main content items)
 * 
 * Status is now split into two separate dimensions:
 * - publicationStatus: controls visibility (published = visible, archived = hidden)
 * - storyStatus: indicates story progress (ongoing = still writing, finished = completed)
 */
export const novels = mysqlTable(
  "novels",
  {
    id: int("id").autoincrement().primaryKey(),
    title: varchar("title", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 500 }).notNull().unique(),
    description: text("description"),
    author: varchar("author", { length: 255 }),
    coverImageUrl: text("coverImageUrl"),
    // Publication status controls visibility on public pages
    publicationStatus: mysqlEnum("publicationStatus", ["published", "archived"]).default("published").notNull(),
    // Story status indicates story progress
    storyStatus: mysqlEnum("storyStatus", ["ongoing", "finished"]).default("ongoing").notNull(),
    // Legacy status field for backward compatibility during migration (will be removed after migration)
    status: mysqlEnum("status", ["ongoing", "completed", "hiatus", "pending"]).default("ongoing"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("novels_createdAt_idx").on(table.createdAt),
    titleIdx: index("novels_title_idx").on(table.title),
    publicationStatusIdx: index("novels_publicationStatus_idx").on(table.publicationStatus),
    // Phase 3: every homepage ranking query (getNewNovels, getPopularNovels'
    // candidate pool, getFreeNovels, getFinishedNovels) filters
    // publicationStatus = "published" then orders by createdAt DESC - this
    // composite lets that run as a single ordered index range scan instead
    // of an index lookup followed by a separate filesort. See
    // docs/PERFORMANCE_SEO_AUDIT.md Phase 3 for the query-pattern evidence.
    publicationStatusCreatedAtIdx: index("novels_publicationStatus_createdAt_idx").on(
      table.publicationStatus,
      table.createdAt
    ),
  })
);

export type Novel = typeof novels.$inferSelect;
export type InsertNovel = typeof novels.$inferInsert;

/**
 * Junction table: novels to categories (many-to-many)
 */
export const novelCategories = mysqlTable(
  "novelCategories",
  {
    id: int("id").autoincrement().primaryKey(),
    novelId: int("novelId").notNull(),
    categoryId: int("categoryId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    novelIdIdx: index("novelId_idx").on(table.novelId),
    categoryIdIdx: index("categoryId_idx").on(table.categoryId),
    uniqueNovelCategory: uniqueIndex("unique_novel_category").on(table.novelId, table.categoryId),
  })
);

export type NovelCategory = typeof novelCategories.$inferSelect;
export type InsertNovelCategory = typeof novelCategories.$inferInsert;

/**
 * Episodes within novels (free or paid)
 * Supports episode ranges (e.g., "581 - 619") as a single entry
 * Now includes reader content and metadata fields
 */
export const episodes = mysqlTable(
  "episodes",
  {
    id: int("id").autoincrement().primaryKey(),
    novelId: int("novelId").notNull(),
    episodeNumber: varchar("episodeNumber", { length: 100 }).notNull(), // Supports ranges like "581 - 619"
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    isFree: boolean("isFree").default(false).notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).default("0.00").notNull(), // Price in currency units
    fileUrl: text("fileUrl"), // S3 URL for the episode file (legacy, optional)
    fileSize: int("fileSize"), // File size in bytes
    fileMimeType: varchar("fileMimeType", { length: 100 }), // e.g., "application/pdf"
    // Reader content fields
    // MEDIUMTEXT (up to ~16MB) instead of TEXT (~64KB) - a "package" episode
    // bundles many chapters (e.g. 50-100) worth of plaintext, which regularly
    // exceeds TEXT's capacity. See migrations/008_widen_episode_content_to_mediumtext.sql.
    content: mediumtext("content"), // Episode text content for web reader
    contentFormat: varchar("contentFormat", { length: 50 }).default("plain_text"), // plain_text, markdown, html
    // Explicit sale mode: "chapter" = single episode sold individually via
    // reader.purchaseEpisode (wallet direct debit); "package" = multi-chapter
    // bundle sold via cart/checkout, read on the web only (no file download).
    // Defaults to "chapter" so existing single-episode rows are unaffected;
    // legacy fileUrl-based rows are backfilled to "package" by migration 007
    // (see migrations/007_backfill_episode_sale_mode.sql). Application code
    // should still fall back to resolveSaleMode()'s legacy detection (fileUrl
    // present, or a "N - M" range episodeNumber) for any row where this value
    // is somehow missing.
    saleMode: mysqlEnum("saleMode", ["chapter", "package"]).default("chapter").notNull(),
    isPublished: boolean("isPublished").default(true).notNull(), // Controls reader visibility
    publishedAt: timestamp("publishedAt"), // When episode was published
    wordCount: int("wordCount"), // For metadata/analytics
    sortOrder: int("sortOrder"), // Manual sort order within novel
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    novelIdIdx: index("episodes_novelId_idx").on(table.novelId),
    isFreeIdx: index("episodes_isFree_idx").on(table.isFree),
    isPublishedIdx: index("episodes_isPublished_idx").on(table.isPublished),
    sortOrderIdx: index("episodes_sortOrder_idx").on(table.sortOrder),
    uniqueEpisode: uniqueIndex("unique_novel_episode").on(table.novelId, table.episodeNumber),
    // Phase 3: getLatestEpisodes (Home page "Latest Uploaded Episodes")
    // filters isPublished = true then orders by createdAt DESC across the
    // WHOLE table (it intentionally isn't scoped to one novel) - there was
    // no createdAt-related index on this table at all, meaning every
    // homepage load did a full table scan + filesort on what's likely the
    // largest table in the schema. See docs/PERFORMANCE_SEO_AUDIT.md Phase 3.
    isPublishedCreatedAtIdx: index("episodes_isPublished_createdAt_idx").on(
      table.isPublished,
      table.createdAt
    ),
  })
);

export type Episode = typeof episodes.$inferSelect;
export type InsertEpisode = typeof episodes.$inferInsert;

/**
 * Shopping cart for users
 */
export const carts = mysqlTable(
  "carts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("carts_userId_idx").on(table.userId),
    uniqueUserCart: uniqueIndex("unique_user_cart").on(table.userId),
  })
);

export type Cart = typeof carts.$inferSelect;
export type InsertCart = typeof carts.$inferInsert;

/**
 * Items in shopping cart
 */
export const cartItems = mysqlTable(
  "cartItems",
  {
    id: int("id").autoincrement().primaryKey(),
    cartId: int("cartId").notNull(),
    episodeId: int("episodeId").notNull(),
    novelId: int("novelId").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).notNull(), // Snapshot of price at add time
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    cartIdIdx: index("cartItems_cartId_idx").on(table.cartId),
    episodeIdIdx: index("cartItems_episodeId_idx").on(table.episodeId),
    uniqueCartEpisode: uniqueIndex("unique_cart_episode").on(table.cartId, table.episodeId),
  })
);

export type CartItem = typeof cartItems.$inferSelect;
export type InsertCartItem = typeof cartItems.$inferInsert;

/**
 * Orders (billing header)
 * One order can contain multiple orderItems
 */
export const orders = mysqlTable(
  "orders",
  {
    id: int("id").autoincrement().primaryKey(),
    orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
    userId: int("userId"),
    subtotal: decimal("subtotal", { precision: 12, scale: 2 }).default("0.00").notNull(),
    discountAmount: decimal("discountAmount", { precision: 12, scale: 2 }).default("0.00").notNull(),
    pointsDiscountAmount: decimal("pointsDiscountAmount", { precision: 12, scale: 2 }).default("0.00").notNull(),
    totalAmount: decimal("totalAmount", { precision: 12, scale: 2 }).default("0.00").notNull(),
    status: mysqlEnum("status", ["pending", "approved", "rejected", "cancelled"]).default("pending").notNull(),
    paymentStatus: mysqlEnum("paymentStatus", ["unpaid", "submitted", "approved", "rejected"]).default("unpaid").notNull(),
    couponCodeSnapshot: varchar("couponCodeSnapshot", { length: 100 }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("orders_userId_idx").on(table.userId),
    orderNumberIdx: uniqueIndex("orders_orderNumber_idx").on(table.orderNumber),
  })
);

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

/**
 * Items within an order
 * Multiple items per order for multi-episode purchases
 */
export const orderItems = mysqlTable(
  "orderItems",
  {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("orderId").notNull(),
    novelId: int("novelId").notNull(),
    episodeId: int("episodeId").notNull(),
    unitPrice: decimal("unitPrice", { precision: 10, scale: 2 }).notNull(),
    discountAmount: decimal("discountAmount", { precision: 10, scale: 2 }).default("0.00").notNull(),
    finalPrice: decimal("finalPrice", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderIdIdx: index("orderItems_orderId_idx").on(table.orderId),
    episodeIdIdx: index("orderItems_episodeId_idx").on(table.episodeId),
    uniqueOrderEpisode: uniqueIndex("unique_order_episode").on(table.orderId, table.episodeId),
  })
);

export type OrderItem = typeof orderItems.$inferSelect;
export type InsertOrderItem = typeof orderItems.$inferInsert;

/**
 * Payment records (one per order)
 * Stores proof of payment and admin verification result
 */
export const payments = mysqlTable(
  "payments",
  {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("orderId").notNull().unique(),
    slipImageUrl: text("slipImageUrl"),
    slipSubmittedAt: timestamp("slipSubmittedAt"),
    status: mysqlEnum("status", ["pending", "approved", "rejected", "pending_review"]).default("pending").notNull(),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: int("reviewedByUserId"),
    reviewedAt: timestamp("reviewedAt"),
    // OCR extraction fields for auto-approval
    extractedData: text("extractedData"), // JSON: {shopName, merchantCode, merchantTransactionCode, amount, transactionDate, reference}
    reviewReason: varchar("reviewReason", { length: 255 }), // Reason code for pending_review status
    fingerprint: varchar("fingerprint", { length: 255 }), // Hash for duplicate detection
    autoApprovedAt: timestamp("autoApprovedAt"), // When auto-approval occurred
    linkedOrderId: int("linkedOrderId"), // Order ID this slip was verified against
    linkedPaymentId: int("linkedPaymentId"), // Payment ID this slip was verified against
    // OCR decision and confidence
    ocrConfidence: int("ocrConfidence").notNull().default(0), // OCR confidence score (0-100)
    ocrDecision: mysqlEnum("ocrDecision", ["auto_approved", "needs_review", "rejected", "ocr_disabled", "shadow_auto_approved"]).notNull().default("needs_review"), // OCR decision state
    // Approval metadata
    approvalSource: mysqlEnum("approvalSource", ["manual", "auto", "wallet", "legacy"]).default("legacy"),
    approvedByAdminId: int("approvedByAdminId"), // Admin user ID for manual approvals
    approvedByLabel: varchar("approvedByLabel", { length: 255 }), // Display name/label for approval source
    approvedAt: timestamp("approvedAt"), // When payment was approved
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    orderIdIdx: uniqueIndex("payments_orderId_idx").on(table.orderId),
    reviewerIdx: index("payments_reviewedByUserId_idx").on(table.reviewedByUserId),
    fingerprintIdx: index("payments_fingerprint_idx").on(table.fingerprint),
    statusIdx: index("payments_status_idx").on(table.status),
    approvalSourceIdx: index("payments_approvalSource_idx").on(table.approvalSource),
    approvedByAdminIdIdx: index("payments_approvedByAdminId_idx").on(table.approvedByAdminId),
    ocrConfidenceIdx: index("payments_ocrConfidence_idx").on(table.ocrConfidence),
    ocrDecisionIdx: index("payments_ocrDecision_idx").on(table.ocrDecision),
  })
);

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;
export type OCRDecision = "auto_approved" | "needs_review" | "rejected" | "ocr_disabled" | "shadow_auto_approved";


/**
 * Purchase entitlements (source of truth for content access)
 * Created after successful payment approval
 * One entry per user-episode purchase
 */
export const purchases = mysqlTable(
  "purchases",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    novelId: int("novelId").notNull(),
    episodeId: int("episodeId").notNull(),
    orderId: int("orderId").notNull(),
    grantedAt: timestamp("grantedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("purchases_userId_idx").on(table.userId),
    episodeIdIdx: index("purchases_episodeId_idx").on(table.episodeId),
    orderIdIdx: index("purchases_orderId_idx").on(table.orderId),
    uniqueUserEpisode: uniqueIndex("unique_user_episode").on(table.userId, table.episodeId),
    // Phase 3: getPopularNovels' purchaseCounts subquery does
    // `GROUP BY purchases.novelId` with no index on novelId at all -
    // requires a full table scan + temp table today. Note wishlists(novelId)
    // and a userId+episodeId composite were also audited as candidates but
    // both already exist (wishlists_novelId_idx, unique_user_episode above)
    // - not duplicated. See docs/PERFORMANCE_SEO_AUDIT.md Phase 3.
    novelIdIdx: index("purchases_novelId_idx").on(table.novelId),
  })
);

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = typeof purchases.$inferInsert;

/**
 * Episode purchases via wallet (reader system)
 * One entry per user-episode wallet purchase
 * Separated from order-based purchases (which use the purchases table)
 */
export const episodePurchases = mysqlTable(
  "episodePurchases",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    novelId: int("novelId").notNull(),
    episodeId: int("episodeId").notNull(),
    pricePaid: decimal("pricePaid", { precision: 10, scale: 2 }).notNull(),
    walletTransactionId: int("walletTransactionId"), // Reference to wallet debit transaction
    purchasedAt: timestamp("purchasedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("episodePurchases_userId_idx").on(table.userId),
    novelIdIdx: index("episodePurchases_novelId_idx").on(table.novelId),
    episodeIdIdx: index("episodePurchases_episodeId_idx").on(table.episodeId),
    walletTransactionIdIdx: index("episodePurchases_walletTransactionId_idx").on(table.walletTransactionId),
    uniqueUserEpisode: uniqueIndex("unique_user_episode_purchase").on(table.userId, table.episodeId),
  })
);

export type EpisodePurchase = typeof episodePurchases.$inferSelect;
export type InsertEpisodePurchase = typeof episodePurchases.$inferInsert;

/**
 * Reading progress tracking
 * Stores user progress within each episode for resume functionality
 */
export const readingProgress = mysqlTable(
  "readingProgress",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    novelId: int("novelId").notNull(),
    episodeId: int("episodeId").notNull(),
    progressPercent: int("progressPercent").default(0).notNull(),
    scrollPosition: int("scrollPosition").default(0).notNull(),
    // Which in-package chapter the reader last scrolled past, for packages
    // with an internal table of contents (see packageTocUtils.ts on the
    // client). Null for plain chapter episodes with no internal TOC.
    currentChapterNumber: varchar("currentChapterNumber", { length: 100 }),
    currentChapterTitle: varchar("currentChapterTitle", { length: 500 }),
    // Stable anchor id (e.g. "toc-3") the reader can scroll straight back to,
    // more precise than progressPercent/scrollPosition alone since content
    // reflow (font size change) shifts absolute scroll offsets.
    anchorKey: varchar("anchorKey", { length: 100 }),
    lastReadAt: timestamp("lastReadAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("readingProgress_userId_idx").on(table.userId),
    novelIdIdx: index("readingProgress_novelId_idx").on(table.novelId),
    episodeIdIdx: index("readingProgress_episodeId_idx").on(table.episodeId),
    uniqueUserEpisodeProgress: uniqueIndex("unique_user_episode_progress").on(table.userId, table.episodeId),
  })
);

export type ReadingProgress = typeof readingProgress.$inferSelect;
export type InsertReadingProgress = typeof readingProgress.$inferInsert;

/**
 * Coupons for discounts
 */
export const coupons = mysqlTable(
  "coupons",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 50 }).notNull().unique(),
    discountType: mysqlEnum("discountType", ["flat", "percentage"]).notNull(),
    discountValue: decimal("discountValue", { precision: 10, scale: 2 }).notNull(),
    // Nullable - NULL preserves the exact pre-existing behavior (no cap) for
    // every coupon created before this column existed. Only applied when set,
    // and only meaningful for discountType="percentage" (see
    // orderService.validateAndApplyCoupon). Added for the daily check-in
    // reward ("5% off, capped at ฿10"), which the previous schema could not
    // express - see docs/DAILY_CHECKIN_COUPON.md PART C.
    maxDiscountAmount: decimal("maxDiscountAmount", { precision: 10, scale: 2 }),
    minPurchaseAmount: decimal("minPurchaseAmount", { precision: 10, scale: 2 }).default("0.00"),
    maxUsageCount: int("maxUsageCount"),
    usageCount: int("usageCount").default(0).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    expiresAt: timestamp("expiresAt"),
    // Coupon ownership scope - added by migration 0032 (fix/coupon-owner-enforcement).
    // "global": usable by any user, subject only to the normal
    // isActive/expiresAt/usageCount/minPurchaseAmount checks - this is the
    // default, preserving every pre-existing coupon's exact behavior with
    // zero backfill (see docs on migration 0032).
    // "user": usable only by ownerUserId. Application layer (server/db.ts
    // createCoupon/updateCoupon) enforces scope="user" <=> ownerUserId set -
    // deliberately not a DB CHECK constraint, to stay consistent with how
    // every other cross-field invariant in this schema (money normalization,
    // episode sale mode, etc.) is enforced in code, not SQL.
    //
    // This is independent of (and does not replace) the legacy
    // sportsMatchRewards/dailyCheckins reward-coupon ownership fallback in
    // server/db.ts's getRewardCouponOwnership() - a coupon can be protected
    // by EITHER mechanism, and both are checked. Existing reward coupons
    // keep scope="global"/ownerUserId=NULL (the column default) since they
    // were never backfilled; they remain fully protected because
    // getRewardCouponOwnership()'s join-based check runs unconditionally,
    // regardless of what `scope` says.
    scope: mysqlEnum("scope", ["global", "user"]).default("global").notNull(),
    // Nullable - only ever set when scope="user". NOT a trusted client input:
    // always resolved server-side (admin.coupons.create/update looks the
    // target user up via db.getUserById before writing this column).
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex("coupons_code_idx").on(table.code),
    ownerUserIdIdx: index("coupons_ownerUserId_idx").on(table.ownerUserId),
  })
);

export type Coupon = typeof coupons.$inferSelect;
export type InsertCoupon = typeof coupons.$inferInsert;

/**
 * Coupon usage tracking
 */
export const couponUsages = mysqlTable(
  "couponUsages",
  {
    id: int("id").autoincrement().primaryKey(),
    couponId: int("couponId").notNull(),
    userId: int("userId"),
    orderId: int("orderId").notNull(),
    usedAt: timestamp("usedAt").defaultNow().notNull(),
  },
  (table) => ({
    couponIdIdx: index("couponUsages_couponId_idx").on(table.couponId),
    userIdIdx: index("couponUsages_userId_idx").on(table.userId),
    orderIdIdx: index("couponUsages_orderId_idx").on(table.orderId),
    couponOrderUnique: unique("couponUsages_couponId_orderId_unique").on(table.couponId, table.orderId),
  })
);

export type CouponUsage = typeof couponUsages.$inferSelect;
export type InsertCouponUsage = typeof couponUsages.$inferInsert;

/**
 * Points system transactions
 * Conversion: 100 currency units = 1 point
 * Redemption: 1 point = 1 currency unit
 */
export const pointsTransactions = mysqlTable(
  "pointsTransactions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    type: mysqlEnum("type", ["earn", "redeem", "adjust", "refund"]).notNull(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    balanceAfter: decimal("balanceAfter", { precision: 10, scale: 2 }).notNull(),
    referenceType: varchar("referenceType", { length: 50 }), // e.g., "order", "refund"
    referenceId: int("referenceId"), // e.g., orderId
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("pointsTransactions_userId_idx").on(table.userId),
    referenceIdx: index("pointsTransactions_referenceType_referenceId_idx").on(
      table.referenceType,
      table.referenceId
    ),
  })
);

export type PointsTransaction = typeof pointsTransactions.$inferSelect;
export type InsertPointsTransaction = typeof pointsTransactions.$inferInsert;

/**
 * Wishlists for users
 */
export const wishlists = mysqlTable(
  "wishlists",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    novelId: int("novelId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("wishlists_userId_idx").on(table.userId),
    novelIdIdx: index("wishlists_novelId_idx").on(table.novelId),
    uniqueUserNovel: uniqueIndex("unique_user_novel").on(table.userId, table.novelId),
  })
);

export type Wishlist = typeof wishlists.$inferSelect;
export type InsertWishlist = typeof wishlists.$inferInsert;

/**
 * Banners for homepage/promotions
 */
export const banners = mysqlTable("banners", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  imageUrl: text("imageUrl").notNull(),
  linkUrl: text("linkUrl"),
  displayOrder: int("displayOrder").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Banner = typeof banners.$inferSelect;
export type InsertBanner = typeof banners.$inferInsert;

/**
 * Site settings/configuration
 */
export const settings = mysqlTable("settings", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: text("value"),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

/**
 * Order history/audit log
 */
export const orderHistory = mysqlTable(
  "orderHistory",
  {
    id: int("id").autoincrement().primaryKey(),
    orderId: int("orderId").notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    fromStatus: varchar("fromStatus", { length: 50 }),
    toStatus: varchar("toStatus", { length: 50 }),
    actorUserId: int("actorUserId"),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    orderIdIdx: index("orderHistory_orderId_idx").on(table.orderId),
    actorIdx: index("orderHistory_actorUserId_idx").on(table.actorUserId),
  })
);

export type OrderHistory = typeof orderHistory.$inferSelect;
export type InsertOrderHistory = typeof orderHistory.$inferInsert;


export const walletAccounts = mysqlTable("walletAccounts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0.00"),
  totalTopupApproved: decimal("totalTopupApproved", { precision: 12, scale: 2 }).default("0.00"),
  totalSpent: decimal("totalSpent", { precision: 12, scale: 2 }).default("0.00"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({ userIdIdx: index("walletAccounts_userId_idx").on(table.userId) }));

export type WalletAccount = typeof walletAccounts.$inferSelect;
export type InsertWalletAccount = typeof walletAccounts.$inferInsert;

export const walletTransactions = mysqlTable("walletTransactions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["topup_pending", "topup_approved", "topup_rejected", "debit", "refund", "adjust"]).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  balanceBefore: decimal("balanceBefore", { precision: 12, scale: 2 }).notNull(),
  balanceAfter: decimal("balanceAfter", { precision: 12, scale: 2 }).notNull(),
  referenceType: varchar("referenceType", { length: 50 }),
  referenceId: int("referenceId"),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("walletTransactions_userId_idx").on(table.userId),
  createdAtIdx: index("walletTransactions_createdAt_idx").on(table.createdAt),
}));

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type InsertWalletTransaction = typeof walletTransactions.$inferInsert;

export const walletTopups = mysqlTable("walletTopups", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  requestedAmount: decimal("requestedAmount", { precision: 12, scale: 2 }).notNull(),
  bonusAmount: decimal("bonusAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  creditedAmount: decimal("creditedAmount", { precision: 12, scale: 2 }),
  slipImageUrl: text("slipImageUrl"),
  slipSubmittedAt: timestamp("slipSubmittedAt"),
  status: mysqlEnum("status", ["pending", "pending_review", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  rejectionReason: text("rejectionReason"),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  approvedAt: timestamp("approvedAt"),
  approvedByAdminId: int("approvedByAdminId"),
  rejectedAt: timestamp("rejectedAt"),
  // OCR extracted data and confidence scores
  extractedData: text("extractedData"), // JSON: { amount, reference, transactionDate, bank, merchant, shopName }
  ocrConfidence: decimal("ocrConfidence", { precision: 5, scale: 2 }),
  visionConfidence: decimal("visionConfidence", { precision: 5, scale: 2 }),
  structuredConfidence: decimal("structuredConfidence", { precision: 5, scale: 2 }),
  finalConfidence: decimal("finalConfidence", { precision: 5, scale: 2 }),
  // Duplicate detection
  duplicateStatus: text("duplicateStatus"), // JSON: { isDuplicate, type, reference, fingerprint }
  // OCR decision and review reason
  ocrDecision: mysqlEnum("ocrDecision", ["approved", "needs_review", "rejected"]),
  reviewReason: text("reviewReason"), // e.g., AMOUNT_MISMATCH, LOW_CONFIDENCE, DUPLICATE_REFERENCE, OCR_PROCESSING_ERROR, PDF_MANUAL_REVIEW
  // Approval source tracking
  approvalSource: mysqlEnum("approvalSource", ["manual", "ocr_auto"]).default("manual"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdIdx: index("walletTopups_userId_idx").on(table.userId),
  statusIdx: index("walletTopups_status_idx").on(table.status),
  createdAtIdx: index("walletTopups_createdAt_idx").on(table.createdAt),
}));

export type WalletTopup = typeof walletTopups.$inferSelect;
export type InsertWalletTopup = typeof walletTopups.$inferInsert;

/**
 * Top-up Logs (Admin Audit Trail)
 * Tracks all wallet balance changes with full audit context
 */
export const topupLogs = mysqlTable(
  "topupLogs",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    bonus: decimal("bonus", { precision: 12, scale: 2 }).notNull().default("0.00"),
    total: decimal("total", { precision: 12, scale: 2 }).notNull(),
    method: mysqlEnum("method", ["slip", "admin_adjust", "promo"]).notNull(),
    reference: varchar("reference", { length: 255 }),
    note: text("note"),
    createdBy: int("createdBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("topupLogs_userId_idx").on(table.userId),
    methodIdx: index("topupLogs_method_idx").on(table.method),
    createdAtIdx: index("topupLogs_createdAt_idx").on(table.createdAt),
  })
);

export type TopupLog = typeof topupLogs.$inferSelect;
export type InsertTopupLog = typeof topupLogs.$inferInsert;

/**
 * Sports Matches (Football prediction voting)
 * Admin creates matches with team info, vote cost, and reward coupon settings.
 * Users vote on match results and spend points.
 * Admin settles matches and generates reward coupons for winners.
 */
export const sportsMatches = mysqlTable(
  "sportsMatches",
  {
    id: int("id").autoincrement().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    leagueName: varchar("leagueName", { length: 255 }),

    homeTeamName: varchar("homeTeamName", { length: 255 }).notNull(),
    awayTeamName: varchar("awayTeamName", { length: 255 }).notNull(),
    homeTeamImageUrl: text("homeTeamImageUrl"),
    awayTeamImageUrl: text("awayTeamImageUrl"),
    coverImageUrl: text("coverImageUrl"),

    matchStartAt: timestamp("matchStartAt"),
    voteDeadlineAt: timestamp("voteDeadlineAt").notNull(),

    voteCostPoints: decimal("voteCostPoints", { precision: 10, scale: 2 }).default("0.00").notNull(),

    rewardDiscountType: mysqlEnum("rewardDiscountType", ["flat", "percentage"]).notNull(),
    rewardDiscountValue: decimal("rewardDiscountValue", { precision: 10, scale: 2 }).notNull(),
    rewardMinPurchaseAmount: decimal("rewardMinPurchaseAmount", { precision: 10, scale: 2 }).default("0.00"),
    rewardCouponExpiresAt: timestamp("rewardCouponExpiresAt"),

    status: mysqlEnum("status", ["draft", "open", "closed", "settled", "cancelled"]).default("draft").notNull(),
    result: mysqlEnum("result", ["home_win", "draw", "away_win"]),

    isActive: boolean("isActive").default(true).notNull(),
    displayOrder: int("displayOrder").default(0).notNull(),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    statusIdx: index("sportsMatches_status_idx").on(table.status),
    activeIdx: index("sportsMatches_isActive_idx").on(table.isActive),
    deadlineIdx: index("sportsMatches_voteDeadlineAt_idx").on(table.voteDeadlineAt),
    displayOrderIdx: index("sportsMatches_displayOrder_idx").on(table.displayOrder),
  })
);

export type SportsMatch = typeof sportsMatches.$inferSelect;
export type InsertSportsMatch = typeof sportsMatches.$inferInsert;

/**
 * Sports Match Votes (User predictions)
 * Tracks each user's vote on a match.
 * One vote per user per match (enforced by unique index).
 * Stores prediction, points spent, vote status, and reward coupon if won.
 */
export const sportsMatchVotes = mysqlTable(
  "sportsMatchVotes",
  {
    id: int("id").autoincrement().primaryKey(),
    matchId: int("matchId").notNull(),
    userId: int("userId").notNull(),

    prediction: mysqlEnum("prediction", ["home_win", "draw", "away_win"]).notNull(),
    pointsSpent: decimal("pointsSpent", { precision: 10, scale: 2 }).default("0.00").notNull(),

    status: mysqlEnum("status", ["pending", "won", "lost", "refunded"]).default("pending").notNull(),
    rewardCouponId: int("rewardCouponId"),
    rewardCouponCode: varchar("rewardCouponCode", { length: 50 }),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    matchIdIdx: index("sportsMatchVotes_matchId_idx").on(table.matchId),
    userIdIdx: index("sportsMatchVotes_userId_idx").on(table.userId),
    statusIdx: index("sportsMatchVotes_status_idx").on(table.status),
    uniqueUserMatchVote: uniqueIndex("unique_sports_match_user_vote").on(table.matchId, table.userId),
  })
);

export type SportsMatchVote = typeof sportsMatchVotes.$inferSelect;
export type InsertSportsMatchVote = typeof sportsMatchVotes.$inferInsert;

/**
 * Sports Match Rewards (Reward coupon tracking)
 * Links winning votes to their issued reward coupons.
 * Tracks ownership, status (issued/used/expired/void), and timestamps.
 * Ensures only the vote owner can use the reward coupon.
 */
export const sportsMatchRewards = mysqlTable(
  "sportsMatchRewards",
  {
    id: int("id").autoincrement().primaryKey(),
    matchId: int("matchId").notNull(),
    voteId: int("voteId").notNull(),
    userId: int("userId").notNull(),
    couponId: int("couponId").notNull(),

    status: mysqlEnum("status", ["issued", "used", "expired", "void"]).default("issued").notNull(),
    issuedAt: timestamp("issuedAt").defaultNow().notNull(),
    usedAt: timestamp("usedAt"),
    expiredAt: timestamp("expiredAt"),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    matchIdIdx: index("sportsMatchRewards_matchId_idx").on(table.matchId),
    userIdIdx: index("sportsMatchRewards_userId_idx").on(table.userId),
    statusIdx: index("sportsMatchRewards_status_idx").on(table.status),
    uniqueVoteId: uniqueIndex("unique_sports_match_rewards_vote").on(table.voteId),
    uniqueCouponId: uniqueIndex("unique_sports_match_rewards_coupon").on(table.couponId),
  })
);

export type SportsMatchReward = typeof sportsMatchRewards.$inferSelect;
export type InsertSportsMatchReward = typeof sportsMatchRewards.$inferInsert;

/**
 * Daily Check-in Rewards
 * One row per successful check-in. Mirrors the sportsMatchRewards pattern
 * (a coupon row + an ownership/status-tracking row created together in one
 * transaction) - see docs/DAILY_CHECKIN_COUPON.md.
 *
 * checkinDate is a "YYYY-MM-DD" string (Asia/Bangkok business date, computed
 * server-side only by server/_core/timezone.ts's getBangkokBusinessDate) -
 * deliberately not a DATE/timestamp column, so there is no driver-level
 * timezone reinterpretation possible on read-back.
 *
 * The UNIQUE(userId, checkinDate, campaignKey) constraint is the actual,
 * DB-enforced "one check-in per user per day" guarantee - not a
 * frontend-only disabled button.
 */
export const dailyCheckins = mysqlTable(
  "dailyCheckins",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    checkinDate: varchar("checkinDate", { length: 10 }).notNull(),
    campaignKey: varchar("campaignKey", { length: 50 }).default("default").notNull(),
    // Nullable since migration 0031: a point-reward check-in mints no coupon
    // at all, so there is nothing to reference. Legacy coupon check-ins keep
    // their couponId unchanged, and the unique index below still holds -
    // MySQL/TiDB allow many NULLs in a UNIQUE index, which is exactly what
    // lets an unlimited number of point-only check-ins coexist.
    couponId: int("couponId"),
    status: mysqlEnum("status", ["issued", "used", "void"]).default("issued").notNull(),
    issuedAt: timestamp("issuedAt").defaultNow().notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("dailyCheckins_userId_idx").on(table.userId),
    uniqueUserDateCampaign: uniqueIndex("unique_daily_checkin_user_date_campaign").on(
      table.userId,
      table.checkinDate,
      table.campaignKey
    ),
    uniqueCouponId: uniqueIndex("unique_daily_checkins_coupon").on(table.couponId),
  })
);

export type DailyCheckin = typeof dailyCheckins.$inferSelect;
export type InsertDailyCheckin = typeof dailyCheckins.$inferInsert;

/**
 * Stage 1A of the configurable daily check-in reward system - see
 * docs/DAILY_CHECKIN_DYNAMIC_REWARDS_DESIGN.md. Admin-editable campaign
 * definitions, replacing the single hardcoded JSON-blob config
 * (server/_core/dailyCheckinConfig.ts) with relational, per-campaign rows.
 * Purely additive at this stage: dailyCheckins is not yet linked to this
 * table, and claimDailyCheckin/getDailyCheckinStatus are not rewritten
 * until a later stage (see the design doc's PART L migration plan).
 *
 * `status` replaces an earlier isActive-boolean design: draft is fully
 * editable and can activate exactly once; active can only end early;
 * ended is terminal with no reactivation.
 */
export const dailyCheckinCampaigns = mysqlTable(
  "dailyCheckinCampaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignKey: varchar("campaignKey", { length: 50 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description"),
    timezone: varchar("timezone", { length: 50 }).default("Asia/Bangkok").notNull(),
    startDate: varchar("startDate", { length: 10 }).notNull(),
    endDate: varchar("endDate", { length: 10 }).notNull(),
    status: mysqlEnum("status", ["draft", "active", "ended"]).default("draft").notNull(),
    createdBy: int("createdBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    campaignKeyIdx: uniqueIndex("dailyCheckinCampaigns_campaignKey_unique").on(table.campaignKey),
    statusDateIdx: index("dailyCheckinCampaigns_status_date_idx").on(
      table.status,
      table.startDate,
      table.endDate
    ),
  })
);

export type DailyCheckinCampaign = typeof dailyCheckinCampaigns.$inferSelect;
export type InsertDailyCheckinCampaign = typeof dailyCheckinCampaigns.$inferInsert;

/**
 * Coupon-minting parameters for coupon-kind reward rules
 * (dailyCheckinRewardRules.couponTemplateId). A template is the parameters
 * used to mint a fresh `coupons` row at grant time - never a real,
 * pre-existing coupon. Mirrors today's single global
 * DailyCheckinCampaignConfig shape, moved into a relational, per-campaign
 * row.
 */
export const dailyCheckinCouponTemplates = mysqlTable(
  "dailyCheckinCouponTemplates",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaignId").notNull(),
    discountType: mysqlEnum("discountType", ["flat", "percentage"]).notNull(),
    discountValue: decimal("discountValue", { precision: 10, scale: 2 }).notNull(),
    maxDiscountAmount: decimal("maxDiscountAmount", { precision: 10, scale: 2 }),
    minPurchaseAmount: decimal("minPurchaseAmount", { precision: 10, scale: 2 }).default("0.00").notNull(),
    validityDays: int("validityDays").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    campaignIdIdx: index("dailyCheckinCouponTemplates_campaignId_idx").on(table.campaignId),
  })
);

export type DailyCheckinCouponTemplate = typeof dailyCheckinCouponTemplates.$inferSelect;
export type InsertDailyCheckinCouponTemplate = typeof dailyCheckinCouponTemplates.$inferInsert;

/**
 * Configurable reward rules per campaign - daily or milestone, points or
 * coupon. `dedupeKey` is SERVER-GENERATED ONLY (application code must
 * never trust a client-provided value) - see
 * docs/DAILY_CHECKIN_DYNAMIC_REWARDS_DESIGN.md PART A/C for the exact
 * deterministic formats (`daily:points`, `daily:coupon`,
 * `milestone:<day>:once:<kind>`, `milestone:<day>:repeat:<n>:<kind>`) and
 * why a plain (campaignId, ruleType, milestoneDay, rewardKind) composite
 * unique was rejected: `milestoneDay` is NULL for every daily rule, and
 * MySQL/TiDB unique indexes treat each NULL as distinct, so two "daily"
 * rules of the same rewardKind would both insert successfully.
 */
export const dailyCheckinRewardRules = mysqlTable(
  "dailyCheckinRewardRules",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaignId").notNull(),
    ruleType: mysqlEnum("ruleType", ["daily", "milestone"]).notNull(),
    rewardKind: mysqlEnum("rewardKind", ["points", "coupon"]).notNull(),
    milestoneDay: int("milestoneDay"),
    repeatEvery: int("repeatEvery"),
    pointsAmount: decimal("pointsAmount", { precision: 10, scale: 2 }),
    couponTemplateId: int("couponTemplateId"),
    dedupeKey: varchar("dedupeKey", { length: 120 }).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    campaignDedupeIdx: uniqueIndex("dailyCheckinRewardRules_campaign_dedupe_unique").on(
      table.campaignId,
      table.dedupeKey
    ),
    campaignActiveIdx: index("dailyCheckinRewardRules_campaign_active_idx").on(
      table.campaignId,
      table.isActive
    ),
  })
);

export type DailyCheckinRewardRule = typeof dailyCheckinRewardRules.$inferSelect;
export type InsertDailyCheckinRewardRule = typeof dailyCheckinRewardRules.$inferInsert;

/**
 * The immutable, universal reward snapshot/ledger - replaces couponId as
 * the reward representation. Every reward-defining field is duplicated
 * here at grant time so editing/deactivating a rule later can never alter
 * a reward already granted (see the design doc PART A).
 *
 * `couponId`/`pointsTransactionId` are each guarded by their own nullable
 * one-to-one unique index: a points grant always has `couponId = NULL` and
 * a coupon grant always has `pointsTransactionId = NULL` - MySQL/TiDB
 * unique indexes permit multiple NULL-containing rows, so both stay
 * enforced only across their real, non-NULL values (one grant per real
 * coupon, one grant per real points transaction), never across the NULLs.
 *
 * `status`/`usedAt`/`voidedAt` live on the grant, not on the parent
 * `dailyCheckins` row - a single check-in can mint more than one coupon
 * (e.g. a daily coupon and a milestone coupon on the same day), and
 * redeeming one must never mark the other as used. `dailyCheckins.status`/
 * `usedAt` remain legacy-only fields during the transition (see the design
 * doc PART I/L) - new code never reads or writes them.
 */
export const dailyCheckinRewardGrants = mysqlTable(
  "dailyCheckinRewardGrants",
  {
    id: int("id").autoincrement().primaryKey(),
    dailyCheckinId: int("dailyCheckinId").notNull(),
    userId: int("userId").notNull(),
    campaignId: int("campaignId").notNull(),
    ruleId: int("ruleId").notNull(),
    rewardKind: mysqlEnum("rewardKind", ["points", "coupon"]).notNull(),
    grantReason: mysqlEnum("grantReason", ["daily", "milestone"]).notNull(),
    milestoneDay: int("milestoneDay"),
    milestoneInstanceNumber: int("milestoneInstanceNumber"),
    streakCountAtGrant: int("streakCountAtGrant").notNull(),
    pointsAmount: decimal("pointsAmount", { precision: 10, scale: 2 }),
    pointsTransactionId: int("pointsTransactionId"),
    couponId: int("couponId"),
    discountType: mysqlEnum("discountType", ["flat", "percentage"]),
    discountValue: decimal("discountValue", { precision: 10, scale: 2 }),
    maxDiscountAmount: decimal("maxDiscountAmount", { precision: 10, scale: 2 }),
    minPurchaseAmount: decimal("minPurchaseAmount", { precision: 10, scale: 2 }),
    status: mysqlEnum("status", ["granted", "used", "void"]).default("granted").notNull(),
    usedAt: timestamp("usedAt"),
    voidedAt: timestamp("voidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    checkinRuleIdx: uniqueIndex("dailyCheckinRewardGrants_checkin_rule_unique").on(
      table.dailyCheckinId,
      table.ruleId
    ),
    userRuleInstanceIdx: uniqueIndex("dailyCheckinRewardGrants_user_rule_instance_unique").on(
      table.userId,
      table.ruleId,
      table.milestoneInstanceNumber
    ),
    campaignIdx: index("dailyCheckinRewardGrants_campaign_idx").on(table.campaignId),
    userCreatedIdx: index("dailyCheckinRewardGrants_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    statusIdx: index("dailyCheckinRewardGrants_status_idx").on(table.status),
    couponIdIdx: uniqueIndex("dailyCheckinRewardGrants_couponId_unique").on(table.couponId),
    pointsTransactionIdIdx: uniqueIndex("dailyCheckinRewardGrants_pointsTransactionId_unique").on(
      table.pointsTransactionId
    ),
  })
);

export type DailyCheckinRewardGrant = typeof dailyCheckinRewardGrants.$inferSelect;
export type InsertDailyCheckinRewardGrant = typeof dailyCheckinRewardGrants.$inferInsert;

/**
 * Admin Account Recovery Workflow - post-VPS-migration Google-email
 * mismatch case: a legacy Manus/Google account's owner logs in with Google
 * using an email that doesn't match their old account, so a NEW,
 * empty-ish `users` row gets created (or an existing-but-wrong account gets
 * used) instead of resuming their real one. `requesterUserId` is always the
 * CURRENTLY signed-in, Google-linked account making the claim - the
 * requester must have a real `authIdentities` row (see
 * server/services/accountRecoveryService.ts's assessAccountRecoverySafety,
 * which never trusts a claimed email/openId/legacy-user-id alone as
 * approval evidence - every field below except `requesterUserId` is
 * user-asserted context for an admin to review, never itself sufficient to
 * approve anything).
 *
 * `sourceUserId`/`targetUserId` are populated only once an admin has
 * identified (via exact-match search, never fuzzy) which legacy account
 * this recovery is really for, and are set together with a transition to
 * `approved` - see executeAccountRecovery's single transaction. Before
 * that point they stay NULL; the admin UI's "confirm target" step is what
 * fills them in, not this table alone.
 */
export const accountRecoveryRequests = mysqlTable(
  "accountRecoveryRequests",
  {
    id: int("id").autoincrement().primaryKey(),
    // The account making the claim - MUST be the caller's own session user
    // id (server/routers.ts's accountRecovery.create derives this from
    // ctx.user.id, never from client input). No FK - matches this schema's
    // majority convention (orders.userId, purchases.userId, etc. are also
    // plain unenforced ints); see authIdentities.userId's doc comment for
    // the one deliberate exception in this schema.
    requesterUserId: int("requesterUserId").notNull(),
    // Everything below this point is USER-ASSERTED CONTEXT ONLY - entered
    // on the /account/recovery form, shown to the admin for review, and
    // NEVER treated as proof of ownership by
    // assessAccountRecoverySafety/executeAccountRecovery. A manually-typed
    // email/openId/user id is exactly the kind of unverifiable claim this
    // whole workflow exists to NOT trust.
    requestedLegacyUserId: int("requestedLegacyUserId"),
    claimedLegacyEmail: varchar("claimedLegacyEmail", { length: 320 }),
    claimedLegacyOpenId: varchar("claimedLegacyOpenId", { length: 64 }),
    claimedDisplayName: varchar("claimedDisplayName", { length: 255 }),
    evidenceNote: text("evidenceNote"),
    referenceOrderNumber: varchar("referenceOrderNumber", { length: 50 }),
    status: mysqlEnum("status", ["pending", "approved", "rejected", "cancelled", "blocked"])
      .default("pending")
      .notNull(),
    reviewedByAdminId: int("reviewedByAdminId"),
    reviewedAt: timestamp("reviewedAt"),
    // The admin's (or the requester's own, for a self-cancel) reason -
    // required by the tRPC layer for every status transition, never
    // optional at the API boundary even though the column itself is
    // nullable (stays NULL only for the initial "pending" row).
    reviewReason: text("reviewReason"),
    // Set together with status -> "approved" only, inside
    // executeAccountRecovery's transaction - sourceUserId is always exactly
    // requesterUserId (never a second, independently-settable value; kept
    // as its own column rather than reusing requesterUserId purely so the
    // audit trail/admin UI can show "source -> target" without a second
    // join back to this same row).
    sourceUserId: int("sourceUserId"),
    targetUserId: int("targetUserId"),
    // DB-ENFORCED "at most one pending request per requester" - NULL
    // whenever status isn't "pending", equal to requesterUserId while it
    // is. MySQL/MariaDB both allow unlimited NULLs through a UNIQUE index
    // (the exact same technique already used by
    // dailyCheckins.couponId/dailyCheckinRewardGrants.couponId in this
    // schema), so this rejects a genuine double-submit (two concurrent
    // requests from the same user racing past the application-level
    // pre-check in accountRecoveryService.submitAccountRecoveryRequest) at
    // the database layer, without constraining anything once a request
    // leaves "pending". Never read/written directly by application code -
    // purely a constraint-enforcement column.
    pendingRequesterMarker: int("pendingRequesterMarker").generatedAlwaysAs(
      sql`(case when \`status\` = 'pending' then \`requesterUserId\` else NULL end)`,
      { mode: "stored" }
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    requesterUserIdIdx: index("accountRecoveryRequests_requesterUserId_idx").on(table.requesterUserId),
    statusIdx: index("accountRecoveryRequests_status_idx").on(table.status),
    createdAtIdx: index("accountRecoveryRequests_createdAt_idx").on(table.createdAt),
    onePendingPerRequesterUnique: uniqueIndex("accountRecoveryRequests_one_pending_per_requester_unique").on(
      table.pendingRequesterMarker
    ),
  })
);

export type AccountRecoveryRequest = typeof accountRecoveryRequests.$inferSelect;
export type InsertAccountRecoveryRequest = typeof accountRecoveryRequests.$inferInsert;

/**
 * Append-only audit trail for every account-recovery state transition
 * (created/approved/rejected/blocked/cancelled) - server/routers.ts's
 * accountRecovery procedures write exactly one row per transition, inside
 * the SAME transaction as the state change itself for approve (see
 * executeAccountRecovery). `safeMetadata` follows this schema's existing
 * "text column + manual JSON serialization" convention (see
 * walletTopups.extractedData/duplicateStatus) - deliberately never a raw
 * OAuth token, ID token, client secret, or unnecessary Google `sub` (see
 * this table's callers for exactly what is/isn't included).
 */
export const accountRecoveryAuditLogs = mysqlTable(
  "accountRecoveryAuditLogs",
  {
    id: int("id").autoincrement().primaryKey(),
    recoveryRequestId: int("recoveryRequestId").notNull(),
    // Null for the requester's own "created"/"cancelled" actions - only
    // populated for an admin-performed transition.
    actorAdminId: int("actorAdminId"),
    action: varchar("action", { length: 32 }).notNull(),
    sourceUserId: int("sourceUserId"),
    targetUserId: int("targetUserId"),
    authIdentityId: int("authIdentityId"),
    safeMetadata: text("safeMetadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    recoveryRequestIdIdx: index("accountRecoveryAuditLogs_recoveryRequestId_idx").on(table.recoveryRequestId),
    createdAtIdx: index("accountRecoveryAuditLogs_createdAt_idx").on(table.createdAt),
    // A fresh, dedicated audit trail for a brand-new feature - unlike
    // authIdentities.userId (whose FK exists because that table is
    // meaningless once its user is gone), this row's meaning is tied to the
    // recovery REQUEST, not directly to any user row, so only this FK is
    // added ("FK only where safe with the current schema"). ON DELETE
    // CASCADE mirrors authIdentities' own choice for the same reason: an
    // audit row for a deleted request has nothing left to audit.
    recoveryRequestFk: foreignKey({
      name: "accountRecoveryAuditLogs_recoveryRequestId_fk",
      columns: [table.recoveryRequestId],
      foreignColumns: [accountRecoveryRequests.id],
    }).onDelete("cascade"),
  })
);

export type AccountRecoveryAuditLog = typeof accountRecoveryAuditLogs.$inferSelect;
export type InsertAccountRecoveryAuditLog = typeof accountRecoveryAuditLogs.$inferInsert;

/**
 * Advanced Account Merge - Phase 1 (IPE-003) Foundation.
 *
 * Durable case record for a full account merge (source account's economic
 * AND user-owned data folded into a target account) - the path Account
 * Recovery's own empty-source-account invariant routes every non-empty
 * source to (see accountRecoveryService.assessAccountRecoverySafety's
 * blockReasons: "requires Advanced Account Merge, never an automated move").
 *
 * Schema only in this phase - nothing in IPE-003 ever INSERTs a row here.
 * The read-only merge preview (server/services/accountMergePreviewService.ts)
 * computes everything on demand from the source tables directly and never
 * persists a case; this table exists so IPE-005 (Guard & Concurrency) has a
 * durable case identity to lock/lease over, and IPE-006/007/008 have
 * somewhere to record execution progress, without a later migration
 * retrofitting the linkage back onto historical account-recovery evidence.
 *
 * `originAccountRecoveryRequestId` is that linkage: every merge case must
 * trace back to the BLOCKED account-recovery request that could not be
 * auto-resolved (never a bare admin action with no paper trail) - see
 * accountRecoveryRequests' own doc comment for why that request row is
 * preserved forever as historical evidence, never deleted or overwritten by
 * this table. No FK CASCADE here (unlike accountRecoveryAuditLogs'
 * deliberate exception) - a merge case must remain readable even if the
 * originating request row were ever removed, matching this schema's default
 * convention (see e.g. purchases.orderId).
 *
 * `status` intentionally stops at the coarse workflow shape a Foundation
 * phase can commit to without guessing at IPE-005's locking mechanism or
 * IPE-006/007's per-domain progress tracking - those add their OWN columns
 * (guard/lock fields, per-phase completion) in their own migrations rather
 * than this one reaching ahead of scope to design them now.
 */
export const accountMergeCases = mysqlTable(
  "accountMergeCases",
  {
    id: int("id").autoincrement().primaryKey(),
    originAccountRecoveryRequestId: int("originAccountRecoveryRequestId").notNull(),
    sourceUserId: int("sourceUserId").notNull(),
    targetUserId: int("targetUserId").notNull(),
    status: mysqlEnum("status", ["pending", "in_progress", "completed", "failed", "cancelled"])
      .default("pending")
      .notNull(),
    // IPE-005 durable Source-account write guard. Every status except
    // `cancelled` keeps the Source guarded; `completed` and `failed` remain
    // fail-closed so a stale session can never create new classified data on
    // the former Source after the merge lifecycle has advanced. MySQL's
    // UNIQUE+NULL semantics let cancelled historical cases coexist while
    // enforcing at most one guarded case per Source at the database layer.
    guardedSourceMarker: int("guardedSourceMarker").generatedAlwaysAs(
      sql`(case when \`status\` <> 'cancelled' then \`sourceUserId\` else NULL end)`,
      { mode: "stored" }
    ),
    createdByAdminId: int("createdByAdminId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    failedAt: timestamp("failedAt"),
    failureReason: text("failureReason"),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: text("cancelReason"),
  },
  (table) => ({
    originRequestIdx: index("accountMergeCases_originAccountRecoveryRequestId_idx").on(
      table.originAccountRecoveryRequestId
    ),
    sourceUserIdIdx: index("accountMergeCases_sourceUserId_idx").on(table.sourceUserId),
    targetUserIdIdx: index("accountMergeCases_targetUserId_idx").on(table.targetUserId),
    statusIdx: index("accountMergeCases_status_idx").on(table.status),
    oneGuardedCasePerSourceUnique: uniqueIndex("accountMergeCases_one_guarded_per_source_unique").on(
      table.guardedSourceMarker
    ),
  })
);

export type AccountMergeCase = typeof accountMergeCases.$inferSelect;
export type InsertAccountMergeCase = typeof accountMergeCases.$inferInsert;

/**
 * Append-only audit trail for the Advanced Account Merge feature - same
 * "text column + manual JSON serialization" convention as
 * accountRecoveryAuditLogs.safeMetadata, and the same append-only-by-
 * construction guarantee (no update/delete API is ever added for rows
 * here - see accountRecoveryAuditLogs' identical note). `mergeCaseId` is
 * nullable because a "previewed" event can happen before any
 * accountMergeCases row exists at all (this phase's preview never creates
 * one - see accountMergeCases' own doc comment); later phases populate it
 * once a real case exists.
 */
export const accountMergeAuditLogs = mysqlTable(
  "accountMergeAuditLogs",
  {
    id: int("id").autoincrement().primaryKey(),
    mergeCaseId: int("mergeCaseId"),
    actorAdminId: int("actorAdminId"),
    action: varchar("action", { length: 32 }).notNull(),
    sourceUserId: int("sourceUserId"),
    targetUserId: int("targetUserId"),
    safeMetadata: text("safeMetadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    mergeCaseIdIdx: index("accountMergeAuditLogs_mergeCaseId_idx").on(table.mergeCaseId),
    sourceUserIdIdx: index("accountMergeAuditLogs_sourceUserId_idx").on(table.sourceUserId),
    targetUserIdIdx: index("accountMergeAuditLogs_targetUserId_idx").on(table.targetUserId),
    createdAtIdx: index("accountMergeAuditLogs_createdAt_idx").on(table.createdAt),
  })
);

export type AccountMergeAuditLog = typeof accountMergeAuditLogs.$inferSelect;
export type InsertAccountMergeAuditLog = typeof accountMergeAuditLogs.$inferInsert;

/**
 * Durable once-only receipt for IPE-006 financial reconciliation.
 *
 * One merge case may reconcile Wallet + Points exactly once. The UNIQUE
 * mergeCaseId constraint is the database-level idempotency barrier; the
 * service also serializes on the canonical Source/Target users rows and the
 * merge-case row before inspecting this receipt. Because this row is inserted
 * in the same transaction as all wallet/points balance and ledger writes,
 * either every financial effect plus this receipt commits, or none of them do.
 *
 * Historical walletTransactions, walletTopups and pointsTransactions rows are
 * never re-parented or rewritten. The before/after snapshots here make the
 * exact value movement independently auditable without changing that history.
 */
export const accountMergeFinancialReconciliations = mysqlTable(
  "accountMergeFinancialReconciliations",
  {
    id: int("id").autoincrement().primaryKey(),
    mergeCaseId: int("mergeCaseId").notNull(),
    sourceUserId: int("sourceUserId").notNull(),
    targetUserId: int("targetUserId").notNull(),
    actorAdminId: int("actorAdminId").notNull(),
    walletSourceBefore: decimal("walletSourceBefore", { precision: 12, scale: 2 }).notNull(),
    walletTargetBefore: decimal("walletTargetBefore", { precision: 12, scale: 2 }).notNull(),
    walletTransferred: decimal("walletTransferred", { precision: 12, scale: 2 }).notNull(),
    walletSourceAfter: decimal("walletSourceAfter", { precision: 12, scale: 2 }).notNull(),
    walletTargetAfter: decimal("walletTargetAfter", { precision: 12, scale: 2 }).notNull(),
    pointsSourceBefore: decimal("pointsSourceBefore", { precision: 10, scale: 2 }).notNull(),
    pointsTargetBefore: decimal("pointsTargetBefore", { precision: 10, scale: 2 }).notNull(),
    pointsTransferred: decimal("pointsTransferred", { precision: 10, scale: 2 }).notNull(),
    pointsSourceAfter: decimal("pointsSourceAfter", { precision: 10, scale: 2 }).notNull(),
    pointsTargetAfter: decimal("pointsTargetAfter", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    mergeCaseUnique: uniqueIndex("accountMergeFinancialReconciliations_mergeCaseId_unique").on(table.mergeCaseId),
    sourceUserIdIdx: index("accountMergeFinancialReconciliations_sourceUserId_idx").on(table.sourceUserId),
    targetUserIdIdx: index("accountMergeFinancialReconciliations_targetUserId_idx").on(table.targetUserId),
  })
);

export type AccountMergeFinancialReconciliation = typeof accountMergeFinancialReconciliations.$inferSelect;
export type InsertAccountMergeFinancialReconciliation = typeof accountMergeFinancialReconciliations.$inferInsert;

/**
 * Append-only audit trail for the Admin Users Management page - one row per
 * name/role edit or hard delete performed through admin.users.update /
 * admin.users.delete (server/routers.ts). Deliberately NO foreign key from
 * targetUserId to users.id (unlike authIdentities.userId's deliberate
 * exception - see that column's own doc comment) - this row must remain
 * readable after its target user is hard-deleted, which a CASCADE or a
 * plain FK constraint would either destroy or block outright.
 *
 * `safeMetadata` follows this schema's existing "text column + manual JSON
 * serialization" convention (see accountRecoveryAuditLogs.safeMetadata) -
 * only ever field names changed, old/new role, googleConnected, and a
 * privacy-free summary of a delete-safety assessment. Never an email, a
 * name (old or new), an openId, a Google subject, a password hash, or a
 * token/secret - see server/services/adminUserAuditLog.ts for the single
 * place that builds this value.
 *
 * There is deliberately no update/delete API for rows in this table -
 * append-only is enforced by never writing one, not by a DB permission.
 */
export const adminUserAuditLogs = mysqlTable(
  "adminUserAuditLogs",
  {
    id: int("id").autoincrement().primaryKey(),
    actorAdminId: int("actorAdminId").notNull(),
    targetUserId: int("targetUserId").notNull(),
    action: mysqlEnum("action", ["update_name", "update_role", "delete_user"]).notNull(),
    reason: text("reason").notNull(),
    safeMetadata: text("safeMetadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    actorAdminIdIdx: index("adminUserAuditLogs_actorAdminId_idx").on(table.actorAdminId),
    targetUserIdIdx: index("adminUserAuditLogs_targetUserId_idx").on(table.targetUserId),
    createdAtIdx: index("adminUserAuditLogs_createdAt_idx").on(table.createdAt),
  })
);

export type AdminUserAuditLog = typeof adminUserAuditLogs.$inferSelect;
export type InsertAdminUserAuditLog = typeof adminUserAuditLogs.$inferInsert;

/**
 * Global anti-replay claim registry for payment slips.
 *
 * INVARIANT: ONE REAL BANK TRANSACTION CAN CREATE FINANCIAL VALUE ONCE.
 *
 * Before this table, duplicate detection was a SELECT-then-decide read over
 * per-user, pending-only data, which was unsafe in three separate ways:
 *   1. Wallet duplicate lookups were scoped to a single userId, so the same
 *      slip could be replayed by a DIFFERENT user.
 *   2. Order-payment lookups scanned only PENDING payments, so a slip that
 *      had already been APPROVED was invisible and could be reused.
 *   3. A read followed by a write is a race: two concurrent submissions can
 *      both observe "no duplicate" and both create value.
 *
 * A row here is a CLAIM on a strong identifier, inserted inside the SAME
 * transaction that finalizes the money. Uniqueness is enforced by the
 * DATABASE, so concurrency is resolved by the engine rather than by
 * application timing: of two racing claimants exactly one commits and the
 * other gets a duplicate-key error and is routed to manual review.
 *
 * Only STRONG identifiers appear here. `semanticFingerprint` is deliberately
 * NOT unique and NOT a claim - a customer may legitimately send the same
 * amount from the same account twice in one day, so treating that shape as
 * proof would block real payments. It is stored purely as a review signal.
 *
 * NULL handling: MySQL/MariaDB UNIQUE indexes permit multiple NULLs, which
 * is exactly the behavior needed - a slip with no readable reference simply
 * does not claim the reference slot, and never collides with other
 * reference-less slips.
 *
 * Append-only in practice: rows are inserted when value is created and are
 * never rewritten. There is no FK to users/orders/walletTopups because the
 * registry must outlive and span both financial sources.
 */
export const paymentSlipClaims = mysqlTable(
  "paymentSlipClaims",
  {
    id: int("id").autoincrement().primaryKey(),
    /** Which financial flow consumed the slip. */
    sourceType: mysqlEnum("sourceType", ["order_payment", "wallet_topup"]).notNull(),
    /** payments.id or walletTopups.id, depending on sourceType. */
    sourceId: int("sourceId").notNull(),
    /** Owner of the claiming submission - for admin traceability only. */
    userId: int("userId").notNull(),
    /** SHA-256 of the normalized bank transaction reference. */
    referenceHash: varchar("referenceHash", { length: 64 }),
    /**
     * ADVISORY legacy ambiguity marker - NOT an anti-replay authority.
     *
     * Set ONLY on backfilled historical rows whose original reference casing
     * is unrecoverable: they were persisted with just an upper-cased
     * `reference` and carry no `referenceRaw`, no stored hash and no
     * reparsable `rawText`. For those rows the true reference can never be
     * reconstructed, so a fresh mixed-case read of the same transaction
     * cannot be matched by `referenceHash`.
     *
     * NULL for everything else - every modern submission, and every legacy
     * row whose casing WAS recoverable. A normal new claim must never write
     * this field.
     *
     * Deliberately NULLABLE, INDEXED and NON-UNIQUE, and deliberately never a
     * claim: upper-casing is LOSSY, so two genuinely different
     * case-sensitive references legitimately fold together here. Treating a
     * hit as ownership would make one of two real transactions permanently
     * unapprovable. A hit is therefore advisory evidence that STOPS auto
     * approval and routes to an explicit admin resolution
     * (LEGACY_REFERENCE_CASE_AMBIGUITY) - it is never
     * `already_claimed`, never a duplicate verdict, and never auto-rejects.
     *
     * The real anti-replay authorities remain the UNIQUE case-preserving
     * `referenceHash`, `fileHash` and `qrPayloadHash` above.
     */
    legacyReferenceUpperHash: varchar("legacyReferenceUpperHash", { length: 64 }),
    fileHash: varchar("fileHash", { length: 64 }),
    /** SHA-256 of the decoded slip QR payload, when decoding is available. */
    qrPayloadHash: varchar("qrPayloadHash", { length: 64 }),
    /** WEAK signal. Indexed for lookup, deliberately NOT unique. */
    semanticFingerprint: varchar("semanticFingerprint", { length: 64 }),
    claimedAt: timestamp("claimedAt").defaultNow().notNull(),
  },
  (table) => ({
    // The three strong-identifier locks. These are what actually enforce
    // "once", globally across orders AND wallet top-ups AND users.
    referenceHashUnique: uniqueIndex("paymentSlipClaims_referenceHash_unique").on(
      table.referenceHash
    ),
    fileHashUnique: uniqueIndex("paymentSlipClaims_fileHash_unique").on(table.fileHash),
    qrPayloadHashUnique: uniqueIndex("paymentSlipClaims_qrPayloadHash_unique").on(
      table.qrPayloadHash
    ),
    // Non-unique: weak evidence is looked up, never enforced.
    // Non-unique by design: the alias is a lossy ADVISORY lookup, never an
    // enforced constraint. Many legitimate rows may share one value.
    legacyReferenceUpperHashIdx: index("paymentSlipClaims_legacyReferenceUpperHash_idx").on(
      table.legacyReferenceUpperHash
    ),
    semanticFingerprintIdx: index("paymentSlipClaims_semanticFingerprint_idx").on(
      table.semanticFingerprint
    ),
    // "Which submission consumed this slip?" for the admin duplicate panel.
    sourceIdx: index("paymentSlipClaims_source_idx").on(table.sourceType, table.sourceId),
    userIdIdx: index("paymentSlipClaims_userId_idx").on(table.userId),
  })
);

export type PaymentSlipClaim = typeof paymentSlipClaims.$inferSelect;
export type InsertPaymentSlipClaim = typeof paymentSlipClaims.$inferInsert;

/**
 * Durable record of a KNOWN historical strong-identifier collision.
 *
 * ── Why this exists (IPE-004 hotfix) ──────────────────────────────────────
 * The backfill's dry-run audit found 114 real cases where TWO OR MORE
 * approved historical records (order payments and/or wallet top-ups) share
 * the exact same referenceHash or fileHash (85 on reference, 29 on file).
 * Each is a genuine finding - a historical double-credit or a parser
 * artifact - and the backfill correctly refuses to auto-resolve it by
 * picking a winner: doing so would fabricate uniqueness over financial
 * history, which is explicitly out of scope.
 *
 * This table is where that refusal is made DURABLE instead of forcing every
 * future approval to rediscover the same fact via a live O(N) scan. Every
 * member of a colliding group (both/all historical sources that share the
 * hash) is recorded here, one row per (kind, identifierHash, source). A new
 * submission whose own strong identifier hash matches a row here is blocked
 * from auto-approval via one indexed lookup - `known_collision` - the same
 * fail-closed outcome the group already deserved, without ever touching or
 * re-deriving the historical rows themselves.
 *
 * NEVER written to by a live approval. Only the backfill tool
 * (scripts/backfill-slip-claims.mjs) inserts here, and only for identifiers
 * it found colliding across two or more ALREADY-APPROVED historical rows.
 */
export const paymentSlipLegacyCollisions = mysqlTable(
  "paymentSlipLegacyCollisions",
  {
    id: int("id").autoincrement().primaryKey(),
    kind: mysqlEnum("kind", ["reference", "file", "qr"]).notNull(),
    identifierHash: varchar("identifierHash", { length: 64 }).notNull(),
    sourceType: mysqlEnum("sourceType", ["order_payment", "wallet_topup"]).notNull(),
    sourceId: int("sourceId").notNull(),
    recordedAt: timestamp("recordedAt").defaultNow().notNull(),
  },
  (table) => ({
    memberUnique: uniqueIndex("paymentSlipLegacyCollisions_member_unique").on(
      table.kind,
      table.identifierHash,
      table.sourceType,
      table.sourceId
    ),
    identifierHashIdx: index("paymentSlipLegacyCollisions_identifierHash_idx").on(
      table.kind,
      table.identifierHash
    ),
  })
);

export type PaymentSlipLegacyCollision = typeof paymentSlipLegacyCollisions.$inferSelect;
export type InsertPaymentSlipLegacyCollision = typeof paymentSlipLegacyCollisions.$inferInsert;

/**
 * Durable record that a historical approved row's file identity is
 * PERMANENTLY UNKNOWN - most commonly because it predates slip image storage
 * entirely (`no_slip_image_url`: the row has no slipImageUrl at all, so its
 * bytes can never be recovered from anywhere).
 *
 * ── Why this is its own explicit state, not "safe" and not "blocked" ──────
 * An unrecoverable historical row is neither proof of safety (we have zero
 * evidence it differs from any future submission) nor proof of a conflict
 * (we have zero evidence it matches one either). Collapsing it into either
 * extreme is wrong: treating it as safe could reopen replay for that one
 * historical transaction; treating it as blocking would fail every
 * completely unrelated future approval forever, for a fact about data that
 * can never be resolved - which is exactly the production incident this
 * migration fixes.
 *
 * So it gets a third, explicit bucket. A row's row here means: "classified,
 * permanently unresolvable, on file so an operator can see it - and NEVER
 * consulted to block or approve anything." Recording it here (versus
 * leaving it out entirely) is what lets the backfill be marked COMPLETE:
 * completion requires every historical row to land in one of protected /
 * collision / unknown, never a fourth "silently skipped" state.
 */
export const paymentSlipLegacyUnknown = mysqlTable(
  "paymentSlipLegacyUnknown",
  {
    id: int("id").autoincrement().primaryKey(),
    sourceType: mysqlEnum("sourceType", ["order_payment", "wallet_topup"]).notNull(),
    sourceId: int("sourceId").notNull(),
    /** Fixed reason code only - e.g. "no_slip_image_url". Never a URL or secret. */
    reason: varchar("reason", { length: 64 }).notNull(),
    recordedAt: timestamp("recordedAt").defaultNow().notNull(),
  },
  (table) => ({
    sourceUnique: uniqueIndex("paymentSlipLegacyUnknown_source_unique").on(
      table.sourceType,
      table.sourceId
    ),
    sourceTypeIdx: index("paymentSlipLegacyUnknown_sourceType_idx").on(table.sourceType),
  })
);

export type PaymentSlipLegacyUnknown = typeof paymentSlipLegacyUnknown.$inferSelect;
export type InsertPaymentSlipLegacyUnknown = typeof paymentSlipLegacyUnknown.$inferInsert;

/**
 * Persistent OCR attempt history (automatic submissions + admin rechecks).
 *
 * Answers the question an admin previously could not answer from the UI:
 * "did this fail because the OCR provider broke, or because the slip data
 * was genuinely wrong?" Each attempt records which stage it reached and a
 * typed result, so a provider outage is never mistaken for a bad slip.
 *
 * SANITIZED DIAGNOSTICS ONLY. This table must never receive an API key, an
 * Authorization header, an LLM endpoint carrying credentials, a signed R2
 * URL, base64 image data, or a raw upstream error body. `providerHttpStatus`
 * and `providerAttemptCount` are the only provider-side facts kept, which is
 * enough to distinguish a 503-after-3-retries from a 401 misconfiguration.
 *
 * Raw OCR text is intentionally NOT duplicated here - payments.extractedData
 * already stores the extracted financial evidence, and copying PII-bearing
 * slip text per attempt would multiply the sensitive footprint for no
 * diagnostic gain.
 *
 * subjectType is an enum rather than an order-only column so wallet top-up
 * rechecks can be added later without a schema migration.
 */
export const ocrVerificationAttempts = mysqlTable(
  "ocrVerificationAttempts",
  {
    id: int("id").autoincrement().primaryKey(),
    subjectType: mysqlEnum("subjectType", ["order_payment", "wallet_topup"]).notNull(),
    /** payments.id or walletTopups.id. */
    subjectId: int("subjectId").notNull(),
    /** 1-based, monotonically increasing per subject. */
    attemptNo: int("attemptNo").notNull().default(1),
    trigger: mysqlEnum("trigger", ["automatic", "admin_recheck"]).notNull(),
    /** Admin who requested a recheck; NULL for automatic submissions. */
    initiatedByUserId: int("initiatedByUserId"),
    startedAt: timestamp("startedAt").notNull(),
    completedAt: timestamp("completedAt"),
    /** "generic" | "legacy_forge" - runtime mode only, never an endpoint. */
    providerMode: varchar("providerMode", { length: 32 }),
    providerModel: varchar("providerModel", { length: 128 }),
    providerHttpStatus: int("providerHttpStatus"),
    providerAttemptCount: int("providerAttemptCount").notNull().default(0),
    /** How far the pipeline got before stopping. */
    stage: mysqlEnum("stage", [
      "image_preparation",
      "provider_call",
      "response_parse",
      "field_extraction",
      "verification",
      "completed",
    ]).notNull(),
    result: mysqlEnum("result", [
      "auto_approved",
      "needs_review",
      "technical_failure",
      "config_blocked",
    ]).notNull(),
    /** TECHNICAL | DATA | CONFIG - see OcrDiagnosticCategory. */
    reviewCategory: varchar("reviewCategory", { length: 32 }),
    /** Stable reason code, e.g. MISSING_REFERENCE / PROVIDER_RATE_LIMIT. */
    reviewReason: varchar("reviewReason", { length: 64 }),
    /** NULL means the provider never reported one - distinct from 0. */
    confidence: int("confidence"),
    /** Sanitized JSON snapshot of the verification checklist. No raw text. */
    verificationSnapshot: text("verificationSnapshot"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    subjectIdx: index("ocrVerificationAttempts_subject_idx").on(
      table.subjectType,
      table.subjectId
    ),
    createdAtIdx: index("ocrVerificationAttempts_createdAt_idx").on(table.createdAt),
    initiatedByIdx: index("ocrVerificationAttempts_initiatedByUserId_idx").on(
      table.initiatedByUserId
    ),
  })
);

export type OcrVerificationAttempt = typeof ocrVerificationAttempts.$inferSelect;
export type InsertOcrVerificationAttempt = typeof ocrVerificationAttempts.$inferInsert;

/**
 * Audited human resolutions of a LEGACY REFERENCE CASE AMBIGUITY.
 *
 * When a new submission's upper-cased reference matches a historical row's
 * `legacyReferenceUpperHash`, auto-approval stops. The match is lossy, so it
 * proves nothing: the two may be one replayed transaction, or two genuinely
 * different references that merely fold together. Only a human can decide.
 *
 * This table records that decision explicitly rather than burying it in a
 * generic approval note, because it is the one place a human overrides an
 * automated anti-replay signal and that must stay auditable.
 *
 * The uniqueness rule is on the SUBJECT, not the alias: multiple legitimate
 * payments may share one lossy alias and each may be resolved independently.
 * Constraining the alias would recreate the dead-end this design removes.
 *
 * Never stores slip bytes, credentials, or a raw reference belonging to
 * another user's payment.
 */
export const paymentSlipReviewResolutions = mysqlTable(
  "paymentSlipReviewResolutions",
  {
    id: int("id").autoincrement().primaryKey(),
    subjectType: mysqlEnum("subjectType", ["order_payment", "wallet_topup"]).notNull(),
    /** payments.id or walletTopups.id. */
    subjectId: int("subjectId").notNull(),
    resolutionType: mysqlEnum("resolutionType", [
      "legacy_case_confirmed_distinct",
      "legacy_case_confirmed_duplicate",
    ]).notNull(),
    /** The historical record the alias matched, for traceability. */
    matchedSourceType: mysqlEnum("matchedSourceType", ["order_payment", "wallet_topup"]),
    matchedSourceId: int("matchedSourceId"),
    /** The lossy alias that triggered the review. Advisory context only. */
    legacyAliasHash: varchar("legacyAliasHash", { length: 64 }),
    /**
     * The EXACT case-preserving reference hash the admin adjudicated.
     *
     * The alias above identifies only the historical FOLD, and folding is
     * lossy: `abc123` and `AbC123` share it. Without this, a resolution row
     * cannot say WHICH case-preserving reference a human actually approved,
     * and a casing-only change between review and approval was
     * indistinguishable from no change at all.
     *
     * Nullable for rows written before this field existed. Never a secret -
     * a salted-free SHA of a bank reference, exactly like every other hash
     * in this schema.
     */
    adjudicatedReferenceHash: varchar("adjudicatedReferenceHash", { length: 64 }),
    adminUserId: int("adminUserId").notNull(),
    /** Mandatory, non-empty operator justification. */
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // One resolution per subject: a second attempt must not silently create a
    // parallel decision. Enforced on the SUBJECT, never on the lossy alias.
    subjectUnique: uniqueIndex("paymentSlipReviewResolutions_subject_unique").on(
      table.subjectType,
      table.subjectId
    ),
    adminUserIdIdx: index("paymentSlipReviewResolutions_adminUserId_idx").on(table.adminUserId),
    createdAtIdx: index("paymentSlipReviewResolutions_createdAt_idx").on(table.createdAt),
  })
);

export type PaymentSlipReviewResolution = typeof paymentSlipReviewResolutions.$inferSelect;
export type InsertPaymentSlipReviewResolution =
  typeof paymentSlipReviewResolutions.$inferInsert;
