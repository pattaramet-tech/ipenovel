// ⚠️  LOCAL/DEV-ONLY SCRIPT
// This script applies the LOCAL_ADMIN_BOOTSTRAP.sql migration for local development.
// It is NOT part of the canonical production migration chain.
// Do NOT use in production.

import mysql from 'mysql2/promise';
import fs from 'fs';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('❌ ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

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
console.log('⚠️  Applying LOCAL_ADMIN_BOOTSTRAP.sql (local/dev-only)');

try {
  const bootstrapFile = 'drizzle/LOCAL_ADMIN_BOOTSTRAP.sql';
  if (!fs.existsSync(bootstrapFile)) {
    console.error(`❌ ERROR: ${bootstrapFile} not found`);
    process.exit(1);
  }

  const sql = fs.readFileSync(bootstrapFile, 'utf-8');
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
        console.error(`Error: ${e.message}`);
      }
    }
  }

  console.log(`✓ LOCAL_ADMIN_BOOTSTRAP.sql applied (${successCount} statements, ${skipCount} skipped)`);
  console.log('');
  console.log('✅ Local admin bootstrap completed successfully');
  console.log('');
  console.log('Local admin account credentials:');
  console.log('  Email: admin@ipenovel.com');
  console.log('  Password: Ipe@novel2026');
  console.log('  OpenID: admin-ipenovel');
  console.log('');
  console.log('⚠️  This is a LOCAL/DEV-ONLY account for testing.');
  console.log('   Change password after first login.');
  console.log('   Do not use in production.');
} catch (error) {
  console.error('❌ Error applying local admin bootstrap:', error.message);
  process.exit(1);
} finally {
  await connection.end();
}
