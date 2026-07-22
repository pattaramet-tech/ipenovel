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
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extended with role-based access control for admin/user distinction.
 */
export const users = mysqlTable("users", {
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
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

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
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    codeIdx: uniqueIndex("coupons_code_idx").on(table.code),
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
