/**
 * Seed Script - Populate database with test data
 * Run with: node seed.mjs
 */

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema.js";

const DATABASE_URL = process.env.DATABASE_URL || "mysql://root@localhost/ipenovel";

async function seed() {
  console.log("🌱 Starting database seed...");

  try {
    // Parse connection string
    const url = new URL(DATABASE_URL);
    const connection = await mysql.createConnection({
      host: url.hostname,
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1),
    });

    const db = drizzle(connection);

    // Seed categories
    console.log("📚 Seeding categories...");
    const categories = [
      { name: "Fantasy", slug: "fantasy", description: "Fantasy novels and stories" },
      { name: "Romance", slug: "romance", description: "Romance and love stories" },
      { name: "Mystery", slug: "mystery", description: "Mystery and thriller novels" },
      { name: "Sci-Fi", slug: "sci-fi", description: "Science fiction novels" },
      { name: "Drama", slug: "drama", description: "Drama and emotional stories" },
    ];

    for (const cat of categories) {
      await db.insert(schema.categories).values(cat).onDuplicateKeyUpdate({ set: cat });
    }

    // Seed novels
    console.log("📖 Seeding novels...");
    const novels = [
      {
        title: "The Eternal Kingdom",
        slug: "eternal-kingdom",
        description: "An epic fantasy adventure across mystical realms",
        author: "Author One",
        coverImageUrl: "https://via.placeholder.com/300x400?text=Eternal+Kingdom",
        status: "ongoing",
      },
      {
        title: "Hearts Intertwined",
        slug: "hearts-intertwined",
        description: "A beautiful romance spanning continents",
        author: "Author Two",
        coverImageUrl: "https://via.placeholder.com/300x400?text=Hearts+Intertwined",
        status: "completed",
      },
      {
        title: "The Last Detective",
        slug: "last-detective",
        description: "A gripping mystery that will keep you guessing",
        author: "Author Three",
        coverImageUrl: "https://via.placeholder.com/300x400?text=Last+Detective",
        status: "ongoing",
      },
      {
        title: "Beyond the Stars",
        slug: "beyond-stars",
        description: "A sci-fi journey to distant galaxies",
        author: "Author Four",
        coverImageUrl: "https://via.placeholder.com/300x400?text=Beyond+Stars",
        status: "hiatus",
      },
    ];

    const novelIds = [];
    for (const novel of novels) {
      const result = await db.insert(schema.novels).values(novel).onDuplicateKeyUpdate({ set: novel });
      novelIds.push(result[0]?.insertId || 1);
    }

    // Seed episodes
    console.log("📄 Seeding episodes...");
    const episodes = [
      { novelId: novelIds[0], episodeNumber: "1", title: "The Beginning", price: "29.99", isFree: false },
      { novelId: novelIds[0], episodeNumber: "2", title: "The Journey Begins", price: "29.99", isFree: false },
      { novelId: novelIds[0], episodeNumber: "3 - 5", title: "Triple Episode Pack", price: "79.99", isFree: false },
      { novelId: novelIds[1], episodeNumber: "1", title: "First Meeting", price: "0.00", isFree: true },
      { novelId: novelIds[1], episodeNumber: "2", title: "Growing Closer", price: "29.99", isFree: false },
      { novelId: novelIds[2], episodeNumber: "1", title: "The Crime Scene", price: "34.99", isFree: false },
      { novelId: novelIds[3], episodeNumber: "1", title: "Launch into Space", price: "39.99", isFree: false },
    ];

    for (const episode of episodes) {
      await db.insert(schema.episodes).values(episode).onDuplicateKeyUpdate({ set: episode });
    }

    // Seed coupons
    console.log("🎟️  Seeding coupons...");
    const coupons = [
      {
        code: "WELCOME20",
        discountType: "flat",
        discountValue: "20.00",
        minPurchaseAmount: "100.00",
        maxUsageCount: 100,
        isActive: true,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      },
      {
        code: "SUMMER30",
        discountType: "percentage",
        discountValue: "30",
        minPurchaseAmount: "50.00",
        maxUsageCount: null,
        isActive: true,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
      },
      {
        code: "EXPIRED",
        discountType: "flat",
        discountValue: "50.00",
        minPurchaseAmount: "0.00",
        maxUsageCount: null,
        isActive: false,
        expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // Expired yesterday
      },
    ];

    for (const coupon of coupons) {
      await db.insert(schema.coupons).values(coupon).onDuplicateKeyUpdate({ set: coupon });
    }

    // Seed banners
    console.log("🎨 Seeding banners...");
    const banners = [
      {
        title: "Summer Sale",
        description: "Get 30% off all episodes this summer!",
        imageUrl: "https://via.placeholder.com/1200x300?text=Summer+Sale",
        linkUrl: "/novels",
        displayOrder: 1,
        isActive: true,
      },
      {
        title: "New Releases",
        description: "Check out our latest novel releases",
        imageUrl: "https://via.placeholder.com/1200x300?text=New+Releases",
        linkUrl: "/novels?sort=new",
        displayOrder: 2,
        isActive: true,
      },
    ];

    for (const banner of banners) {
      await db.insert(schema.banners).values(banner).onDuplicateKeyUpdate({ set: banner });
    }

    console.log("✅ Seed completed successfully!");
    await connection.end();
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

seed();
