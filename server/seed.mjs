/**
 * Seed Script - Populate database with test data
 * Run with: node seed.mjs
 */

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema.ts";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL environment variable not set");
  process.exit(1);
}

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
      ssl: { rejectUnauthorized: false },
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
      { name: "Action", slug: "action", description: "Action and adventure stories" },
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
      {
        title: "Shadow Warrior",
        slug: "shadow-warrior",
        description: "An action-packed tale of a warrior seeking redemption",
        author: "Author Five",
        coverImageUrl: "https://via.placeholder.com/300x400?text=Shadow+Warrior",
        status: "ongoing",
      },
    ];

    const novelIds = [];
    for (const novel of novels) {
      const result = await db.insert(schema.novels).values(novel).onDuplicateKeyUpdate({ set: novel });
      novelIds.push(result[0]?.insertId || 1);
    }

    // Seed episodes with episode ranges
    console.log("📄 Seeding episodes...");
    const episodes = [
      // The Eternal Kingdom
      { novelId: novelIds[0], episodeNumber: "1-10", title: "The Beginning", price: "29.99", isFree: true },
      { novelId: novelIds[0], episodeNumber: "11-20", title: "The Journey Begins", price: "29.99", isFree: false },
      { novelId: novelIds[0], episodeNumber: "21-30", title: "The Dark Forest", price: "29.99", isFree: false },
      { novelId: novelIds[0], episodeNumber: "31-50", title: "Triple Episode Pack", price: "79.99", isFree: false },
      // Hearts Intertwined
      { novelId: novelIds[1], episodeNumber: "1-5", title: "First Meeting", price: "0.00", isFree: true },
      { novelId: novelIds[1], episodeNumber: "6-15", title: "Growing Closer", price: "29.99", isFree: false },
      { novelId: novelIds[1], episodeNumber: "16-25", title: "Confessions", price: "34.99", isFree: false },
      // The Last Detective
      { novelId: novelIds[2], episodeNumber: "1-10", title: "The Crime Scene", price: "34.99", isFree: false },
      { novelId: novelIds[2], episodeNumber: "11-20", title: "Clues and Suspects", price: "34.99", isFree: false },
      { novelId: novelIds[2], episodeNumber: "21-30", title: "The Revelation", price: "39.99", isFree: false },
      // Beyond the Stars
      { novelId: novelIds[3], episodeNumber: "1-8", title: "Launch into Space", price: "0.00", isFree: true },
      { novelId: novelIds[3], episodeNumber: "9-20", title: "First Contact", price: "39.99", isFree: false },
      { novelId: novelIds[3], episodeNumber: "21-35", title: "Alien Worlds", price: "44.99", isFree: false },
      // Shadow Warrior
      { novelId: novelIds[4], episodeNumber: "1-12", title: "The Beginning", price: "0.00", isFree: true },
      { novelId: novelIds[4], episodeNumber: "13-25", title: "Training", price: "29.99", isFree: false },
      { novelId: novelIds[4], episodeNumber: "26-40", title: "The Final Battle", price: "39.99", isFree: false },
    ];

    for (const episode of episodes) {
      await db.insert(schema.episodes).values(episode).onDuplicateKeyUpdate({ set: episode });
    }

    // Seed novel categories
    console.log("🏷️  Seeding novel categories...");
    const novelCategories = [
      { novelId: novelIds[0], categoryId: 1 }, // Eternal Kingdom - Fantasy
      { novelId: novelIds[0], categoryId: 6 }, // Eternal Kingdom - Action
      { novelId: novelIds[1], categoryId: 2 }, // Hearts Intertwined - Romance
      { novelId: novelIds[1], categoryId: 5 }, // Hearts Intertwined - Drama
      { novelId: novelIds[2], categoryId: 3 }, // Last Detective - Mystery
      { novelId: novelIds[3], categoryId: 4 }, // Beyond the Stars - Sci-Fi
      { novelId: novelIds[4], categoryId: 6 }, // Shadow Warrior - Action
      { novelId: novelIds[4], categoryId: 1 }, // Shadow Warrior - Fantasy
    ];

    for (const nc of novelCategories) {
      await db.insert(schema.novelCategories).values(nc).onDuplicateKeyUpdate({ set: nc });
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
        code: "NEWUSER10",
        discountType: "percentage",
        discountValue: "10",
        minPurchaseAmount: "0.00",
        maxUsageCount: 1000,
        isActive: true,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
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
      {
        title: "Best Sellers",
        description: "Most loved novels by our readers",
        imageUrl: "https://via.placeholder.com/1200x300?text=Best+Sellers",
        linkUrl: "/novels?sort=popular",
        displayOrder: 3,
        isActive: true,
      },
    ];

    for (const banner of banners) {
      await db.insert(schema.banners).values(banner).onDuplicateKeyUpdate({ set: banner });
    }

    // Seed settings
    console.log("⚙️  Seeding settings...");
    const settings = [
      { key: "site_title", value: "Ipenovel - Digital Novel Store", description: "Site title" },
      { key: "site_description", value: "Read translated novels with flexible payment options", description: "Site description" },
      { key: "points_conversion_rate", value: "100", description: "100 currency units = 1 point" },
      { key: "discord_webhook_url", value: "", description: "Discord webhook for order notifications" },
      { key: "max_file_size_mb", value: "100", description: "Maximum file size in MB" },
    ];

    for (const setting of settings) {
      await db.insert(schema.settings).values(setting).onDuplicateKeyUpdate({ set: setting });
    }

    console.log("\n✅ Seed completed successfully!");
    console.log("\n📊 Summary:");
    console.log(`   ✓ ${categories.length} categories created`);
    console.log(`   ✓ ${novels.length} novels created`);
    console.log(`   ✓ ${episodes.length} episodes created (with episode ranges)`);
    console.log(`   ✓ ${novelCategories.length} novel-category assignments`);
    console.log(`   ✓ ${coupons.length} coupons created`);
    console.log(`   ✓ ${banners.length} banners created`);
    console.log(`   ✓ ${settings.length} settings created`);
    console.log("\n🎯 Test Data Ready:");
    console.log("   - Browse novels at /novels");
    console.log("   - Add episodes to cart");
    console.log("   - Use coupon codes: WELCOME20, SUMMER30, NEWUSER10");
    console.log("   - Admin dashboard at /admin");

    await connection.end();
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

seed();
