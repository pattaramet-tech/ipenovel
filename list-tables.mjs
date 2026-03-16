import mysql from 'mysql2/promise';

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

const [tables] = await connection.execute('SHOW TABLES');
console.log('Tables in database:', tables.length);
tables.forEach(t => console.log('  -', Object.values(t)[0]));

await connection.end();
