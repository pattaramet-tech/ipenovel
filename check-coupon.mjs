import mysql from 'mysql2/promise';

try {
  const dbUrl = process.env.DATABASE_URL;
  console.log('Database URL:', dbUrl.substring(0, 30) + '...');
  
  const connection = await mysql.createConnection({
    host: dbUrl.split('@')[1].split('/')[0],
    user: dbUrl.split('://')[1].split(':')[0],
    password: dbUrl.split(':')[2].split('@')[0],
    database: dbUrl.split('/').pop(),
    ssl: 'Amazon RDS',
  });

  const [rows] = await connection.execute(
    'SELECT id, code, discountType, discountValue, isActive FROM coupons WHERE code = ?',
    ['NEWZ']
  );

  console.log('NEWZ Coupon:', JSON.stringify(rows[0], null, 2));

  // Update
  const [result] = await connection.execute(
    'UPDATE coupons SET discountValue = ? WHERE code = ?',
    ['15.00', 'NEWZ']
  );

  console.log('Update result:', result);

  // Check again
  const [rows2] = await connection.execute(
    'SELECT id, code, discountType, discountValue, isActive FROM coupons WHERE code = ?',
    ['NEWZ']
  );

  console.log('NEWZ After Update:', JSON.stringify(rows2[0], null, 2));

  await connection.end();
} catch (err) {
  console.error('Error:', err.message);
}
