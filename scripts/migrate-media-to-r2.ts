import { Command } from 'commander';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { novels, banners } from '../drizzle/schema';
import { eq, and, notLike, isNotNull } from 'drizzle-orm';
import { optimizeImageToWebp, NOVEL_COVER_PRESET, BANNER_IMAGE_PRESET } from '../server/services/imageOptimizer';
import { r2Put } from '../server/services/r2Storage';
import axios from 'axios';
import * as crypto from 'crypto';

// Load environment variables
import 'dotenv/config';

const program = new Command();

program
  .option('--dry-run', 'Perform a dry run without making any changes', false)
  .option('--limit <number>', 'Limit the number of items to process', '20')
  .option('--type <type>', 'Type of media to migrate (novels, banners, all)', 'all')
  .option('--start-id <id>', 'Start processing from a specific ID')
  .option('--force', 'Force migration even if URL starts with R2_PUBLIC_BASE_URL', false)
  .parse(process.argv);

const options = program.opts();

const DRY_RUN = options.dryRun;
const LIMIT = parseInt(options.limit, 10);
const TYPE = options.type;
const START_ID = options.startId ? parseInt(options.startId, 10) : undefined;
const FORCE = options.force;

console.log(`Migration script started with options:`);
console.log(`  Dry Run: ${DRY_RUN}`);
console.log(`  Limit: ${LIMIT}`);
console.log(`  Type: ${TYPE}`);
console.log(`  Start ID: ${START_ID || 'N/A'}`);
console.log(`  Force: ${FORCE}`);

// Validate TYPE option
if (!['novels', 'banners', 'all'].includes(TYPE)) {
  console.error('Error: --type must be one of novels, banners, or all.');
  process.exit(1);
}

// Check for DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

// Check R2 environment variables if not in dry-run mode
if (!DRY_RUN) {
  const requiredR2Envs = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_BASE_URL',
    'R2_ENDPOINT',
  ];
  const missingEnvs = requiredR2Envs.filter(env => !process.env[env]);
  if (missingEnvs.length > 0) {
    console.error(`Error: Missing R2 environment variables for actual run: ${missingEnvs.join(', ')}`);
    process.exit(1);
  }
}

const connection = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(connection);

const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://media.ipenovel.com';

let totalChecked = 0;
let migratedCount = 0;
let skippedCount = 0;
let failedCount = 0;

async function migrateMedia() {
  console.log('\nStarting media migration...');

  if (TYPE === 'novels' || TYPE === 'all') {
    await processNovels();
  }

  if (TYPE === 'banners' || TYPE === 'all') {
    await processBanners();
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Total Checked: ${totalChecked}`);
  console.log(`Migrated: ${migratedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Dry Run: ${DRY_RUN}`);

  await connection.end();
  process.exit(0);
}

async function processNovels() {
  console.log('\nProcessing novels...');
  const novelQuery = db.select().from(novels).where(
    and(
      isNotNull(novels.coverImageUrl),
      FORCE ? undefined : notLike(novels.coverImageUrl, `${R2_PUBLIC_BASE_URL}%`),
      FORCE ? undefined : notLike(novels.coverImageUrl, `https://media.ipenovel.com%`),
      START_ID ? eq(novels.id, START_ID) : undefined // Simplified for now, will adjust for range
    )
  ).limit(LIMIT);

  const novelsToMigrate = await novelQuery;

  for (const novel of novelsToMigrate) {
    totalChecked++;
    console.log(`  Checking novel ID: ${novel.id}, current coverImageUrl: ${novel.coverImageUrl}`);

    if (novel.coverImageUrl && !FORCE && (novel.coverImageUrl.startsWith(R2_PUBLIC_BASE_URL) || novel.coverImageUrl.startsWith('https://media.ipenovel.com'))) {
      console.log(`    Skipping novel ID ${novel.id}: Already migrated or uses R2 URL.`);
      skippedCount++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`    [DRY RUN] Would migrate novel ID: ${novel.id}, URL: ${novel.coverImageUrl}`);
      migratedCount++; // Count as migrated in dry run for reporting
      continue;
    }

    try {
      const oldImageUrl = novel.coverImageUrl!;
      console.log(`    Downloading image from: ${oldImageUrl}`);
      const response = await axios.get(oldImageUrl, { responseType: 'arraybuffer' });

      if (response.status !== 200) {
        throw new Error(`Failed to download image, HTTP status: ${response.status}`);
      }
      if (!response.headers['content-type']?.startsWith('image/')) {
        throw new Error(`Invalid content type: ${response.headers['content-type']}`);
      }

      const imageBuffer = Buffer.from(response.data);
      // TODO: Add max file size check

      console.log(`    Optimizing image for novel ID: ${novel.id}`);
      const optimizedImage = await optimizeImageToWebp(imageBuffer, NOVEL_COVER_PRESET);

      const timestamp = Date.now();
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      const fileKey = `novel-covers/migrated/${novel.id}/${timestamp}-${randomSuffix}.webp`;

      console.log(`    Uploading optimized image to R2 for novel ID: ${novel.id}, key: ${fileKey}`);
      const { url: newImageUrl } = await r2Put(fileKey, optimizedImage.buffer, optimizedImage.contentType);

      console.log(`    Updating database for novel ID: ${novel.id}, new URL: ${newImageUrl}`);
      await db.update(novels).set({ coverImageUrl: newImageUrl }).where(eq(novels.id, novel.id));

      migratedCount++;
      console.log(`    Successfully migrated novel ID: ${novel.id}`);
    } catch (error: any) {
      failedCount++;
      console.error(`    Failed to migrate novel ID ${novel.id}: ${error.message}`);
    }
  }
}

async function processBanners() {
  console.log('\nProcessing banners...');
  const bannerQuery = db.select().from(banners).where(
    and(
      isNotNull(banners.imageUrl),
      FORCE ? undefined : notLike(banners.imageUrl, `${R2_PUBLIC_BASE_URL}%`),
      FORCE ? undefined : notLike(banners.imageUrl, `https://media.ipenovel.com%`),
      START_ID ? eq(banners.id, START_ID) : undefined // Simplified for now, will adjust for range
    )
  ).limit(LIMIT);

  const bannersToMigrate = await bannerQuery;

  for (const banner of bannersToMigrate) {
    totalChecked++;
    console.log(`  Checking banner ID: ${banner.id}, current imageUrl: ${banner.imageUrl}`);

    if (banner.imageUrl && !FORCE && (banner.imageUrl.startsWith(R2_PUBLIC_BASE_URL) || banner.imageUrl.startsWith('https://media.ipenovel.com'))) {
      console.log(`    Skipping banner ID ${banner.id}: Already migrated or uses R2 URL.`);
      skippedCount++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`    [DRY RUN] Would migrate banner ID: ${banner.id}, URL: ${banner.imageUrl}`);
      migratedCount++; // Count as migrated in dry run for reporting
      continue;
    }

    try {
      const oldImageUrl = banner.imageUrl!;
      console.log(`    Downloading image from: ${oldImageUrl}`);
      const response = await axios.get(oldImageUrl, { responseType: 'arraybuffer' });

      if (response.status !== 200) {
        throw new Error(`Failed to download image, HTTP status: ${response.status}`);
      }
      if (!response.headers['content-type']?.startsWith('image/')) {
        throw new Error(`Invalid content type: ${response.headers['content-type']}`);
      }

      const imageBuffer = Buffer.from(response.data);
      // TODO: Add max file size check

      console.log(`    Optimizing image for banner ID: ${banner.id}`);
      const optimizedImage = await optimizeImageToWebp(imageBuffer, BANNER_IMAGE_PRESET);

      const timestamp = Date.now();
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      const fileKey = `banners/migrated/${banner.id}/${timestamp}-${randomSuffix}.webp`;

      console.log(`    Uploading optimized image to R2 for banner ID: ${banner.id}, key: ${fileKey}`);
      const { url: newImageUrl } = await r2Put(fileKey, optimizedImage.buffer, optimizedImage.contentType);

      console.log(`    Updating database for banner ID: ${banner.id}, new URL: ${newImageUrl}`);
      await db.update(banners).set({ imageUrl: newImageUrl }).where(eq(banners.id, banner.id));

      migratedCount++;
      console.log(`    Successfully migrated banner ID: ${banner.id}`);
    } catch (error: any) {
      failedCount++;
      console.error(`    Failed to migrate banner ID ${banner.id}: ${error.message}`);
    }
  }
}

migrateMedia();
