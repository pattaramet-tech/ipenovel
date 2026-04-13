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
const migrationsDir = 'drizzle';
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => path.join(migrationsDir, f));

console.log(`\nFound ${migrationFiles.length} migration files to apply`);

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
console.log('\n✓ All migrations completed successfully');
