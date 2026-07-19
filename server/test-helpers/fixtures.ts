// Fixture factories for integration tests. Every factory inserts a real row
// against the test database (via getTestDb() - TEST_DATABASE_URL only, see
// testDb.ts) and returns the ID the database actually assigned - nothing
// here ever assumes an ID, and nothing here ever reuses another test's
// fixture. See docs/TEST_INFRASTRUCTURE.md.
//
// Only import this from a *.integration.test.ts file that exclusively uses
// getTestDb()/these factories for ALL of its database access (never mixed
// with server/db.ts's own functions in the same file) - db.ts's functions
// resolve their connection from DATABASE_URL, a different environment
// variable than TEST_DATABASE_URL, so mixing the two in one file can
// silently read/write two different databases. Legacy *.test.ts files that
// still use db.ts's functions directly (e.g. server/status-sync.test.ts)
// intentionally do NOT import from here - they fix their own uniqueness/
// cleanup locally instead. Integration test files are safe to use both
// db.ts's functions AND getTestDb()/fixtures.ts together, because
// vitest.integration.globalsetup.ts sets DATABASE_URL equal to
// TEST_DATABASE_URL for the duration of that project's run.
//
// Every factory takes a `tag` (or generates one) that becomes part of every
// unique field it writes (openId, slug, episodeNumber, orderNumber, coupon
// code) - callers should pass a per-test-run unique tag (see uniqueTestTag
// below) so that two tests, or two runs of the same test, can never collide
// on a unique constraint even if they run at the exact same millisecond or
// even in the same process tick (the historical bug in several existing
// test files that used `Date.now()` alone for uniqueness).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users, novels, episodes, orders, orderItems, payments, coupons } from "../../drizzle/schema";
import { getTestDb } from "./testDb";

/**
 * A short, collision-resistant tag safe to embed in varchar unique columns
 * (openId, slug, episodeNumber, orderNumber, coupon code). Uses a real
 * UUID, not Date.now() - two calls in the same millisecond (routine under
 * parallel test execution) still never collide.
 */
export function uniqueTestTag(prefix = "t"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function extractInsertId(result: any): number {
  const id = result?.[0]?.insertId ?? result?.insertId;
  if (!id) throw new Error("fixtures: failed to extract inserted ID from insert result");
  return id;
}

export interface TestUserFixture {
  id: number;
  openId: string;
}

export async function createTestUser(overrides: Partial<{ name: string; email: string; role: "user" | "admin" }> = {}): Promise<TestUserFixture> {
  const db = getTestDb();
  const tag = uniqueTestTag("user");
  const openId = `test-${tag}`;
  const result = await db.insert(users).values({
    openId,
    name: overrides.name ?? `Test User ${tag}`,
    email: overrides.email ?? `${tag}@example.test`,
    loginMethod: "test",
    role: overrides.role ?? "user",
  });
  return { id: extractInsertId(result), openId };
}

export interface TestNovelFixture {
  id: number;
  slug: string;
  title: string;
}

export async function createTestNovel(
  overrides: Partial<{
    title: string;
    publicationStatus: "published" | "archived";
    storyStatus: "ongoing" | "finished";
    createdAt: Date;
  }> = {}
): Promise<TestNovelFixture> {
  const db = getTestDb();
  const tag = uniqueTestTag("novel");
  const title = overrides.title ?? `Test Novel ${tag}`;
  const slug = `test-novel-${tag}`;
  const result = await db.insert(novels).values({
    title,
    slug,
    author: "Test Author",
    description: "Fixture novel created by an integration test - safe to delete.",
    publicationStatus: overrides.publicationStatus ?? "published",
    storyStatus: overrides.storyStatus ?? "ongoing",
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  return { id: extractInsertId(result), slug, title };
}

export interface TestEpisodeFixture {
  id: number;
  episodeNumber: string;
}

export async function createTestEpisode(
  novelId: number,
  overrides: Partial<{ price: string; isFree: boolean; isPublished: boolean; title: string }> = {}
): Promise<TestEpisodeFixture> {
  const db = getTestDb();
  const tag = uniqueTestTag("ep");
  const episodeNumber = `test-${tag}`;
  const result = await db.insert(episodes).values({
    novelId,
    episodeNumber,
    title: overrides.title ?? `Test Episode ${tag}`,
    price: overrides.price ?? "100.00",
    isFree: overrides.isFree ?? false,
    isPublished: overrides.isPublished ?? true,
    saleMode: "chapter",
  });
  return { id: extractInsertId(result), episodeNumber };
}

export interface TestOrderFixture {
  id: number;
  orderNumber: string;
}

export async function createTestOrder(
  userId: number,
  overrides: Partial<{ subtotal: string; totalAmount: string; discountAmount: string; couponCodeSnapshot: string }> = {}
): Promise<TestOrderFixture> {
  const db = getTestDb();
  const tag = uniqueTestTag("order");
  const orderNumber = `TEST-${tag}`;
  const subtotal = overrides.subtotal ?? "100.00";
  const result = await db.insert(orders).values({
    orderNumber,
    userId,
    subtotal,
    discountAmount: overrides.discountAmount ?? "0.00",
    pointsDiscountAmount: "0.00",
    totalAmount: overrides.totalAmount ?? subtotal,
    couponCodeSnapshot: overrides.couponCodeSnapshot,
  });
  return { id: extractInsertId(result), orderNumber };
}

/**
 * Inserts an orderItem for an already-created order/episode. Deliberately
 * requires the caller to have already created both (never invents a
 * plausible-looking orderId/episodeId) - this is the exact ordering bug
 * class ("insert orderItems ล้ม") this factory exists to make impossible to
 * get wrong: the types require an orderId and episodeId that some earlier
 * `createTestOrder`/`createTestEpisode` call already returned.
 */
export async function createTestOrderItem(params: {
  orderId: number;
  novelId: number;
  episodeId: number;
  unitPrice?: string;
}): Promise<{ id: number }> {
  const db = getTestDb();
  const unitPrice = params.unitPrice ?? "100.00";
  const result = await db.insert(orderItems).values({
    orderId: params.orderId,
    novelId: params.novelId,
    episodeId: params.episodeId,
    unitPrice,
    discountAmount: "0.00",
    finalPrice: unitPrice,
  });
  return { id: extractInsertId(result) };
}

export async function createTestPayment(orderId: number): Promise<{ id: number }> {
  const db = getTestDb();
  const result = await db.insert(payments).values({ orderId });
  return { id: extractInsertId(result) };
}

export interface TestCouponFixture {
  id: number;
  code: string;
}

export async function createTestCoupon(
  overrides: Partial<{
    discountType: "flat" | "percentage";
    discountValue: string;
    maxDiscountAmount: string | null;
    minPurchaseAmount: string;
    maxUsageCount: number | null;
    isActive: boolean;
    expiresAt: Date | null;
  }> = {}
): Promise<TestCouponFixture> {
  const db = getTestDb();
  const tag = uniqueTestTag("coupon");
  const code = `TEST${tag}`.toUpperCase();
  const result = await db.insert(coupons).values({
    code,
    discountType: overrides.discountType ?? "percentage",
    discountValue: overrides.discountValue ?? "10.00",
    maxDiscountAmount: overrides.maxDiscountAmount ?? null,
    minPurchaseAmount: overrides.minPurchaseAmount ?? "0.00",
    maxUsageCount: overrides.maxUsageCount ?? null,
    usageCount: 0,
    isActive: overrides.isActive ?? true,
    expiresAt: overrides.expiresAt ?? null,
  });
  return { id: extractInsertId(result), code };
}

/**
 * Delete a set of fixture rows by ID, in FK-safe (child-before-parent)
 * order. Every call is scoped to IDs this test itself created and returned
 * - never a blanket DELETE/TRUNCATE of a shared table (that would risk
 * deleting another concurrently-running test file's fixtures on a shared
 * test database). Logs (not throws) on a failed delete for an ID that
 * doesn't exist - deleting something already gone is not an error - but
 * rethrows any other failure so cleanup problems are never silently
 * swallowed.
 */
export async function deleteFixtures(ids: {
  orderItemIds?: number[];
  paymentIds?: number[];
  orderIds?: number[];
  episodeIds?: number[];
  novelIds?: number[];
  couponIds?: number[];
  userIds?: number[];
}): Promise<void> {
  const db = getTestDb();
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["orderItems", async () => ids.orderItemIds?.length && Promise.all(ids.orderItemIds.map((id) => db.delete(orderItems).where(eq(orderItems.id, id))))],
    ["payments", async () => ids.paymentIds?.length && Promise.all(ids.paymentIds.map((id) => db.delete(payments).where(eq(payments.id, id))))],
    ["orders", async () => ids.orderIds?.length && Promise.all(ids.orderIds.map((id) => db.delete(orders).where(eq(orders.id, id))))],
    ["episodes", async () => ids.episodeIds?.length && Promise.all(ids.episodeIds.map((id) => db.delete(episodes).where(eq(episodes.id, id))))],
    ["novels", async () => ids.novelIds?.length && Promise.all(ids.novelIds.map((id) => db.delete(novels).where(eq(novels.id, id))))],
    ["coupons", async () => ids.couponIds?.length && Promise.all(ids.couponIds.map((id) => db.delete(coupons).where(eq(coupons.id, id))))],
    ["users", async () => ids.userIds?.length && Promise.all(ids.userIds.map((id) => db.delete(users).where(eq(users.id, id))))],
  ];

  for (const [label, run] of steps) {
    try {
      await run();
    } catch (error: any) {
      // Fail loudly per PART E ("fail loudly เมื่อ cleanup ไม่สำเร็จ") - a
      // cleanup failure means the next test run starts from a dirty state,
      // which is exactly the flakiness class this infrastructure exists to
      // eliminate.
      throw new Error(`[fixtures] Cleanup failed while deleting ${label}: ${error?.message || error}`);
    }
  }
}
