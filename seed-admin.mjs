import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'ipenovel';

// Admin credentials should be provided via environment variables
// For production, use a secure bootstrap method (e.g., admin setup endpoint)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ERROR: Admin credentials not provided');
  console.error('Usage: ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePassword123 node seed-admin.mjs');
  console.error('');
  console.error('For production deployments:');
  console.error('1. Do NOT use this script');
  console.error('2. Use a secure admin bootstrap endpoint instead');
  console.error('3. Ensure admin credentials are never stored in code or logs');
  process.exit(1);
}

async function seedAdmin() {
  const connection = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    const email = ADMIN_EMAIL;
    const password = ADMIN_PASSWORD;
    const passwordHash = await bcrypt.hash(password, 10);
    const openId = `admin-${Date.now()}`;

    // Check if admin already exists
    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      console.log('Admin account already exists');
      return;
    }

    // Create admin account
    await connection.execute(
      'INSERT INTO users (openId, name, email, loginMethod, passwordHash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [openId, 'Administrator', email, 'local', passwordHash, 'admin']
    );

    console.log('✓ Admin account created successfully');
    console.log(`  Email: ${email}`);
    console.log('  Password: (provided via ADMIN_PASSWORD env var)');
    console.log('');
    console.log('SECURITY: Store these credentials securely and change password after first login');
  } catch (error) {
    console.error('Error seeding admin:', error);
  } finally {
    await connection.end();
  }
}

seedAdmin();
