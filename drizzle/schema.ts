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
// One bank transaction may fund one order payment or wallet top-up.
export const paymentProviderClaims = mysqlTable("paymentProviderClaims", {
 claimKey: varchar("claimKey", { length: 64 }).primaryKey(),
 subjectType: varchar("subjectType", { length: 16 }).notNull(),
 subjectId: int("subjectId").notNull(),
 createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
  approvalSource: mysqlEnum("approvalSource", ["manual", "ocr_auto", "provider_auto"]).default("manual"),
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
 * Sports competition catalog. A competition is an organizational layer for
 * Sports Vote fixtures (league/cup); it intentionally does not implement
 * standings, bracket progression, or result engines.
 */
export const sportsCompetitions = mysqlTable(
  "sportsCompetitions",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    competitionType: mysqlEnum("competitionType", ["league", "cup"]).default("league").notNull(),
    logoImageUrl: text("logoImageUrl"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    codeUnique: uniqueIndex("sportsCompetitions_code_unique").on(table.code),
    nameIdx: index("sportsCompetitions_name_idx").on(table.name),
    activeIdx: index("sportsCompetitions_isActive_idx").on(table.isActive),
  })
);

export type SportsCompetition = typeof sportsCompetitions.$inferSelect;
export type InsertSportsCompetition = typeof sportsCompetitions.$inferInsert;

/** Canonical reusable sports team identity and logo asset. */
export const sportsTeams = mysqlTable(
  "sportsTeams",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    logoImageUrl: text("logoImageUrl"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    codeUnique: uniqueIndex("sportsTeams_code_unique").on(table.code),
    nameIdx: index("sportsTeams_name_idx").on(table.name),
    activeIdx: index("sportsTeams_isActive_idx").on(table.isActive),
  })
);

export type SportsTeam = typeof sportsTeams.$inferSelect;
export type InsertSportsTeam = typeof sportsTeams.$inferInsert;

/** Many-to-many membership: one canonical team can join many competitions. */
export const sportsCompetitionTeams = mysqlTable(
  "sportsCompetitionTeams",
  {
    id: int("id").autoincrement().primaryKey(),
    competitionId: int("competitionId").notNull(),
    teamId: int("teamId").notNull(),
    displayOrder: int("displayOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    membershipUnique: uniqueIndex("sportsCompetitionTeams_competition_team_unique").on(
      table.competitionId,
      table.teamId
    ),
    competitionIdx: index("sportsCompetitionTeams_competitionId_idx").on(table.competitionId),
    teamIdx: index("sportsCompetitionTeams_teamId_idx").on(table.teamId),
  })
);

export type SportsCompetitionTeam = typeof sportsCompetitionTeams.$inferSelect;
export type InsertSportsCompetitionTeam = typeof sportsCompetitionTeams.$inferInsert;

/**
 * Sports Matches (Football prediction voting)
 * New matches reference a competition and canonical team records, while the
 * legacy name/image columns remain populated snapshots for backward-compatible
 * reads and historical records created before the catalog existed.
 */
export const sportsMatches = mysqlTable(
  "sportsMatches",
  {
    id: int("id").autoincrement().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    leagueName: varchar("leagueName", { length: 255 }),
    competitionId: int("competitionId"),
    homeTeamId: int("homeTeamId"),
    awayTeamId: int("awayTeamId"),

    homeTeamName: varchar("homeTeamName", { length: 255 }).notNull(),
    awayTeamName: varchar("awayTeamName", { length: 255 }).notNull(),
    homeTeamImageUrl: text("homeTeamImageUrl"),
    awayTeamImageUrl: text("awayTeamImageUrl"),
    coverImageUrl: text("coverImageUrl"),

    matchStartAt: timestamp("matchStartAt"),
    voteDeadlineAt: timestamp("voteDeadlineAt").notNull(),

    voteCostPoints: decimal("voteCostPoints", { precision: 10, scale: 2 }).default("0.00").notNull(),

    rewardKind: mysqlEnum("rewardKind", ["coupon", "points"]).default("coupon").notNull(),
    rewardPointsAmount: decimal("rewardPointsAmount", { precision: 10, scale: 2 }),
    rewardDiscountType: mysqlEnum("rewardDiscountType", ["flat", "percentage"]),
    rewardDiscountValue: decimal("rewardDiscountValue", { precision: 10, scale: 2 }),
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
    competitionIdx: index("sportsMatches_competitionId_idx").on(table.competitionId),
    homeTeamIdx: index("sportsMatches_homeTeamId_idx").on(table.homeTeamId),
    awayTeamIdx: index("sportsMatches_awayTeamId_idx").on(table.awayTeamId),
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
    rewardKind: mysqlEnum("rewardKind", ["coupon", "points"]).default("coupon").notNull(),
    couponId: int("couponId"),
    pointsAmount: decimal("pointsAmount", { precision: 10, scale: 2 }),
    pointsTransactionId: int("pointsTransactionId"),

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
    uniquePointsTransactionId: uniqueIndex("unique_sports_match_rewards_points_tx").on(table.pointsTransactionId),
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
 * Durable once-only receipt for IPE-007 entitlement/user-data reconciliation.
 * The UNIQUE mergeCaseId is the database-level retry/concurrency barrier,
 * mirroring IPE-006's financial receipt. `safeSummary` contains aggregate
 * action counts only; per-row duplicate consolidation evidence lives in the
 * append-only accountMergeDataDedupeRecords table below so large accounts do
 * not risk overflowing one TEXT receipt.
 */
export const accountMergeDataReconciliations = mysqlTable(
  "accountMergeDataReconciliations",
  {
    id: int("id").autoincrement().primaryKey(),
    mergeCaseId: int("mergeCaseId").notNull(),
    sourceUserId: int("sourceUserId").notNull(),
    targetUserId: int("targetUserId").notNull(),
    actorAdminId: int("actorAdminId").notNull(),
    safeSummary: text("safeSummary").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    mergeCaseUnique: uniqueIndex("accountMergeDataReconciliations_mergeCaseId_unique").on(table.mergeCaseId),
    sourceUserIdIdx: index("accountMergeDataReconciliations_sourceUserId_idx").on(table.sourceUserId),
    targetUserIdIdx: index("accountMergeDataReconciliations_targetUserId_idx").on(table.targetUserId),
  })
);

export type AccountMergeDataReconciliation = typeof accountMergeDataReconciliations.$inferSelect;
export type InsertAccountMergeDataReconciliation = typeof accountMergeDataReconciliations.$inferInsert;

/**
 * Immutable mapping for rows intentionally collapsed because both accounts
 * already owned the same logical access/user-data key. `sourceRowId` and
 * `targetRowId` are origin identities: they always mean the row that belonged
 * to the Source account and the row that belonged to the Target account before
 * reconciliation. They do NOT imply which row survives. Domain-specific
 * survivor/removal details belong in `safeMetadata` when the survivor can vary.
 * No user-id columns are stored here: participant identity is recovered from
 * the parent accountMergeDataReconciliations/accountMergeCases receipt.
 */
export const accountMergeDataDedupeRecords = mysqlTable(
  "accountMergeDataDedupeRecords",
  {
    id: int("id").autoincrement().primaryKey(),
    mergeCaseId: int("mergeCaseId").notNull(),
    domain: varchar("domain", { length: 40 }).notNull(),
    sourceRowId: int("sourceRowId").notNull(),
    targetRowId: int("targetRowId").notNull(),
    keySummary: varchar("keySummary", { length: 255 }).notNull(),
    safeMetadata: text("safeMetadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    caseIdx: index("accountMergeDataDedupeRecords_mergeCaseId_idx").on(table.mergeCaseId),
    sourceUnique: uniqueIndex("accountMergeDataDedupeRecords_case_domain_source_unique").on(
      table.mergeCaseId,
      table.domain,
      table.sourceRowId
    ),
  })
);

export type AccountMergeDataDedupeRecord = typeof accountMergeDataDedupeRecords.$inferSelect;
export type InsertAccountMergeDataDedupeRecord = typeof accountMergeDataDedupeRecords.$inferInsert;

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

/** IpeNovel Workspace M01 bounded collaboration root. */
export const workspaceWorkspaces = mysqlTable(
  "workspaceWorkspaces",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    ownerUserId: int("ownerUserId").notNull(),
    status: mysqlEnum("status", ["active", "suspended", "archived"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => ({
    ownerStatusIdx: index("workspaceWorkspaces_owner_status_idx").on(table.ownerUserId, table.status),
    ownerUserFk: foreignKey({
      name: "workspaceWorkspaces_ownerUserId_users_id_fk",
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
    }),
  })
);

export const workspaceMembers = mysqlTable(
  "workspaceMembers",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    role: mysqlEnum("role", ["owner", "editor", "reviewer", "viewer"]).notNull(),
    status: mysqlEnum("status", ["active", "invited", "suspended", "removed"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    workspaceUserUnique: uniqueIndex("workspaceMembers_workspace_user_unique").on(table.workspaceId, table.userId),
    userStatusIdx: index("workspaceMembers_user_status_idx").on(table.userId, table.status),
    workspaceFk: foreignKey({
      name: "workspaceMembers_workspaceId_workspaceWorkspaces_id_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
    userFk: foreignKey({
      name: "workspaceMembers_userId_users_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }),
  })
);

/** Read-only association to the current publication novel; M01 has no episode write path. */
export const workspaceNovels = mysqlTable(
  "workspaceNovels",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    novelId: int("novelId").notNull(),
    status: mysqlEnum("status", ["active", "paused", "unlinked"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    workspaceNovelUnique: uniqueIndex("workspaceNovels_workspace_novel_unique").on(table.workspaceId, table.novelId),
    novelStatusIdx: index("workspaceNovels_novel_status_idx").on(table.novelId, table.status),
    workspaceFk: foreignKey({
      name: "workspaceNovels_workspaceId_workspaceWorkspaces_id_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
    novelFk: foreignKey({
      name: "workspaceNovels_novelId_novels_id_fk",
      columns: [table.novelId],
      foreignColumns: [novels.id],
    }),
  })
);

/**
 * Synthetic, read-only source binding used only to prove the M01 contract.
 * M02 replaces this with authenticated Google document bindings; no provider
 * document ID, OAuth credential, or document body can be written here.
 */
export const workspaceReadOnlyBindings = mysqlTable(
  "workspaceReadOnlyBindings",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceNovelId: int("workspaceNovelId").notNull(),
    sourceKind: mysqlEnum("sourceKind", ["synthetic"]).default("synthetic").notNull(),
    sourceKey: varchar("sourceKey", { length: 255 }).notNull(),
    displayName: varchar("displayName", { length: 500 }).notNull(),
    role: mysqlEnum("role", ["source", "chapter", "glossary", "reference"]).default("source").notNull(),
    sequence: int("sequence").default(1).notNull(),
    status: mysqlEnum("status", ["active", "paused", "removed"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    workspaceNovelSourceUnique: uniqueIndex("workspaceReadOnlyBindings_novel_source_unique").on(
      table.workspaceNovelId,
      table.sourceKind,
      table.sourceKey
    ),
    workspaceNovelRoleSequenceUnique: uniqueIndex("workspaceReadOnlyBindings_novel_role_sequence_unique").on(
      table.workspaceNovelId,
      table.role,
      table.sequence
    ),
    workspaceNovelFk: foreignKey({
      name: "wrob_workspace_novel_fk",
      columns: [table.workspaceNovelId],
      foreignColumns: [workspaceNovels.id],
    }).onDelete("cascade"),
  })
);

/** M01 initializes all capability ownership to Sheets and exposes no mutator. */
export const workspaceMigrationRegistry = mysqlTable(
  "workspaceMigrationRegistry",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceNovelId: int("workspaceNovelId").notNull(),
    capability: mysqlEnum("capability", ["kanban", "checker", "ai_queue", "export", "publish"]).notNull(),
    owner: mysqlEnum("owner", ["sheets", "workspace", "paused"]).default("sheets").notNull(),
    cutoverEpoch: int("cutoverEpoch").default(0).notNull(),
    version: int("version").default(1).notNull(),
    changedAt: timestamp("changedAt").defaultNow().notNull(),
    changedBy: int("changedBy"),
  },
  (table) => ({
    workspaceNovelCapabilityUnique: uniqueIndex("workspaceMigrationRegistry_workspaceNovel_capability_unique").on(table.workspaceNovelId, table.capability),
    ownerCapabilityIdx: index("workspaceMigrationRegistry_owner_capability_idx").on(table.owner, table.capability),
    workspaceNovelFk: foreignKey({
      name: "wmr_workspace_novel_fk",
      columns: [table.workspaceNovelId],
      foreignColumns: [workspaceNovels.id],
    }).onDelete("cascade"),
    changedByFk: foreignKey({
      name: "workspaceMigrationRegistry_changedBy_users_id_fk",
      columns: [table.changedBy],
      foreignColumns: [users.id],
    }),
  })
);

/** M02 short-lived, one-time incremental consent state kept server-side. */
export const workspaceGoogleConsentAttempts = mysqlTable(
  "workspaceGoogleConsentAttempts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    stateHash: varchar("stateHash", { length: 64 }).notNull(),
    encryptedCodeVerifier: text("encryptedCodeVerifier").notNull(),
    keyVersion: int("keyVersion").notNull(),
    fixedRedirectUri: varchar("fixedRedirectUri", { length: 500 }).notNull(),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    stateHashUnique: uniqueIndex("wgca_state_hash_unique").on(table.stateHash),
    userExpiryIdx: index("wgca_user_expiry_idx").on(
      table.userId,
      table.expiresAt
    ),
    userFk: foreignKey({
      name: "wgca_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  })
);

/** M02 user-owned, server-only incremental Google Docs authorization. */
export const workspaceGoogleConnections = mysqlTable(
  "workspaceGoogleConnections",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    providerSubject: varchar("providerSubject", { length: 255 }).notNull(),
    encryptedRefreshToken: text("encryptedRefreshToken"),
    keyVersion: int("keyVersion").notNull(),
    grantedScopes: text("grantedScopes").notNull(),
    tokenExpiresAt: timestamp("tokenExpiresAt"),
    status: mysqlEnum("status", ["active", "reconnect_required", "revoked"])
      .default("active")
      .notNull(),
    version: int("version").default(1).notNull(),
    lastUsedAt: timestamp("lastUsedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    userSubjectUnique: uniqueIndex("wgc_user_subject_unique").on(
      table.userId,
      table.providerSubject
    ),
    statusExpiryIdx: index("wgc_status_expiry_idx").on(
      table.status,
      table.tokenExpiresAt
    ),
    userFk: foreignKey({
      name: "wgc_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }),
  })
);

export const workspaceDocuments = mysqlTable(
  "workspaceDocuments",
  {
    id: int("id").autoincrement().primaryKey(),
    connectionId: int("connectionId").notNull(),
    providerFileId: varchar("providerFileId", { length: 255 }).notNull(),
    mimeType: varchar("mimeType", { length: 160 }).notNull(),
    titleCache: varchar("titleCache", { length: 500 }).notNull(),
    status: mysqlEnum("status", [
      "active",
      "inaccessible",
      "deleted",
      "unbound",
    ])
      .default("active")
      .notNull(),
    version: int("version").default(1).notNull(),
    lastObservedAt: timestamp("lastObservedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    connectionFileUnique: uniqueIndex("wd_connection_file_unique").on(
      table.connectionId,
      table.providerFileId
    ),
    connectionStatusIdx: index("wd_connection_status_idx").on(
      table.connectionId,
      table.status
    ),
    connectionFk: foreignKey({
      name: "wd_connection_fk",
      columns: [table.connectionId],
      foreignColumns: [workspaceGoogleConnections.id],
    }).onDelete("cascade"),
  })
);

export const workspaceDocumentBindings = mysqlTable(
  "workspaceDocumentBindings",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceNovelId: int("workspaceNovelId").notNull(),
    documentId: int("documentId").notNull(),
    role: mysqlEnum("role", ["source", "chapter", "glossary", "reference"])
      .default("source")
      .notNull(),
    sequence: int("sequence").default(1).notNull(),
    status: mysqlEnum("status", ["active", "paused", "removed"])
      .default("active")
      .notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    novelDocumentRoleUnique: uniqueIndex("wdb_novel_document_role_unique").on(
      table.workspaceNovelId,
      table.documentId,
      table.role
    ),
    novelRoleSequenceUnique: uniqueIndex("wdb_novel_role_sequence_unique").on(
      table.workspaceNovelId,
      table.role,
      table.sequence
    ),
    documentStatusIdx: index("wdb_document_status_idx").on(
      table.documentId,
      table.status
    ),
    workspaceNovelFk: foreignKey({
      name: "wdb_workspace_novel_fk",
      columns: [table.workspaceNovelId],
      foreignColumns: [workspaceNovels.id],
    }).onDelete("cascade"),
    documentFk: foreignKey({
      name: "wdb_document_fk",
      columns: [table.documentId],
      foreignColumns: [workspaceDocuments.id],
    }).onDelete("cascade"),
  })
);

export const workspaceDocumentSnapshots = mysqlTable(
  "workspaceDocumentSnapshots",
  {
    id: int("id").autoincrement().primaryKey(),
    documentId: int("documentId").notNull(),
    providerRevisionId: varchar("providerRevisionId", {
      length: 255,
    }).notNull(),
    normalizedSha256: varchar("normalizedSha256", { length: 64 }).notNull(),
    normalizationVersion: int("normalizationVersion").notNull(),
    byteLength: int("byteLength").notNull(),
    observedAt: timestamp("observedAt").defaultNow().notNull(),
  },
  table => ({
    documentRevisionUnique: uniqueIndex("wds_document_revision_unique").on(
      table.documentId,
      table.providerRevisionId
    ),
    documentHashVersionUnique: uniqueIndex(
      "wds_document_hash_version_unique"
    ).on(table.documentId, table.normalizedSha256, table.normalizationVersion),
    documentObservedIdx: index("wds_document_observed_idx").on(
      table.documentId,
      table.observedAt
    ),
    documentFk: foreignKey({
      name: "wds_document_fk",
      columns: [table.documentId],
      foreignColumns: [workspaceDocuments.id],
    }).onDelete("cascade"),
  })
);

/**
 * M03 current fingerprint projection for an active document binding.
 * Immutable observations remain in workspaceDocumentSnapshots; this row only
 * points at the latest observed snapshot and can be rebuilt from snapshot/audit
 * history. Checker rule-set linkage is added with the Checker foundation so
 * this projection does not pre-create a dangling cross-milestone foreign key.
 */
export const workspaceDocumentFingerprints = mysqlTable(
  "workspaceDocumentFingerprints",
  {
    id: int("id").autoincrement().primaryKey(),
    bindingId: int("bindingId").notNull(),
    snapshotId: int("snapshotId").notNull(),
    providerRevisionId: varchar("providerRevisionId", { length: 255 }).notNull(),
    normalizedSha256: varchar("normalizedSha256", { length: 64 }).notNull(),
    normalizationVersion: int("normalizationVersion").notNull(),
    lastPublishedSha256: varchar("lastPublishedSha256", { length: 64 }),
    version: int("version").default(1).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    bindingUnique: uniqueIndex("wdf_binding_unique").on(table.bindingId),
    normalizedHashIdx: index("wdf_normalized_hash_idx").on(table.normalizedSha256),
    lastPublishedHashIdx: index("wdf_last_published_hash_idx").on(table.lastPublishedSha256),
    bindingFk: foreignKey({
      name: "wdf_binding_fk",
      columns: [table.bindingId],
      foreignColumns: [workspaceDocumentBindings.id],
    }).onDelete("cascade"),
    snapshotFk: foreignKey({
      name: "wdf_snapshot_fk",
      columns: [table.snapshotId],
      foreignColumns: [workspaceDocumentSnapshots.id],
    }).onDelete("cascade"),
  })
);

/** M03 workflow board. Kanban remains a projection; movement truth is transitions. */
export const workspaceKanbanBoards = mysqlTable(
  "workspaceKanbanBoards",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceSlugUnique: uniqueIndex("wkb_workspace_slug_unique").on(table.workspaceId, table.slug),
    workspaceStatusIdx: index("wkb_workspace_status_idx").on(table.workspaceId, table.status),
    workspaceFk: foreignKey({
      name: "wkb_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
  })
);

export const workspaceKanbanColumns = mysqlTable(
  "workspaceKanbanColumns",
  {
    id: int("id").autoincrement().primaryKey(),
    boardId: int("boardId").notNull(),
    key: varchar("key", { length: 80 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    position: int("position").notNull(),
    wipLimit: int("wipLimit"),
    status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    boardKeyUnique: uniqueIndex("wkc_board_key_unique").on(table.boardId, table.key),
    boardPositionUnique: uniqueIndex("wkc_board_position_unique").on(table.boardId, table.position),
    boardFk: foreignKey({
      name: "wkc_board_fk",
      columns: [table.boardId],
      foreignColumns: [workspaceKanbanBoards.id],
    }).onDelete("cascade"),
  })
);

export const workspaceKanbanCards = mysqlTable(
  "workspaceKanbanCards",
  {
    id: int("id").autoincrement().primaryKey(),
    boardId: int("boardId").notNull(),
    columnId: int("columnId").notNull(),
    bindingId: int("bindingId"),
    logicalItemKey: varchar("logicalItemKey", { length: 255 }).notNull(),
    rank: int("rank").default(0).notNull(),
    status: mysqlEnum("status", ["active", "blocked", "done", "archived"]).default("active").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    boardLogicalKeyUnique: uniqueIndex("wkcard_board_logical_key_unique").on(table.boardId, table.logicalItemKey),
    columnRankIdx: index("wkcard_column_rank_idx").on(table.columnId, table.rank),
    boardFk: foreignKey({
      name: "wkcard_board_fk",
      columns: [table.boardId],
      foreignColumns: [workspaceKanbanBoards.id],
    }).onDelete("cascade"),
    columnFk: foreignKey({
      name: "wkcard_column_fk",
      columns: [table.columnId],
      foreignColumns: [workspaceKanbanColumns.id],
    }),
    bindingFk: foreignKey({
      name: "wkcard_binding_fk",
      columns: [table.bindingId],
      foreignColumns: [workspaceDocumentBindings.id],
    }).onDelete("set null"),
  })
);

export const workspaceKanbanTransitions = mysqlTable(
  "workspaceKanbanTransitions",
  {
    id: int("id").autoincrement().primaryKey(),
    cardId: int("cardId").notNull(),
    fromColumnId: int("fromColumnId"),
    toColumnId: int("toColumnId").notNull(),
    actorUserId: int("actorUserId").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    cardIdempotencyUnique: uniqueIndex("wkt_card_idempotency_unique").on(table.cardId, table.idempotencyKey),
    cardCreatedIdx: index("wkt_card_created_idx").on(table.cardId, table.createdAt),
    cardFk: foreignKey({
      name: "wkt_card_fk",
      columns: [table.cardId],
      foreignColumns: [workspaceKanbanCards.id],
    }).onDelete("cascade"),
    fromColumnFk: foreignKey({
      name: "wkt_from_column_fk",
      columns: [table.fromColumnId],
      foreignColumns: [workspaceKanbanColumns.id],
    }),
    toColumnFk: foreignKey({
      name: "wkt_to_column_fk",
      columns: [table.toColumnId],
      foreignColumns: [workspaceKanbanColumns.id],
    }),
    actorFk: foreignKey({
      name: "wkt_actor_fk",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }),
  })
);

/** Immutable M03 Checker configuration versions. */
export const workspaceCheckerRuleSets = mysqlTable(
  "workspaceCheckerRuleSets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    versionNo: int("versionNo").notNull(),
    contentSha256: varchar("contentSha256", { length: 64 }).notNull(),
    engineVersion: varchar("engineVersion", { length: 120 }).notNull(),
    rulesJson: text("rulesJson").notNull(),
    status: mysqlEnum("status", ["published", "retired"]).default("published").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceNameVersionUnique: uniqueIndex("wcrs_workspace_name_version_unique").on(table.workspaceId, table.name, table.versionNo),
    workspaceHashUnique: uniqueIndex("wcrs_workspace_hash_unique").on(table.workspaceId, table.contentSha256),
    workspaceFk: foreignKey({
      name: "wcrs_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
  })
);

export const workspaceCheckerRuns = mysqlTable(
  "workspaceCheckerRuns",
  {
    id: int("id").autoincrement().primaryKey(),
    snapshotId: int("snapshotId").notNull(),
    ruleSetId: int("ruleSetId").notNull(),
    engineVersion: varchar("engineVersion", { length: 120 }).notNull(),
    status: mysqlEnum("status", ["queued", "running", "passed", "failed", "cancelled"]).default("queued").notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    leaseOwner: varchar("leaseOwner", { length: 255 }),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    version: int("version").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    finishedAt: timestamp("finishedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    snapshotRuleEngineUnique: uniqueIndex("wcr_snapshot_rule_engine_unique").on(table.snapshotId, table.ruleSetId, table.engineVersion),
    idempotencyUnique: uniqueIndex("wcr_idempotency_unique").on(table.idempotencyKey),
    claimIdx: index("wcr_claim_idx").on(table.status, table.leaseExpiresAt),
    snapshotFk: foreignKey({
      name: "wcr_snapshot_fk",
      columns: [table.snapshotId],
      foreignColumns: [workspaceDocumentSnapshots.id],
    }).onDelete("cascade"),
    ruleSetFk: foreignKey({
      name: "wcr_rule_set_fk",
      columns: [table.ruleSetId],
      foreignColumns: [workspaceCheckerRuleSets.id],
    }),
  })
);

export const workspaceCheckerFindings = mysqlTable(
  "workspaceCheckerFindings",
  {
    id: int("id").autoincrement().primaryKey(),
    runId: int("runId").notNull(),
    ruleKey: varchar("ruleKey", { length: 160 }).notNull(),
    severity: mysqlEnum("severity", ["info", "warning", "error"]).notNull(),
    locationKey: varchar("locationKey", { length: 255 }).notNull(),
    excerptSha256: varchar("excerptSha256", { length: 64 }).notNull(),
    message: text("message").notNull(),
    disposition: mysqlEnum("disposition", ["open", "accepted", "fixed", "ignored"]).default("open").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    findingUnique: uniqueIndex("wcf_run_rule_location_excerpt_unique").on(table.runId, table.ruleKey, table.locationKey, table.excerptSha256),
    runSeverityIdx: index("wcf_run_severity_idx").on(table.runId, table.severity),
    runFk: foreignKey({
      name: "wcf_run_fk",
      columns: [table.runId],
      foreignColumns: [workspaceCheckerRuns.id],
    }).onDelete("cascade"),
  })
);

/** M04 durable AI work request. Provider execution is intentionally outside this table/service boundary. */
export const workspaceAiJobs = mysqlTable(
  "workspaceAiJobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    snapshotId: int("snapshotId").notNull(),
    operation: varchar("operation", { length: 120 }).notNull(),
    promptVersion: varchar("promptVersion", { length: 120 }).notNull(),
    modelPolicyVersion: varchar("modelPolicyVersion", { length: 120 }).notNull(),
    priority: int("priority").default(0).notNull(),
    status: mysqlEnum("status", ["queued", "claimed", "running", "succeeded", "failed", "cancelled"]).default("queued").notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    version: int("version").default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceIdempotencyUnique: uniqueIndex("waj_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
    claimIdx: index("waj_claim_idx").on(table.status, table.priority, table.createdAt),
    workspaceFk: foreignKey({
      name: "waj_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
    snapshotFk: foreignKey({
      name: "waj_snapshot_fk",
      columns: [table.snapshotId],
      foreignColumns: [workspaceDocumentSnapshots.id],
    }).onDelete("cascade"),
  })
);

/** M04 immutable attempt history. Retry/reclaim always creates a new row. */
export const workspaceAiJobAttempts = mysqlTable(
  "workspaceAiJobAttempts",
  {
    id: int("id").autoincrement().primaryKey(),
    jobId: int("jobId").notNull(),
    attemptNo: int("attemptNo").notNull(),
    leaseOwner: varchar("leaseOwner", { length: 255 }).notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    providerRequestId: varchar("providerRequestId", { length: 255 }),
    status: mysqlEnum("status", ["claimed", "running", "succeeded", "failed", "abandoned"]).default("claimed").notNull(),
    errorClass: varchar("errorClass", { length: 160 }),
    version: int("version").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    finishedAt: timestamp("finishedAt"),
  },
  table => ({
    jobAttemptUnique: uniqueIndex("waja_job_attempt_unique").on(table.jobId, table.attemptNo),
    statusLeaseIdx: index("waja_status_lease_idx").on(table.status, table.leaseExpiresAt),
    providerRequestIdx: index("waja_provider_request_idx").on(table.providerRequestId),
    jobFk: foreignKey({
      name: "waja_job_fk",
      columns: [table.jobId],
      foreignColumns: [workspaceAiJobs.id],
    }).onDelete("cascade"),
  })
);

/** M04 immutable generated-output reference. Raw generated content is not stored here. */
export const workspaceAiArtifacts = mysqlTable(
  "workspaceAiArtifacts",
  {
    id: int("id").autoincrement().primaryKey(),
    attemptId: int("attemptId").notNull(),
    artifactType: varchar("artifactType", { length: 120 }).notNull(),
    contentObjectKey: varchar("contentObjectKey", { length: 500 }).notNull(),
    contentSha256: varchar("contentSha256", { length: 64 }).notNull(),
    moderationStatus: mysqlEnum("moderationStatus", ["pending", "accepted", "rejected"]).default("pending").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    attemptArtifactHashUnique: uniqueIndex("waa_attempt_type_hash_unique").on(table.attemptId, table.artifactType, table.contentSha256),
    contentHashIdx: index("waa_content_hash_idx").on(table.contentSha256),
    attemptFk: foreignKey({
      name: "waa_attempt_fk",
      columns: [table.attemptId],
      foreignColumns: [workspaceAiJobAttempts.id],
    }).onDelete("cascade"),
  })
);

export const workspaceAuditEvents = mysqlTable(
  "workspaceAuditEvents",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    actorUserId: int("actorUserId"),
    eventType: varchar("eventType", { length: 120 }).notNull(),
    entityType: varchar("entityType", { length: 120 }).notNull(),
    entityId: varchar("entityId", { length: 255 }).notNull(),
    correlationId: varchar("correlationId", { length: 255 }).notNull(),
    metadataJson: text("metadataJson").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceCreatedIdx: index("wae_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    entityCreatedIdx: index("wae_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt
    ),
    correlationIdx: index("wae_correlation_idx").on(table.correlationId),
    workspaceFk: foreignKey({
      name: "wae_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaceWorkspaces.id],
    }).onDelete("cascade"),
    actorFk: foreignKey({
      name: "wae_actor_fk",
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }),
  })
);

export type WorkspaceWorkspace = typeof workspaceWorkspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceNovel = typeof workspaceNovels.$inferSelect;
export type WorkspaceReadOnlyBinding = typeof workspaceReadOnlyBindings.$inferSelect;
export type WorkspaceMigrationRegistryEntry = typeof workspaceMigrationRegistry.$inferSelect;
export type WorkspaceDocumentFingerprint = typeof workspaceDocumentFingerprints.$inferSelect;
