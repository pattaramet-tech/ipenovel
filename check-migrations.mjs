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

const [rows] = await connection.execute('SELECT * FROM __drizzle_migrations');
console.log('Applied migrations:', rows.length);
rows.forEach(r => console.log('  -', r.hash, r.created_at));

await connection.end();
