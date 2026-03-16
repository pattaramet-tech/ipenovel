import { getDb } from './server/db.ts';

const db = await getDb();

if (!db) {
  console.error('Failed to connect to database');
  process.exit(1);
}

const adminUser = {
  openId: 'admin-test-' + Date.now(),
  email: 'admin@ipenovel.test',
  name: 'Admin User',
  role: 'admin',
  createdAt: new Date(),
  updatedAt: new Date(),
};

try {
  const result = await db.insert(db.schema.users).values(adminUser);
  console.log('✅ Admin user created successfully!');
  console.log('OpenID:', adminUser.openId);
  console.log('Email:', adminUser.email);
  console.log('Name:', adminUser.name);
  console.log('Role:', adminUser.role);
} catch (error) {
  console.error('❌ Error creating admin user:', error.message);
  process.exit(1);
}
