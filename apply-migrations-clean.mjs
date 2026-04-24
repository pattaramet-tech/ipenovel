import mysql from 'mysql2/promise';
import fs from 'fs';

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

console.log('✓ Connected to database');

// Read migration files
const files = ['drizzle/0000_needy_anthem.sql', 'drizzle/0001_steep_romulus.sql'];

for (const file of files) {
  if (fs.existsSync(file)) {
    let sql = fs.readFileSync(file, 'utf-8');
    console.log(`\nApplying ${file}...`);
    
    // Remove comment lines and breakpoint markers
    sql = sql.split('\n')
      .filter(line => !line.trim().startsWith('--') && !line.includes('--> statement-breakpoint'))
      .join('\n');
    
    // Split by semicolon and execute each statement
    const statements = sql.split(';').filter(s => s.trim());
    for (const statement of statements) {
      try {
        await connection.execute(statement);
      } catch (e) {
        if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
          console.error('Error:', e.message);
        }
      }
    }
    console.log(`✓ ${file} applied`);
  }
}

// List tables
const [tables] = await connection.execute('SHOW TABLES');
console.log('\n✓ Tables created:', tables.length);
tables.forEach(t => console.log('  -', Object.values(t)[0]));

await connection.end();
