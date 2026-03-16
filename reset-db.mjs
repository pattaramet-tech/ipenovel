import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'localhost',
  user: process.env.DATABASE_URL?.split('//')[1]?.split(':')[0] || 'root',
  password: process.env.DATABASE_URL?.split(':')[2]?.split('@')[0] || '',
  database: process.env.DATABASE_URL?.split('/').pop() || 'test',
});

// Get all tables
const [tables] = await connection.execute(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES 
  WHERE TABLE_SCHEMA = DATABASE()
`);

// Drop all tables
for (const table of tables) {
  await connection.execute(`DROP TABLE IF EXISTS \`${table.TABLE_NAME}\``);
  console.log(`Dropped table: ${table.TABLE_NAME}`);
}

console.log('All tables dropped successfully');
await connection.end();
