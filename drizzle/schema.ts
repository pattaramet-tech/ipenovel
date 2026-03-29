import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  decimal,
  boolean,
  uniqueIndex,
  index,
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
    fileUrl: text("fileUrl"), // S3 URL for the episode file
    fileSize: int("fileSize"), // File size in bytes
    fileMimeType: varchar("fileMimeType", { length: 100 }), // e.g., "application/pdf"
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    novelIdIdx: index("episodes_novelId_idx").on(table.novelId),
    isFreeIdx: index("episodes_isFree_idx").on(table.isFree),
    uniqueEpisode: uniqueIndex("unique_novel_episode").on(table.novelId, table.episodeNumber),
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
    status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: int("reviewedByUserId"),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    orderIdIdx: uniqueIndex("payments_orderId_idx").on(table.orderId),
    reviewerIdx: index("payments_reviewedByUserId_idx").on(table.reviewedByUserId),
  })
);

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;

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
  })
);

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = typeof purchases.$inferInsert;

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
  slipImageUrl: text("slipImageUrl"),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "cancelled"]).default("pending").notNull(),
  rejectionReason: text("rejectionReason"),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdIdx: index("walletTopups_userId_idx").on(table.userId),
  statusIdx: index("walletTopups_status_idx").on(table.status),
  createdAtIdx: index("walletTopups_createdAt_idx").on(table.createdAt),
}));

export type WalletTopup = typeof walletTopups.$inferSelect;
export type InsertWalletTopup = typeof walletTopups.$inferInsert;
