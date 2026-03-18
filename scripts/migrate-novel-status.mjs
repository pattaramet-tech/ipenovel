#!/usr/bin/env node

/**
 * Migration script: Map old single 'status' field to new 'publicationStatus' and 'storyStatus'
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

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
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
    console.log('Checking if migration is needed...');
    const [rows] = await connection.query(
      'SELECT COUNT(*) as count FROM novels WHERE publicationStatus IS NULL OR storyStatus IS NULL'
    );
    
    const needsMigration = rows[0].count > 0;
    if (!needsMigration) {
      console.log('✓ No migration needed - all novels already have both statuses');
      await connection.end();
      return;
    }

    console.log(`Found ${rows[0].count} novels that need migration`);

    // Get all novels that need migration
    const [novels] = await connection.query(
      'SELECT id, status FROM novels WHERE publicationStatus IS NULL OR storyStatus IS NULL'
    );

    console.log(`\nMigrating ${novels.length} novels...`);

    let migratedCount = 0;
    for (const novel of novels) {
      // Map old status to new statuses
      let publicationStatus = 'published'; // All existing novels are published by default
      let storyStatus = 'ongoing'; // Default

      if (novel.status === 'completed' || novel.status === 'finished') {
        storyStatus = 'finished';
      } else if (novel.status === 'hiatus') {
        storyStatus = 'ongoing'; // Hiatus means paused, still ongoing
      } else if (novel.status === 'ongoing') {
        storyStatus = 'ongoing';
      }

      // Update the novel
      await connection.query(
        'UPDATE novels SET publicationStatus = ?, storyStatus = ? WHERE id = ?',
        [publicationStatus, storyStatus, novel.id]
      );

      migratedCount++;
      if (migratedCount % 10 === 0) {
        console.log(`  Migrated ${migratedCount}/${novels.length}...`);
      }
    }

    console.log(`\n✓ Successfully migrated ${migratedCount} novels`);
    console.log('\nMigration summary:');
    console.log('- All existing novels set to publicationStatus = "published"');
    console.log('- Story status mapped from old status values:');
    console.log('  - "completed" or "finished" -> "finished"');
    console.log('  - "ongoing" or "hiatus" -> "ongoing"');

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
