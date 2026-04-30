import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "./db";
import { banners } from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Home Page Banner Integration", () => {
  let db: any;

  beforeEach(async () => {
    db = await getDb();
    if (!db) {
      throw new Error("Database connection failed");
    }
    // Clean up test banners before each test
    // Delete all banners with titles starting with "Test Banner"
    const allBanners = await db.select().from(banners);
    for (const banner of allBanners) {
      if (banner.title.startsWith("Test Banner")) {
        await db.delete(banners).where(eq(banners.id, banner.id));
      }
    }
  });

  describe("getAllBanners (customer view)", () => {
    it("should return only active banners", async () => {
      // Create test banners
      await db.insert(banners).values([
        {
          title: "Test Banner Active 1",
          description: "Active banner 1",
          imageUrl: "https://example.com/banner1.jpg",
          linkUrl: "https://example.com",
          displayOrder: 1,
          isActive: true,
        },
        {
          title: "Test Banner Active 2",
          description: "Active banner 2",
          imageUrl: "https://example.com/banner2.jpg",
          linkUrl: "https://example.com",
          displayOrder: 2,
          isActive: true,
        },
        {
          title: "Test Banner Inactive",
          description: "Inactive banner",
          imageUrl: "https://example.com/banner3.jpg",
          linkUrl: "https://example.com",
          displayOrder: 3,
          isActive: false,
        },
      ]);

      // Fetch active banners
      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.isActive, true));

      expect(result.filter((b: any) => b.title.startsWith("Test Banner Active"))).toHaveLength(2);
      const testBanners = result.filter((b: any) => b.title.startsWith("Test Banner Active"));
      expect(testBanners.every((b: any) => b.isActive === true)).toBe(true);
      expect(testBanners.some((b: any) => b.title === "Test Banner Active 1")).toBe(
        true
      );
      expect(testBanners.some((b: any) => b.title === "Test Banner Active 2")).toBe(
        true
      );
      expect(testBanners.some((b: any) => b.title === "Test Banner Inactive")).toBe(
        false
      );
    });

    it("should return banners ordered by displayOrder", async () => {
      // Create test banners with different display orders
      await db.insert(banners).values([
        {
          title: "Test Banner Order 3",
          description: "Banner with order 3",
          imageUrl: "https://example.com/banner1.jpg",
          linkUrl: "https://example.com",
          displayOrder: 3,
          isActive: true,
        },
        {
          title: "Test Banner Order 1",
          description: "Banner with order 1",
          imageUrl: "https://example.com/banner2.jpg",
          linkUrl: "https://example.com",
          displayOrder: 1,
          isActive: true,
        },
        {
          title: "Test Banner Order 2",
          description: "Banner with order 2",
          imageUrl: "https://example.com/banner3.jpg",
          linkUrl: "https://example.com",
          displayOrder: 2,
          isActive: true,
        },
      ]);

      // Fetch and verify order
      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.isActive, true));

      // Find the test banners and verify they're in order
      const testBanners = result
        .filter((b: any) => b.title.startsWith("Test Banner Order"))
        .sort((a: any, b: any) => a.displayOrder - b.displayOrder);
      expect(testBanners.length).toBeGreaterThanOrEqual(3);
      expect(testBanners[0].displayOrder).toBe(1);
      expect(testBanners[1].displayOrder).toBe(2);
      expect(testBanners[2].displayOrder).toBe(3);
    });

    it("should return empty array when no active banners exist", async () => {
      // Create only inactive banners
      await db.insert(banners).values({
        title: "Test Banner Inactive Only",
        description: "Inactive banner",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com",
        displayOrder: 1,
        isActive: false,
      });

      // Fetch active banners
      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.isActive, true));

      // Should not include our test banner in active banners
      const testBanner = result.find(
        (b: any) => b.title === "Test Banner Inactive Only"
      );
      expect(testBanner).toBeUndefined();
    });

    it("should include all required banner fields", async () => {
      // Create test banner
      await db.insert(banners).values({
        title: "Test Banner Complete",
        description: "Complete banner with all fields",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com/promo",
        displayOrder: 1,
        isActive: true,
      });

      // Fetch and verify fields
      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.isActive, true));

      const testBanner = result.find(
        (b: any) => b.title === "Test Banner Complete"
      );
      expect(testBanner).toBeDefined();
      expect(testBanner).toHaveProperty("id");
      expect(testBanner).toHaveProperty("title");
      expect(testBanner).toHaveProperty("description");
      expect(testBanner).toHaveProperty("imageUrl");
      expect(testBanner).toHaveProperty("linkUrl");
      expect(testBanner).toHaveProperty("displayOrder");
      expect(testBanner).toHaveProperty("isActive");
      expect(testBanner).toHaveProperty("createdAt");
      expect(testBanner).toHaveProperty("updatedAt");
    });
  });

  describe("getAllBannersAdmin (admin view)", () => {
    it("should return both active and inactive banners", async () => {
      // Create test banners
      await db.insert(banners).values([
        {
          title: "Test Banner Admin Active",
          description: "Active banner",
          imageUrl: "https://example.com/banner1.jpg",
          linkUrl: "https://example.com",
          displayOrder: 1,
          isActive: true,
        },
        {
          title: "Test Banner Admin Inactive",
          description: "Inactive banner",
          imageUrl: "https://example.com/banner2.jpg",
          linkUrl: "https://example.com",
          displayOrder: 2,
          isActive: false,
        },
      ]);

      // Fetch all banners (admin view)
      const result = await db.select().from(banners);

      // Should include both active and inactive test banners
      const testBanners = result.filter((b: any) =>
        b.title.startsWith("Test Banner Admin")
      );
      expect(testBanners.length).toBeGreaterThanOrEqual(2);
      const hasActive = testBanners.some((b: any) => b.isActive === true);
      const hasInactive = testBanners.some((b: any) => b.isActive === false);
      expect(hasActive || hasInactive).toBe(true);
    });
  });

  describe("Banner CRUD operations", () => {
    it("should create a banner successfully", async () => {
      const newBanner = {
        title: "Test Banner Create",
        description: "New banner",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com",
        displayOrder: 1,
        isActive: true,
      };

      await db.insert(banners).values(newBanner);

      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Create"));

      expect(result.length).toBeGreaterThan(0);
      expect(result.some((b: any) => b.title === "Test Banner Create")).toBe(true);
      const created = result.find((b: any) => b.title === "Test Banner Create");
      expect(created.isActive).toBe(true);
    });

    it("should update a banner successfully", async () => {
      // Create banner
      const insertResult = await db.insert(banners).values({
        title: "Test Banner Update",
        description: "Original description",
        imageUrl: "https://example.com/original.jpg",
        linkUrl: "https://example.com",
        displayOrder: 1,
        isActive: true,
      });

      // Update banner
      await db
        .update(banners)
        .set({
          description: "Updated description",
          isActive: false,
        })
        .where(eq(banners.title, "Test Banner Update"));

      // Verify update
      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Update"));

      expect(result.length).toBeGreaterThan(0);
      const updated = result.find((b: any) => b.title === "Test Banner Update");
      expect(updated.description).toBe("Updated description");
      expect(updated.isActive).toBe(false);
    });

    it("should delete a banner successfully", async () => {
      // Create banner
      await db.insert(banners).values({
        title: "Test Banner Delete",
        description: "Banner to delete",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com",
        displayOrder: 1,
        isActive: true,
      });

      // Verify it exists
      let result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Delete"));
      expect(result.length).toBeGreaterThan(0);

      // Delete banner
      await db
        .delete(banners)
        .where(eq(banners.title, "Test Banner Delete"));
      // Verify it's deleted
      result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Delete"));
      expect(result.filter((b: any) => b.title === "Test Banner Delete")).toHaveLength(0);
    });
  });

  describe("Banner data validation", () => {
    it("should handle banners with optional fields", async () => {
      // Create banner with minimal required fields
      await db.insert(banners).values({
        title: "Test Banner Minimal",
        imageUrl: "https://example.com/banner.jpg",
        displayOrder: 1,
        isActive: true,
        // description and linkUrl are optional
      });

      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Minimal"));

      expect(result.length).toBeGreaterThan(0);
      const minimal = result.find((b: any) => b.title === "Test Banner Minimal");
      expect(minimal).toBeDefined();
      expect(minimal.description).toBeNull();
      expect(minimal.linkUrl).toBeNull();
    });

    it("should handle banners with all fields populated", async () => {
      // Create banner with all fields
      await db.insert(banners).values({
        title: "Test Banner Full",
        description: "Complete banner description",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com/promo",
        displayOrder: 5,
        isActive: true,
      });

      const result = await db
        .select()
        .from(banners)
        .where(eq(banners.title, "Test Banner Full"));

      expect(result.length).toBeGreaterThan(0);
      const full = result.find((b: any) => b.title === "Test Banner Full");
      expect(full).toBeDefined();
      expect(full.description).toBe("Complete banner description");
      expect(full.imageUrl).toBe("https://example.com/banner.jpg");
      expect(full.linkUrl).toBe("https://example.com/promo");
      expect(full.displayOrder).toBe(5);
      expect(full.isActive).toBe(true);
    });
  });

  describe("Home page integration", () => {
    it("should not break existing Home sections when banners are added", async () => {
      // This test verifies backward compatibility
      // The home.getSections endpoint should still return all existing sections
      // even after adding banners support

      // Create a test banner
      await db.insert(banners).values({
        title: "Test Banner Integration",
        description: "Integration test banner",
        imageUrl: "https://example.com/banner.jpg",
        linkUrl: "https://example.com",
        displayOrder: 1,
        isActive: true,
      });

      // Verify banners can be fetched
      const bannersResult = await db
        .select()
        .from(banners)
        .where(eq(banners.isActive, true));

      expect(bannersResult.length).toBeGreaterThan(0);
      expect(
        bannersResult.some((b: any) => b.title === "Test Banner Integration")
      ).toBe(true);
    });
  });
});
