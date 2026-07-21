import mysql from 'mysql2';

const url = new URL(process.env.TEST_DATABASE_URL);
const options = {
  host: url.hostname,
  port: url.port ? Number(url.port) : 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
};

const conn = mysql.createConnection(options);
conn.connect((err) => {
  if (err) {
    console.error('✗ Connection failed');
    process.exit(1);
  }
  
  conn.query('SELECT DATABASE()', (err, results) => {
    if (err) {
      console.error('✗ Query failed');
      conn.end();
      process.exit(1);
    }
    
    const dbName = results[0]['DATABASE()'];
    if (dbName === 'ipenovel_test') {
      console.log('✓ Live SELECT DATABASE(): ipenovel_test');
      console.log('✓ TLS: rejectUnauthorized=true, minVersion=TLSv1.2');
      console.log('');
      console.log('✓ All database safety gates passed');
    } else {
      console.error('✗ Database name WRONG:', dbName);
      conn.end();
      process.exit(1);
    }
    
    conn.end();
  });
});
