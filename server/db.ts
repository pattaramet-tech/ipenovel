import { eq, and, or, desc, asc, inArray, isNull, isNotNull } from "drizzle-orm";
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

  return result;
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

export async function createOrderItems(items: Array<{ orderId: number; novelId: number; episodeId: number; unitPrice: string; discountAmount: string; finalPrice: string }>) {
  const db = await getDb();
  if (!db) return;
  await db.insert(orderItems).values(items as any);
}

export async function getOrderItems(orderId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
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
  const result = await db.select().from(coupons).where(eq(coupons.code, code)).limit(1);
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
  const result = await db.insert(coupons).values({
    code: data.code,
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
