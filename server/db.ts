import { eq, and, or, desc, asc, inArray, isNull, isNotNull, gte, lte, count, sql, gt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
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
  sportsMatches,
  sportsMatchVotes,
  sportsMatchRewards,
  Novel,
  couponUsages as couponUsagesTable,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
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
    console.error("[Database] Failed to upsert user:", error);
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

export async function getUserById(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
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

export async function createEpisode(data: {
  novelId: number;
  episodeNumber: string;
  title: string;
  price: string;
  isFree?: boolean;
  fileUrl?: string;
  content?: string;
  contentFormat?: string;
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
  const db = await getDb();
  if (!db) return undefined;

  let cart = await db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  if (cart.length > 0) return cart[0];

  const newCart = await db.insert(carts).values({ userId });
  const cartId = newCart[0].insertId;
  return { id: cartId as number, userId, createdAt: new Date(), updatedAt: new Date() };
}

export async function getCartItems(cartId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
}

export async function addToCart(cartId: number, episodeId: number, novelId: number, price: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.insert(cartItems).values({
    cartId,
    episodeId,
    novelId,
    price: price as any,
  });
  return result;
}

export async function removeFromCart(cartItemId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(cartItems).where(eq(cartItems.id, cartItemId));
}

export async function clearCart(cartId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
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
}, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;

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
  const db = tx || await getDb();
  if (!db) return;
  await db.insert(orderItems).values(items as any);
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

export async function createPayment(orderId: number, slipImageUrl?: string, tx?: any) {
  const db = tx || await getDb();
  if (!db) return undefined;
  const result = await db.insert(payments).values({
    orderId,
    status: "pending",
    slipImageUrl: slipImageUrl || null,
    slipSubmittedAt: slipImageUrl ? new Date() : null,
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
  const db = tx || await getDb();
  if (!db) return;

  const updateData: any = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.paymentStatus !== undefined) updateData.paymentStatus = data.paymentStatus;
  if (data.notes !== undefined) updateData.notes = data.notes;

  if (Object.keys(updateData).length === 0) return;

  await db.update(orders).set(updateData).where(eq(orders.id, orderId));
}

export async function updatePayment(paymentId: number, data: { slipImageUrl?: string; slipSubmittedAt?: Date; status?: "pending" | "approved" | "rejected" | "pending_review"; rejectionReason?: string; extractedData?: string | null; reviewReason?: string | null; fingerprint?: string | null; linkedOrderId?: number | null; linkedPaymentId?: number | null; ocrConfidence?: number | null; ocrDecision?: string | null }, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;
  await db.update(payments).set(data).where(eq(payments.id, paymentId));
}

export async function approvePayment(paymentId: number, reviewedByUserId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;
  await db
    .update(payments)
    .set({
      status: "approved",
      reviewedByUserId,
      reviewedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));
}

export async function rejectPayment(paymentId: number, reviewedByUserId: number, rejectionReason: string, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;
  await db
    .update(payments)
    .set({
      status: "rejected",
      rejectionReason,
      reviewedByUserId,
      reviewedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));
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
  const db = tx || await getDb();
  if (!db) return undefined;

  const result = await db.insert(purchases).values({
    userId,
    novelId,
    episodeId,
    orderId,
    grantedAt: new Date(),
  });
  return result;
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

  // Filter out reward coupons that don't belong to the user
  let filteredResult = result;
  if (userId) {
    filteredResult = [];
    for (const coupon of result) {
      const rewardCheck = await db
        .select()
        .from(sportsMatchRewards)
        .where(eq(sportsMatchRewards.couponId, coupon.id))
        .limit(1);

      // Include coupon if it's not a reward coupon, or if it belongs to this user AND has issued status
      if (rewardCheck.length === 0) {
        // Not a sports reward coupon, include it
        filteredResult.push(coupon);
      } else if (rewardCheck[0].userId === userId && rewardCheck[0].status === "issued") {
        // Sports reward coupon that belongs to this user and is still issued (not used/expired/void)
        filteredResult.push(coupon);
      }
      // Otherwise exclude: either belongs to different user, or status is used/expired/void
    }
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

export async function createCoupon(data: {
  code: string;
  discountType: "flat" | "percentage";
  discountValue: string;
  minPurchaseAmount?: string;
  maxUsageCount?: number;
  expiresAt?: Date;
}) {
  const db = await getDb();
  if (!db) return undefined;
  // Normalize code: uppercase for consistency
  const normalizedCode = String(data.code || "").trim().toUpperCase();
  const result = await db.insert(coupons).values({
    code: normalizedCode,
    discountType: data.discountType,
    discountValue: data.discountValue as any,
    minPurchaseAmount: data.minPurchaseAmount as any,
    maxUsageCount: data.maxUsageCount,
    expiresAt: data.expiresAt,
    isActive: true,
    usageCount: 0,
  });
  return result;
}

export async function updateCoupon(couponId: number, data: {
  code?: string;
  discountType?: "flat" | "percentage";
  discountValue?: string;
  minPurchaseAmount?: string;
  maxUsageCount?: number;
  expiresAt?: Date;
  isActive?: boolean;
}) {
  const db = await getDb();
  if (!db) return;
  // Normalize code if provided
  const normalizedData = { ...data };
  if (data.code) {
    normalizedData.code = String(data.code).trim().toUpperCase();
  }
  await db.update(coupons).set(normalizedData).where(eq(coupons.id, couponId));
}

export async function deleteCoupon(couponId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(coupons).where(eq(coupons.id, couponId));
}

export async function recordCouponUsage(couponId: number, userId: number | undefined, orderId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) return { recorded: false };

  try {
    // Check if this coupon + order combination already exists
    const existing = await db.select().from(couponUsages)
      .where(and(eq(couponUsages.couponId, couponId), eq(couponUsages.orderId, orderId)));
    
    if (existing && existing.length > 0) {
      // Already recorded - skip to prevent duplicate increment
      return { alreadyRecorded: true };
    }
    
    // Insert new usage record
    await db.insert(couponUsages).values({ couponId, userId, orderId });
    // Increment usageCount on the coupon itself
    await db.update(coupons).set({ usageCount: sql`${coupons.usageCount} + 1` }).where(eq(coupons.id, couponId));
    return { recorded: true };
  } catch (err: any) {
    // Handle unique constraint violation gracefully (duplicate key error)
    if (err.code === "ER_DUP_ENTRY" || err.message?.includes("UNIQUE constraint failed")) {
      // Duplicate key - already recorded, skip silently
      return { alreadyRecorded: true };
    }
    throw err;
  }
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

  const result = await db
    .select({ balanceAfter: pointsTransactions.balanceAfter })
    .from(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId))
    .orderBy(desc(pointsTransactions.createdAt))
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
  const db = tx || await getDb();
  if (!db) return;

  await db.insert(pointsTransactions).values({
    userId: data.userId,
    type: data.type,
    amount: data.amount as any,
    balanceAfter: data.balanceAfter as any,
    referenceType: data.referenceType,
    referenceId: data.referenceId,
    note: data.note,
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

export async function addToWishlist(userId: number, novelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.insert(wishlists).values({ userId, novelId });
}

export async function removeFromWishlist(wishlistId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(wishlists).where(eq(wishlists.id, wishlistId));
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
  const db = tx || await getDb();
  if (!db) return;

  await db.insert(orderHistory).values({
    orderId: data.orderId,
    action: data.action,
    fromStatus: data.fromStatus,
    toStatus: data.toStatus,
    actorUserId: data.actorUserId,
    note: data.note,
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

export async function getAdminByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0];
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
 * Get popular novels sorted by purchaseCount DESC, wishlistCount DESC, createdAt DESC
 * Uses aggregate subqueries to avoid N+1 queries
 */
export async function getPopularNovels(limit: number = 4): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

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
      desc(novels.createdAt)
    )
    .limit(limit);

  // Normalize counts to numbers
  return result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: 0,
  }));
}

/**
 * Get new novels sorted by createdAt DESC
 */
export async function getNewNovels(limit: number = 4): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

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

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`,
      wishlistCount: sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`,
      freeEpisodeCount: sql<number>`0`,
    })
    .from(novels)
    .where(eq(novels.publicationStatus, "published")) // Only published novels
    .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
    .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId))
    .orderBy(desc(novels.createdAt))
    .limit(limit);

  return result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: 0,
  }));
}

/**
 * Get novels with free episodes sorted by createdAt DESC
 * Only returns novels that have at least one free episode
 */
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

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`,
      wishlistCount: sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`,
      freeEpisodeCount: sql<number>`COALESCE(${freeEpisodeCountsSubquery.count}, 0)`,
    })
    .from(novels)
    .innerJoin(freeEpisodeCountsSubquery, eq(novels.id, freeEpisodeCountsSubquery.novelId))
    .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
    .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId))
    .where(and(
      eq(novels.publicationStatus, "published"), // Only published novels
      sql<boolean>`${freeEpisodeCountsSubquery.count} > 0`
    ))
    .orderBy(desc(novels.createdAt))
    .limit(limit);

  return result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: Number(row.freeEpisodeCount) || 0,
  }));
}

/**
 * Get finished/completed novels sorted by createdAt DESC
 * Only returns published novels with storyStatus = 'finished'
 */
export async function getFinishedNovels(limit: number = 4): Promise<NovelWithCounts[]> {
  const db = await getDb();
  if (!db) return [];

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

  const result = await db
    .select({
      ...getTableColumns(novels),
      purchaseCount: sql<number>`COALESCE(${purchaseCountsSubquery.count}, 0)`,
      wishlistCount: sql<number>`COALESCE(${wishlistCountsSubquery.count}, 0)`,
      freeEpisodeCount: sql<number>`0`,
    })
    .from(novels)
    .where(and(
      eq(novels.publicationStatus, "published"),
      eq(novels.storyStatus, "finished")
    ))
    .leftJoin(purchaseCountsSubquery, eq(novels.id, purchaseCountsSubquery.novelId))
    .leftJoin(wishlistCountsSubquery, eq(novels.id, wishlistCountsSubquery.novelId))
    .orderBy(desc(novels.createdAt))
    .limit(limit);

  return result.map((row: any) => ({
    ...row,
    purchaseCount: Number(row.purchaseCount) || 0,
    wishlistCount: Number(row.wishlistCount) || 0,
    freeEpisodeCount: 0,
  }));
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
    .leftJoin(novels, eq(episodes.novelId, novels.id))
    .orderBy(desc(episodes.createdAt))
    .limit(limit);

  return result;
}


/**
 * Get lightweight browse catalog data - optimized for performance
 * Returns only essential fields needed for browse cards
 * Avoids expensive aggregate subqueries for counts
 */
export async function getBrowseCatalog(params: {
  sort?: "new" | "popular";
  filter?: "all" | "free";
  storyStatus?: "ongoing" | "finished";
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Array<{
  id: number;
  title: string;
  slug: string;
  coverImageUrl: string | null;
  storyStatus: string;
  createdAt: Date;
  freeEpisodeCount: number;
}>> {
  const db = await getDb();
  if (!db) return [];

  const { sort = "new", filter = "all", storyStatus, search, limit = 20, offset = 0 } = params;

  // Lightweight subquery for free episode counts only
  const freeEpisodeCountsSubquery = db
    .select({
      novelId: episodes.novelId,
      count: sql<number>`COUNT(${episodes.id})`.as("freeEpisodeCount"),
    })
    .from(episodes)
    .where(eq(episodes.isFree, true))
    .groupBy(episodes.novelId)
    .as("freeEpisodeCounts");

  let query: any = db
    .select({
      id: novels.id,
      title: novels.title,
      slug: novels.slug,
      coverImageUrl: novels.coverImageUrl,
      storyStatus: novels.storyStatus,
      createdAt: novels.createdAt,
      freeEpisodeCount: sql<number>`COALESCE(${freeEpisodeCountsSubquery.count}, 0)`,
    })
    .from(novels)
    .leftJoin(freeEpisodeCountsSubquery, eq(novels.id, freeEpisodeCountsSubquery.novelId));

  // Combine filter and search into a single .where() call to avoid overwriting
  const browseConditions: any[] = [
    eq(novels.publicationStatus, "published"), // Always filter for published novels
  ];
  if (filter === "free") {
    browseConditions.push(sql<boolean>`${freeEpisodeCountsSubquery.count} > 0`);
  }
  if (storyStatus === "ongoing" || storyStatus === "finished") {
    browseConditions.push(eq(novels.storyStatus, storyStatus));
  }
  if (search && search.trim()) {
    const searchPattern = `%${search.trim()}%`;
    browseConditions.push(sql`${novels.title} LIKE ${searchPattern}`);
  }
  if (browseConditions.length === 1) {
    query = query.where(browseConditions[0]);
  } else if (browseConditions.length > 1) {
    query = query.where(and(...browseConditions));
  }

  // Apply sort
  if (sort === "popular") {
    // For lightweight browse, sort by free episode count as a popularity proxy
    // This avoids expensive purchase/wishlist count queries
    query = query.orderBy(
      desc(sql<number>`COALESCE(${freeEpisodeCountsSubquery.count}, 0)`),
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
    freeEpisodeCount: Number(row.freeEpisodeCount) || 0,
  }));
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

export async function getOrCreateWalletAccount(userId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) throw new Error("Database not available");

  let account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];

  if (!account) {
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
      console.error("[getOrCreateWalletAccount] insert wallet account failed", {
        message: insertError?.message,
        code: insertError?.code,
        errno: insertError?.errno,
        sqlState: insertError?.sqlState,
        sqlMessage: insertError?.sqlMessage,
        userId,
        error: insertError,
      });

      // Handle concurrent insert: if another request already created the account, retry select
      if (insertError?.errno === 1062 || insertError?.code === "ER_DUP_ENTRY") {
        console.warn("[getOrCreateWalletAccount] concurrent insert detected, retrying select", { userId });
        account = (await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1))[0];
        if (account) return account;
      }

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

  let result: any;
  try {
    result = await db.insert(walletTopups).values({
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

  return (await db.select().from(walletTopups).where(eq(walletTopups.id, result[0].insertId)).limit(1))[0];
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

export async function updateWalletTopupSlip(topupId: number, slipImageUrl: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.update(walletTopups).set({ slipImageUrl }).where(eq(walletTopups.id, topupId));

  return (await db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
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
  const db = tx || await getDb();
  if (!db) throw new Error("Database not available");

  return db.insert(walletTransactions).values({
    userId,
    type: type as any,
    amount,
    balanceBefore,
    balanceAfter,
    referenceType,
    referenceId,
    note,
  });
}

export async function debitWalletBalance(userId: number, amount: string, referenceType: string, referenceId: number, tx?: any) {
  const db = tx || await getDb();
  if (!db) throw new Error("Database not available");

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
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const account = await getOrCreateWalletAccount(userId);
  const currentBalance = parseFloat(account.balance);
  const creditAmount = parseFloat(amount);
  const newBalance = (currentBalance + creditAmount).toFixed(2);

  await db
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
    referenceId
  );

  return newBalance;
}

export async function approveWalletTopup(topupId: number, adminUserId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // REAL DATABASE TRANSACTION: All operations succeed or all rollback
  // This prevents double-crediting if approval is retried
  return await db.transaction(async (tx) => {
    // Step 1: Fetch topup INSIDE transaction for consistency
    const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topupResult || topupResult.length === 0) {
      throw new Error("Wallet top-up not found");
    }
    const topup = topupResult[0];
    
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

    // Step 7: Return updated topup
    const updated = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    return updated[0];
  });
}

export async function rejectWalletTopup(topupId: number, adminUserId: number, reason: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.transaction(async (tx) => {
    const topup = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topup || topup.length === 0) throw new Error("Wallet top-up not found");

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

  return await db.transaction(async (tx) => {
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

  const result = await db.insert(topupLogs).values({
    userId,
    amount: amount,
    bonus: bonus || "0.00",
    total: total,
    method,
    reference,
    note,
    createdBy,
    createdAt: new Date(),
  });

  return result;
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

export async function getPublicSportsMatches(userId?: number) {
  const db = await getDb();
  if (!db) return [];

  const matches = await db
    .select()
    .from(sportsMatches)
    .where(eq(sportsMatches.isActive, true))
    .orderBy(asc(sportsMatches.displayOrder), asc(sportsMatches.voteDeadlineAt));

  if (!userId) return matches.map((match: any) => ({ ...match, myVote: null }));

  const votes = await db
    .select()
    .from(sportsMatchVotes)
    .where(eq(sportsMatchVotes.userId, userId));

  const voteByMatchId = new Map(votes.map((vote: any) => [vote.matchId, vote]));
  return matches.map((match: any) => ({ ...match, myVote: voteByMatchId.get(match.id) || null }));
}

export async function getAdminSportsMatches() {
  const db = await getDb();
  if (!db) return [];

  const matches = await db
    .select()
    .from(sportsMatches)
    .orderBy(desc(sportsMatches.createdAt));

  return Promise.all(
    matches.map(async (match: any) => {
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
  homeTeamName: string;
  awayTeamName: string;
  homeTeamImageUrl?: string;
  awayTeamImageUrl?: string;
  coverImageUrl?: string;
  matchStartAt?: Date;
  voteDeadlineAt: Date;
  voteCostPoints: string;
  rewardDiscountType: "flat" | "percentage";
  rewardDiscountValue: string;
  rewardMinPurchaseAmount?: string;
  rewardCouponExpiresAt?: Date;
  status?: SportsMatchStatus;
  isActive?: boolean;
  displayOrder?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Validate numeric fields using shared strict helpers
  const voteCostPoints = parseStrictNonNegativeDecimal(data.voteCostPoints, "voteCostPoints");
  const rewardDiscountValue = parseStrictPositiveDecimal(data.rewardDiscountValue, "rewardDiscountValue");
  const minPurchaseAmount = parseStrictNonNegativeDecimal(data.rewardMinPurchaseAmount, "rewardMinPurchaseAmount");

  // Validate discount percentage
  if (data.rewardDiscountType === "percentage" && rewardDiscountValue > 100) {
    throw new Error("Percentage discount cannot exceed 100");
  }

  // Validate dates
  if (!data.voteDeadlineAt || !(data.voteDeadlineAt instanceof Date)) {
    throw new Error("voteDeadlineAt must be a valid date");
  }

  // Always require deadline in future (regardless of status)
  if (data.voteDeadlineAt.getTime() <= Date.now()) {
    throw new Error("voteDeadlineAt must be in the future");
  }

  if (data.rewardCouponExpiresAt && data.rewardCouponExpiresAt.getTime() <= Date.now()) {
    throw new Error("rewardCouponExpiresAt must be in the future");
  }

  const result = await db.insert(sportsMatches).values({
    ...data,
    voteCostPoints: data.voteCostPoints as any,
    rewardDiscountValue: data.rewardDiscountValue as any,
    rewardMinPurchaseAmount: (data.rewardMinPurchaseAmount || "0.00") as any,
    status: data.status || "draft",
    isActive: data.isActive ?? true,
    displayOrder: data.displayOrder ?? 0,
  });

  return { id: extractInsertId(result) };
}

export async function updateSportsMatch(matchId: number, data: Partial<{
  title: string;
  leagueName: string | null;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  coverImageUrl: string | null;
  matchStartAt: Date | null;
  voteDeadlineAt: Date;
  voteCostPoints: string;
  rewardDiscountType: "flat" | "percentage";
  rewardDiscountValue: string;
  rewardMinPurchaseAmount: string | null;
  rewardCouponExpiresAt: Date | null;
  status: SportsMatchStatus;
  result: SportsPrediction | null;
  isActive: boolean;
  displayOrder: number;
}>, tx?: any) {
  const db = tx || await getDb();
  if (!db) return;

  // Load existing match for context
  const existing = await getSportsMatchById(matchId, tx);
  if (!existing) throw new Error("Match not found");

  // Guard: Reject updates to critical fields if match is settled or cancelled
  const CRITICAL_FIELDS = [
    "title", "leagueName", "homeTeamName", "awayTeamName",
    "matchStartAt", "voteDeadlineAt",
    "voteCostPoints",
    "rewardDiscountType", "rewardDiscountValue", "rewardMinPurchaseAmount",
    "rewardCouponExpiresAt",
    "status", "result"
  ];
  
  if ((existing.status === "settled" || existing.status === "cancelled") && 
      Object.keys(data).some(key => CRITICAL_FIELDS.includes(key))) {
    throw new Error(`Cannot update critical fields on a ${existing.status} match`);
  }

  // Merge existing values with incoming updates
  const merged = {
    voteCostPoints: data.voteCostPoints !== undefined ? data.voteCostPoints : existing.voteCostPoints,
    rewardDiscountType: data.rewardDiscountType !== undefined ? data.rewardDiscountType : existing.rewardDiscountType,
    rewardDiscountValue: data.rewardDiscountValue !== undefined ? data.rewardDiscountValue : existing.rewardDiscountValue,
    rewardMinPurchaseAmount: data.rewardMinPurchaseAmount !== undefined ? data.rewardMinPurchaseAmount : existing.rewardMinPurchaseAmount,
    voteDeadlineAt: data.voteDeadlineAt !== undefined ? data.voteDeadlineAt : existing.voteDeadlineAt,
    rewardCouponExpiresAt: data.rewardCouponExpiresAt !== undefined ? data.rewardCouponExpiresAt : existing.rewardCouponExpiresAt,
    status: data.status !== undefined ? data.status : existing.status,
  };

  // Validate voteCostPoints using strict helper
  const voteCost = parseStrictNonNegativeDecimal(merged.voteCostPoints, "voteCostPoints");

  // Validate rewardDiscountValue using strict helper
  const discountValue = parseStrictPositiveDecimal(merged.rewardDiscountValue, "rewardDiscountValue");

  // Validate percentage discount <= 100
  if (merged.rewardDiscountType === "percentage" && discountValue > 100) {
    throw new Error("rewardDiscountValue cannot exceed 100 for percentage discounts");
  }

  // Validate rewardMinPurchaseAmount using strict helper
  if (merged.rewardMinPurchaseAmount !== null) {
    parseStrictNonNegativeDecimal(merged.rewardMinPurchaseAmount, "rewardMinPurchaseAmount");
  }

  // Validate voteDeadlineAt is a valid date
  if (merged.voteDeadlineAt) {
    const deadline = new Date(merged.voteDeadlineAt);
    if (isNaN(deadline.getTime())) {
      throw new Error("voteDeadlineAt must be a valid date");
    }
    // If status is open, deadline must be in the future
    if (merged.status === "open" && deadline.getTime() <= Date.now()) {
      throw new Error("voteDeadlineAt must be in the future for open matches");
    }
  }

  // Validate rewardCouponExpiresAt is in the future if provided
  if (merged.rewardCouponExpiresAt) {
    const expiresAt = new Date(merged.rewardCouponExpiresAt);
    if (isNaN(expiresAt.getTime())) {
      throw new Error("rewardCouponExpiresAt must be a valid date");
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error("rewardCouponExpiresAt must be in the future");
    }
  }

  // All validations passed, perform update
  // Only update fields that are explicitly provided (not all merged fields)
  await db.update(sportsMatches).set(data as any).where(eq(sportsMatches.id, matchId));
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
  
  const userRow = await database.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  if (!userRow || userRow.length === 0) throw new Error("User not found");
  
  return userRow[0];
}

export async function castSportsVote(userId: number, matchId: number, prediction: SportsPrediction) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx: any) => {
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
    const match = await getSportsMatchById(matchId, tx);
    if (!match) throw new Error("Match not found");
    if (match.status === "settled") throw new Error("Match has already been settled");
    if (match.status === "cancelled") throw new Error("Cancelled match cannot be settled");
    
    // Settle policy guard: reject draft matches
    if (match.status === "draft") {
      throw new Error("Cannot settle draft match. Must be closed or deadline must have passed.");
    }
    
    // Settle policy guard: reject open matches before deadline
    if (match.status === "open" && new Date(match.voteDeadlineAt).getTime() > Date.now()) {
      throw new Error("Cannot settle open match before voting deadline has passed.");
    }

    await updateSportsMatch(matchId, { status: "settled", result }, tx);

    const votes = await tx
      .select()
      .from(sportsMatchVotes)
      .where(eq(sportsMatchVotes.matchId, matchId));

    let winnerCount = 0;

    for (const vote of votes) {
      if (vote.status !== "pending") continue;

      if (vote.prediction === result) {
        // Check if reward already exists (idempotency) - BEFORE creating coupon
        const existingReward = await tx
          .select()
          .from(sportsMatchRewards)
          .where(eq(sportsMatchRewards.voteId, vote.id))
          .limit(1);

        if (existingReward.length) {
          // Reward already exists, skip coupon creation
          winnerCount += 1;
          continue;
        }

        // Reward does not exist, create coupon and reward
        const code = buildRewardCouponCode(matchId, vote.id);
        const couponResult = await tx.insert(coupons).values({
          code,
          discountType: match.rewardDiscountType,
          discountValue: match.rewardDiscountValue as any,
          minPurchaseAmount: (match.rewardMinPurchaseAmount || "0.00") as any,
          maxUsageCount: 1,
          usageCount: 0,
          isActive: true,
          expiresAt: match.rewardCouponExpiresAt || null,
        });
        const couponId = extractInsertId(couponResult);

        // Create sportsMatchRewards entry to track ownership
        await tx.insert(sportsMatchRewards).values({
          matchId,
          voteId: vote.id,
          userId: vote.userId,
          couponId,
          status: "issued",
          issuedAt: new Date(),
        });

        await tx
          .update(sportsMatchVotes)
          .set({ status: "won", rewardCouponId: couponId, rewardCouponCode: code })
          .where(eq(sportsMatchVotes.id, vote.id));

        winnerCount += 1;
      } else {
        await tx
          .update(sportsMatchVotes)
          .set({ status: "lost" })
          .where(eq(sportsMatchVotes.id, vote.id));
      }
    }

    return { success: true, winnerCount };
  });
}

export async function cancelSportsMatch(matchId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx: any) => {
    const match = await getSportsMatchById(matchId, tx);
    if (!match) throw new Error("Match not found");
    if (match.status === "settled") throw new Error("Settled match cannot be cancelled");

    await updateSportsMatch(matchId, { status: "cancelled" }, tx);

    const pendingVotes = await tx
      .select()
      .from(sportsMatchVotes)
      .where(and(eq(sportsMatchVotes.matchId, matchId), eq(sportsMatchVotes.status, "pending")));

    for (const vote of pendingVotes) {
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


export async function markSportsRewardCouponUsed(couponId: number, userId: number, tx?: any) {
  const db = tx || (await getDb());
  if (!db) throw new Error("Database not available");

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
      rewardStatusRaw: sportsMatchRewards.status,
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
    .innerJoin(coupons, eq(sportsMatchRewards.couponId, coupons.id))
    .where(eq(sportsMatchRewards.userId, userId))
    .orderBy(desc(sportsMatchRewards.createdAt));

  // Compute rewardStatus based on rewardStatusRaw and coupon expiration
  return rewards.map((reward: any) => ({
    ...reward,
    rewardStatus: reward.rewardStatusRaw === "used" ? "used" : 
                  reward.rewardStatusRaw === "void" ? "void" :
                  reward.expiresAt && new Date(reward.expiresAt).getTime() <= Date.now() ? "expired" :
                  "issued",
  }));
}

/**
 * Update wallet top-up with OCR results and approval
 */
export async function updateWalletTopupWithOCRApproval(
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
  }
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

  await db.update(walletTopups).set(updateData).where(eq(walletTopups.id, topupId));

  return (await db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1))[0];
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
  adminUserId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // REAL DATABASE TRANSACTION: All operations succeed or all rollback
  return await db.transaction(async (tx) => {
    // Step 1: Fetch topup INSIDE transaction for consistency
    const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
    if (!topupResult || topupResult.length === 0) {
      throw new Error("Wallet top-up not found");
    }
    const topup = topupResult[0];

    // Step 2: Only proceed if status is pending or pending_review (idempotency)
    if (ocrData.status === "approved") {
      // For auto-approval: only update if still pending
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
        .where(and(eq(walletTopups.id, topupId), eq(walletTopups.status, "pending" as any)));

      const resultHeader = Array.isArray(updateResult) ? updateResult[0] : updateResult;
      const affectedRows = (resultHeader as any)?.affectedRows || 0;
      if (affectedRows === 0) {
        // Already processed - return existing topup without crediting again
        const existing = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);
        return existing[0];
      }
    } else {
      // For pending_review: update regardless of current status (admin review)
      await tx
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
        .where(eq(walletTopups.id, topupId));
      
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
