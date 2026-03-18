#!/usr/bin/env node

/**
 * Migration script: Map old single 'status' field to new 'publicationStatus' and 'storyStatus'
 * 
 * Usage:
 *   node scripts/migrate-novel-status.mjs --dry-run          (preview changes)
 *   node scripts/migrate-novel-status.mjs --execute --confirm-migration  (apply changes)
 * 
 * Mapping logic:
 * - All existing novels are assumed to be "published" (visible) unless they have a special marker
 * - Story status is inferred from old status values:
 *   - "ongoing" -> storyStatus = "ongoing"
 *   - "completed" -> storyStatus = "finished"
 *   - "finished" -> storyStatus = "finished"
 *   - "hiatus" -> storyStatus = "ongoing" (still writing, just paused)
 *   - default -> storyStatus = "ongoing"
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isExecute = args.includes('--execute');
const hasConfirmation = args.includes('--confirm-migration');

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

if (isExecute && !hasConfirmation) {
  console.error('ERROR: Execute mode requires --confirm-migration flag');
  console.error('Usage: node scripts/migrate-novel-status.mjs --execute --confirm-migration');
  process.exit(1);
}

async function migrate() {
  let connection;
  try {
    // Parse DATABASE_URL
    const url = new URL(DATABASE_URL);
    const config = {
      host: url.hostname,
      port: url.port ? parseInt(url.port) : 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1),
      ssl: url.searchParams.get('ssl') === 'true' ? 'Amazon RDS' : undefined,
    };

    console.log('Connecting to database...');
    connection = await mysql.createConnection(config);

    // Check if migration is needed
    console.log('Checking if migration is needed...\n');
    const [rows] = await connection.query(
      'SELECT COUNT(*) as count FROM novels WHERE publicationStatus IS NULL OR storyStatus IS NULL'
    );
    
    const needsMigration = rows[0].count > 0;
    if (!needsMigration) {
      console.log('✓ No migration needed - all novels already have both statuses');
      await connection.end();
      return;
    }

    console.log(`Found ${rows[0].count} novels that need migration\n`);

    // Get all novels that need migration
    const [novels] = await connection.query(
      'SELECT id, title, status FROM novels WHERE publicationStatus IS NULL OR storyStatus IS NULL ORDER BY id'
    );

    // Build migration plan
    const migrationPlan = [];
    const statusCounts = {};

    for (const novel of novels) {
      let publicationStatus = 'published';
      let storyStatus = 'ongoing';

      if (novel.status === 'completed' || novel.status === 'finished') {
        storyStatus = 'finished';
      } else if (novel.status === 'hiatus') {
        storyStatus = 'ongoing';
      } else if (novel.status === 'ongoing') {
        storyStatus = 'ongoing';
      }

      migrationPlan.push({
        id: novel.id,
        title: novel.title,
        oldStatus: novel.status,
        publicationStatus,
        storyStatus,
      });

      // Count status mappings
      const key = `${novel.status} -> ${storyStatus}`;
      statusCounts[key] = (statusCounts[key] || 0) + 1;
    }

    // Display dry-run summary
    console.log('═══════════════════════════════════════════════════════════');
    console.log('MIGRATION DRY-RUN SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`Total novels to migrate: ${migrationPlan.length}\n`);

    console.log('Status Mapping Summary:');
    console.log('─────────────────────────────────────────────────────────');
    for (const [mapping, count] of Object.entries(statusCounts)) {
      console.log(`  ${mapping}: ${count} novel(s)`);
    }
    console.log();

    console.log('All novels will be set to:');
    console.log('  publicationStatus: "published" (visible on public pages)');
    console.log('  (story progress preserved in storyStatus)\n');

    console.log('Sample novels to be migrated:');
    console.log('─────────────────────────────────────────────────────────');
    const sampleSize = Math.min(5, migrationPlan.length);
    for (let i = 0; i < sampleSize; i++) {
      const plan = migrationPlan[i];
      console.log(`  ID ${plan.id}: "${plan.title}"`);
      console.log(`    ${plan.oldStatus} → published + ${plan.storyStatus}`);
    }
    if (migrationPlan.length > sampleSize) {
      console.log(`  ... and ${migrationPlan.length - sampleSize} more`);
    }
    console.log();

    console.log('═══════════════════════════════════════════════════════════\n');

    // If dry-run only, stop here
    if (isDryRun) {
      console.log('✓ Dry-run complete. To execute migration, run:');
      console.log('  node scripts/migrate-novel-status.mjs --execute --confirm-migration\n');
      await connection.end();
      return;
    }

    // Execute migration
    if (isExecute && hasConfirmation) {
      console.log('Executing migration...\n');

      let migratedCount = 0;
      for (const plan of migrationPlan) {
        await connection.query(
          'UPDATE novels SET publicationStatus = ?, storyStatus = ? WHERE id = ?',
          [plan.publicationStatus, plan.storyStatus, plan.id]
        );

        migratedCount++;
        if (migratedCount % 10 === 0) {
          console.log(`  Migrated ${migratedCount}/${migrationPlan.length}...`);
        }
      }

      console.log(`\n✓ Successfully migrated ${migratedCount} novels`);
      console.log('\nMigration completed:');
      console.log('- All existing novels set to publicationStatus = "published"');
      console.log('- Story status mapped from old status values');
      console.log('- All changes persisted to database\n');
    }

    await connection.end();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    if (connection) {
      await connection.end();
    }
    process.exit(1);
  }
}

migrate();
