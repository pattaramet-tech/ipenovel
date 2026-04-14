import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

const dbUrl = process.env.DATABASE_URL;
const url = new URL(dbUrl);

const sslParam = url.searchParams.get('ssl');
let ssl = sslParam ? JSON.parse(sslParam) : true;

const connection = await mysql.createConnection({
  host: url.hostname,
  port: url.port,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: ssl,
});

console.log('✓ Connected to database');

// Automatically discover all migration files in drizzle directory
// Only apply numbered migrations (0000_*.sql, 0001_*.sql, etc.)
// Skip LOCAL_ADMIN_BOOTSTRAP.sql (local/dev-only, applied separately)
const migrationsDir = 'drizzle';
const isProduction = process.env.NODE_ENV === 'production';
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  // Only include numbered migrations (0000_*, 0001_*, etc.)
  // Skip LOCAL_ADMIN_BOOTSTRAP.sql (applied separately for local/dev)
  .filter(f => /^\d{4}_/.test(f))
  .sort()
  .map(f => path.join(migrationsDir, f));

if (!isProduction) {
  console.log('\nℹ️  Development mode: LOCAL_ADMIN_BOOTSTRAP.sql can be applied separately');
}

console.log(`\nFound ${migrationFiles.length} canonical migration files to apply`);

for (const file of migrationFiles) {
  if (fs.existsSync(file)) {
    const sql = fs.readFileSync(file, 'utf-8');
    console.log(`\nApplying ${file}...`);
    
    // Split by semicolon and execute each statement
    const statements = sql.split(';').filter(s => s.trim());
    let successCount = 0;
    let skipCount = 0;
    
    for (const statement of statements) {
      try {
        await connection.execute(statement);
        successCount++;
      } catch (e) {
        if (e.message.includes('already exists') || e.message.includes('Duplicate')) {
          skipCount++;
        } else {
          console.error(`Error in ${file}:`, e.message);
        }
      }
    }
    console.log(`✓ ${file} applied (${successCount} statements, ${skipCount} skipped)`);
  }
}

// List tables
const [tables] = await connection.execute('SHOW TABLES');
console.log('\n✓ Final schema - Tables created:', tables.length);
tables.forEach(t => console.log('  -', Object.values(t)[0]));

// Check migration status
try {
  const [migrations] = await connection.execute('SELECT * FROM __drizzle_migrations ORDER BY hash');
  console.log(`\n✓ Applied migrations: ${migrations.length}`);
} catch (e) {
  console.log('\n✓ Migration tracking table not found (expected for fresh setup)');
}

await connection.end();

console.log('\n✓ Canonical migrations completed successfully');

if (!isProduction) {
  console.log('\nℹ️  To bootstrap local admin for development:');
  console.log('   Option 1: ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePass123 node seed-admin.mjs');
  console.log('   Option 2: NODE_ENV=development node apply-local-admin-bootstrap.mjs');
  console.log('   Option 3: Manually run: mysql ... < drizzle/LOCAL_ADMIN_BOOTSTRAP.sql');
} else {
  console.log('\nℹ️  Production: No local admin bootstrap applied');
  console.log('   Admin accounts must be created through secure endpoint (future)');
}
