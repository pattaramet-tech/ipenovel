import { getDb } from './server/db.ts';
import { users, eq } from 'drizzle-orm';

const passwordHash = '$2b$10$ZdRx.tShbyvGRCvAZhxEi.QmrI0j6TyExPq07C30IeH4IBDb55cKG';

async function updateAdminPassword() {
  try {
    const db = await getDb();
    if (!db) {
      console.error('Failed to connect to database');
      process.exit(1);
    }

    await db.update(users).set({ passwordHash }).where(eq(users.email, 'admin@ipenovel.com'));
    console.log('Admin password hash updated successfully');
  } catch (error) {
    console.error('Error updating admin password:', error);
    process.exit(1);
  }
}

updateAdminPassword();
