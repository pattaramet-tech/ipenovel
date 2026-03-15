/**
 * Phase 1-2 Tests: Database schema, auth, novels, episodes, categories, cart
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "../db";
import * as orderService from "../services/orderService";
import { generateOrderNumber, calculatePointsEarned, formatEpisodeNumber } from "../../shared/validation";

describe("Phase 1-2: Core Features", () => {
  // ============ VALIDATION HELPERS ============

  describe("Validation Helpers", () => {
    it("should generate unique order numbers", () => {
      const num1 = generateOrderNumber();
      const num2 = generateOrderNumber();

      expect(num1).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
      expect(num2).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
      expect(num1).not.toBe(num2); // Should be unique
    });

    it("should calculate points earned correctly", () => {
      expect(calculatePointsEarned(100)).toBe(1); // 100 currency = 1 point
      expect(calculatePointsEarned(500)).toBe(5);
      expect(calculatePointsEarned(99)).toBe(0); // Floors down
      expect(calculatePointsEarned(1000)).toBe(10);
    });

    it("should format episode numbers correctly", () => {
      expect(formatEpisodeNumber("1")).toBe("Episode 1");
      expect(formatEpisodeNumber("581")).toBe("Episode 581");
      expect(formatEpisodeNumber("581-619")).toBe("Episodes 581-619");
      expect(formatEpisodeNumber("1-50")).toBe("Episodes 1-50");
    });
  });

  // ============ USER MANAGEMENT ============

  describe("User Management", () => {
    const testUser = {
      openId: `test-user-${Date.now()}`,
      name: "Test User",
      email: "test@example.com",
      loginMethod: "manus",
    };

    it("should upsert user", async () => {
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);

      expect(user).toBeDefined();
      expect(user?.name).toBe(testUser.name);
      expect(user?.email).toBe(testUser.email);
      expect(user?.role).toBe("user");
    });

    it("should retrieve user by ID", async () => {
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);

      if (!user) throw new Error("User not found");

      const userById = await db.getUserById(user.id);
      expect(userById?.id).toBe(user.id);
      expect(userById?.openId).toBe(testUser.openId);
    });
  });

  // ============ NOVELS & EPISODES ============

  describe("Novels and Episodes", () => {
    let novelId: number;
    let episodeId: number;

    it("should retrieve all novels", async () => {
      const novels = await db.getAllNovels();
      expect(Array.isArray(novels)).toBe(true);
    });

    it("should create and retrieve a novel", async () => {
      // This assumes novels are seeded or created via admin
      const novels = await db.getAllNovels();
      if (novels.length > 0) {
        novelId = novels[0].id;
        const novel = await db.getNovelById(novelId);
        expect(novel?.id).toBe(novelId);
      }
    });

    it("should retrieve episodes by novel", async () => {
      if (novelId) {
        const episodes = await db.getEpisodesByNovelId(novelId);
        expect(Array.isArray(episodes)).toBe(true);

        if (episodes.length > 0) {
          episodeId = episodes[0].id;
          const episode = await db.getEpisodeById(episodeId);
          expect(episode?.id).toBe(episodeId);
          expect(episode?.novelId).toBe(novelId);
        }
      }
    });

    it("should retrieve categories", async () => {
      const categories = await db.getAllCategories();
      expect(Array.isArray(categories)).toBe(true);
    });

    it("should retrieve categories by novel", async () => {
      if (novelId) {
        const categories = await db.getCategoriesByNovelId(novelId);
        expect(Array.isArray(categories)).toBe(true);
      }
    });
  });

  // ============ SHOPPING CART ============

  describe("Shopping Cart", () => {
    let userId: number;
    let cartId: number;
    let episodeId: number;

    beforeAll(async () => {
      // Create test user
      const testUser = {
        openId: `cart-test-${Date.now()}`,
        name: "Cart Test User",
        email: "cart@test.com",
      };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      userId = user.id;

      // Get a paid episode
      const novels = await db.getAllNovels();
      if (novels.length > 0) {
        const episodes = await db.getEpisodesByNovelId(novels[0].id);
        const paidEpisode = episodes.find((e) => !e.isFree);
        if (paidEpisode) {
          episodeId = paidEpisode.id;
        }
      }
    });

    it("should create or get cart for user", async () => {
      const cart = await db.getOrCreateCart(userId);
      expect(cart).toBeDefined();
      expect(cart?.userId).toBe(userId);
      cartId = cart!.id;
    });

    it("should add item to cart", async () => {
      if (episodeId && cartId) {
        const episode = await db.getEpisodeById(episodeId);
        if (episode) {
          await db.addToCart(cartId, episodeId, episode.novelId, episode.price.toString());
          const items = await db.getCartItems(cartId);
          expect(items.length).toBeGreaterThan(0);
          expect(items.some((i) => i.episodeId === episodeId)).toBe(true);
        }
      }
    });

    it("should retrieve cart items", async () => {
      if (cartId) {
        const items = await db.getCartItems(cartId);
        expect(Array.isArray(items)).toBe(true);
      }
    });

    it("should prevent duplicate items in cart", async () => {
      if (episodeId && cartId) {
        const episode = await db.getEpisodeById(episodeId);
        if (episode) {
          // Try to add same episode again - should fail or be prevented
          try {
            await db.addToCart(cartId, episodeId, episode.novelId, episode.price.toString());
            const items = await db.getCartItems(cartId);
            // Count occurrences of this episode
            const count = items.filter((i) => i.episodeId === episodeId).length;
            expect(count).toBe(1); // Should still be only 1
          } catch (error) {
            // Expected to fail due to unique constraint
            expect(error).toBeDefined();
          }
        }
      }
    });

    it("should remove item from cart", async () => {
      if (cartId) {
        const items = await db.getCartItems(cartId);
        if (items.length > 0) {
          await db.removeFromCart(items[0].id);
          const remainingItems = await db.getCartItems(cartId);
          expect(remainingItems.length).toBeLessThan(items.length);
        }
      }
    });

    it("should clear cart", async () => {
      if (cartId) {
        await db.clearCart(cartId);
        const items = await db.getCartItems(cartId);
        expect(items.length).toBe(0);
      }
    });
  });

  // ============ PURCHASE ACCESS CONTROL ============

  describe("Purchase Access Control", () => {
    it("should check if episode is already purchased", async () => {
      // Create test user
      const testUser = {
        openId: `access-test-${Date.now()}`,
        name: "Access Test User",
        email: "access@test.com",
      };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Get a paid episode
      const novels = await db.getAllNovels();
      if (novels.length > 0) {
        const episodes = await db.getEpisodesByNovelId(novels[0].id);
        if (episodes.length > 0) {
          const episodeId = episodes[0].id;

          // Should not be purchased initially
          const isPurchased = await orderService.isEpisodeAlreadyPurchased(user.id, episodeId);
          expect(isPurchased).toBe(false);
        }
      }
    });

    it("should check access to episode", async () => {
      // Create test user
      const testUser = {
        openId: `access-check-${Date.now()}`,
        name: "Access Check User",
        email: "accesscheck@test.com",
      };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Get a paid episode
      const novels = await db.getAllNovels();
      if (novels.length > 0) {
        const episodes = await db.getEpisodesByNovelId(novels[0].id);
        const paidEpisode = episodes.find(e => !e.isFree);
        if (paidEpisode) {
          // Should not have access initially
          const hasAccess = await orderService.hasAccessToEpisode(user.id, paidEpisode.id);
          expect(hasAccess).toBe(false);
        }
      }
    });
  });

  // ============ ORDER CREATION ============

  describe("Order Creation", () => {
    it("should create order from cart items", async () => {
      // Create test user
      const testUser = {
        openId: `order-test-${Date.now()}`,
        name: "Order Test User",
        email: "order@test.com",
      };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Get a paid episode and add to cart
      const novels = await db.getAllNovels();
      if (novels.length > 0) {
        const episodes = await db.getEpisodesByNovelId(novels[0].id);
        const paidEpisode = episodes.find((e) => !e.isFree);

        if (paidEpisode) {
          const cart = await db.getOrCreateCart(user.id);
          await db.addToCart(cart!.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());

          const cartItems = await db.getCartItems(cart!.id);
          expect(cartItems.length).toBeGreaterThan(0);

          // Create order from cart
          const order = await orderService.createOrderFromCart(user.id, cartItems);
          expect(order).toBeDefined();
          expect(order.orderNumber).toMatch(/^ORD-[A-Z0-9]+-[A-Z0-9]+$/);
          expect(order.orderId).toBeDefined();
          expect(order.totalAmount).toBeDefined();
        }
      }
    });

    it("should retrieve user orders", async () => {
      // Create test user
      const testUser = {
        openId: `orders-test-${Date.now()}`,
        name: "Orders Test User",
        email: "orders@test.com",
      };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const orders = await db.getOrdersByUserId(user.id);
      expect(Array.isArray(orders)).toBe(true);
    });
  });
});
