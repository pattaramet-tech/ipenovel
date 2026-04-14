// ⚠️  LOCAL/DEV-ONLY SCRIPT
// This script creates a test admin account for local development only.
// Do NOT use in production.

if (process.env.NODE_ENV === 'production') {
  console.error('❌ ERROR: This script is for local development only!');
  console.error('   Do not run in production.');
  console.error('');
  console.error('For production admin setup, use a secure bootstrap endpoint.');
  process.exit(1);
}

import { getDb } from './server/db.ts';

const db = await getDb();

if (!db) {
  console.error('Failed to connect to database');
  process.exit(1);
}

// Local/dev-only test admin account
const adminUser = {
  openId: 'admin-test-' + Date.now(),
  email: 'admin@ipenovel.test',
  name: 'Admin User (Local/Dev Only)',
  role: 'admin',
  createdAt: new Date(),
  updatedAt: new Date(),
};

console.log('\n⚠️  Creating LOCAL/DEV-ONLY admin account...');

try {
  const result = await db.insert(db.schema.users).values(adminUser);
  console.log('✅ Local/dev admin user created successfully!');
  console.log('OpenID:', adminUser.openId);
  console.log('Email:', adminUser.email);
  console.log('Name:', adminUser.name);
  console.log('Role:', adminUser.role);
  console.log('');
  console.log('⚠️  This is a LOCAL/DEV-ONLY account for testing.');
  console.log('   Do not use in production.');
} catch (error) {
  console.error('❌ Error creating local admin user:', error.message);
  process.exit(1);
}

console.log('');
