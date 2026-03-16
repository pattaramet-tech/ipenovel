import { db } from './server/_core/db.js';
import { coupons } from './drizzle/schema.ts';
import { eq } from 'drizzle-orm';

try {
  console.log('Updating NEWZ coupon...');
  
  const result = await db
    .update(coupons)
    .set({ discountValue: '15.00' })
    .where(eq(coupons.code, 'NEWZ'));
  
  console.log('Update result:', result);
  
  // Verify
  const coupon = await db
    .select()
    .from(coupons)
    .where(eq(coupons.code, 'NEWZ'));
  
  console.log('NEWZ Coupon after update:', coupon[0]);
  
  process.exit(0);
} catch (err) {
  console.error('Error:', err);
  process.exit(1);
}
