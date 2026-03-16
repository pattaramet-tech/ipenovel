import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'ipenovel';

async function seedAdmin() {
  const connection = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    const email = 'admin@ipenovel.com';
    const password = 'Ipe@novel2026';
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
      [openId, 'Admin', email, 'local', passwordHash, 'admin']
    );

    console.log('Admin account created successfully');
    console.log('Email: admin@ipenovel.com');
    console.log('Password: Ipe@novel2026');
  } catch (error) {
    console.error('Error seeding admin:', error);
  } finally {
    await connection.end();
  }
}

seedAdmin();
