import mysql from 'mysql2/promise';
import { parse } from 'url';

const dbUrl = process.env.DATABASE_URL;
console.log('Database URL:', dbUrl?.replace(/:[^:]*@/, ':***@'));

// Parse the connection string
const url = new URL(dbUrl);
const connection = await mysql.createConnection({
  host: url.hostname,
  port: url.port,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: 'Amazon RDS',
});

console.log('✓ Connected to database');

// List tables
const [tables] = await connection.execute('SHOW TABLES');
console.log('Tables:', tables.length);
tables.forEach(t => console.log('  -', Object.values(t)[0]));

await connection.end();
