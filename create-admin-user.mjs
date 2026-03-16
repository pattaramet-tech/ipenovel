import mysql from 'mysql2/promise';

const dbUrl = process.env.DATABASE_URL;
const url = new URL(dbUrl);

// Parse SSL config from URL
let ssl = false;
const sslParam = url.searchParams.get('ssl');
if (sslParam) {
  try {
    ssl = JSON.parse(sslParam);
  } catch {
    ssl = true;
  }
}

const connection = await mysql.createConnection({
  host: url.hostname,
  port: url.port,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: ssl,
});

console.log('✓ Connected to database');

const openId = 'admin-test-' + Date.now();
const email = 'admin@ipenovel.test';
const name = 'Admin User';
const role = 'admin';

try {
  const [result] = await connection.execute(
    'INSERT INTO users (openId, email, name, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [openId, email, name, role]
  );
  
  console.log('✅ Admin user created successfully!');
  console.log('OpenID:', openId);
  console.log('Email:', email);
  console.log('Name:', name);
  console.log('Role:', role);
} catch (error) {
  console.error('❌ Error:', error.message);
}

await connection.end();
