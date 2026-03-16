import { eq, and, or, desc, asc, inArray, isNull, isNotNull, gte, lte, count } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  novels,
  episodes,
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
  let query: any = db.select().from(novels).orderBy(desc(novels.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

export async function getNovelById(novelId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(novels).where(eq(novels.id, novelId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getNovelBySlug(slug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(novels).where(eq(novels.slug, slug)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getEpisodesByNovelId(novelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(episodes).where(eq(episodes.novelId, novelId)).orderBy(asc(episodes.episodeNumber));
}

export async function getEpisodeById(episodeId: number) {
  const db = await getDb();
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
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(novels).values({
    title: data.title,
    author: data.author || "",
    description: data.description || "",
    coverImageUrl: data.coverImageUrl || "",
    slug: data.title.toLowerCase().replace(/\s+/g, "-"),
    status: "ongoing",
  });
  return result;
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
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!data.episodeNumber || !data.episodeNumber.trim()) {
    throw new Error("Episode number is required");
  }
  const result = await db.insert(episodes).values({
    novelId: data.novelId,
    episodeNumber: data.episodeNumber.trim(),
    title: data.title,
    price: data.price,
    isFree: data.isFree || false,
    fileUrl: data.fileUrl || "",
  });
  return result;
}

export async function updateEpisode(episodeId: number, data: any) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
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

export async function clearCart(cartId: number) {
  const db = await getDb();
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
}) {
  const db = await getDb();
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

export async function getOrderById(orderId: number) {
  const db = await getDb();
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

export async function createOrderItems(items: Array<{ orderId: number; novelId: number; episodeId: number; unitPrice: string; discountAmount: string; finalPrice: string }>) {
  const db = await getDb();
  if (!db) return;
  await db.insert(orderItems).values(items as any);
}

export async function getOrderItems(orderId: number) {
  const db = await getDb();
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

export async function createPayment(orderId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(payments).values({ orderId, status: "pending" });
  return result;
}

export async function getPaymentByOrderId(orderId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getPaymentById(paymentId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateOrder(orderId: number, data: { status?: string; paymentStatus?: string }) {
  const db = await getDb();
  if (!db) return;

  const updateData: any = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.paymentStatus !== undefined) updateData.paymentStatus = data.paymentStatus;

  if (Object.keys(updateData).length === 0) return;

  await db.update(orders).set(updateData).where(eq(orders.id, orderId));
}

export async function updatePayment(paymentId: number, data: { slipImageUrl?: string; slipSubmittedAt?: Date; status?: "pending" | "approved" | "rejected" }) {
  const db = await getDb();
  if (!db) return;
  await db.update(payments).set(data).where(eq(payments.id, paymentId));
}

export async function approvePayment(paymentId: number, reviewedByUserId: number) {
  const db = await getDb();
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

export async function rejectPayment(paymentId: number, reviewedByUserId: number, rejectionReason: string) {
  const db = await getDb();
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
  let query: any = db.select().from(payments).where(eq(payments.status, "pending")).orderBy(desc(payments.createdAt));
  if (limit) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  return query;
}

// ============ PURCHASES (ENTITLEMENTS) ============

export async function createPurchase(userId: number, novelId: number, episodeId: number, orderId: number) {
  const db = await getDb();
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

export async function getPurchaseByUserAndEpisode(userId: number, episodeId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.episodeId, episodeId)))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
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

export async function getCouponByCode(code: string) {
  const db = await getDb();
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

export async function recordCouponUsage(couponId: number, userId: number | undefined, orderId: number) {
  const db = await getDb();
  if (!db) return;
  await db.insert(couponUsages).values({ couponId, userId, orderId });
}

// ============ POINTS ============

export async function getUserPointsBalance(userId: number) {
  const db = await getDb();
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
}) {
  const db = await getDb();
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

export async function recordOrderHistory(data: { orderId: number; action: string; fromStatus?: string; toStatus?: string; actorUserId?: number; note?: string }) {
  const db = await getDb();
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

  let slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!slug) slug = "novel";

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
export async function hasPointsBeenAwardedForOrder(orderId: number): Promise<boolean> {
  const db = await getDb();
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

export async function getAdminByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0];
}
