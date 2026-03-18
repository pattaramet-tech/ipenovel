#!/usr/bin/env node

/**
 * SAFE TEST DATA CLEANUP TOOL
 * 
 * Removes test data created during development/QA without affecting real users/data.
 * 
 * Usage:
 *   node scripts/cleanup-test-data.mjs --dry-run
 *   node scripts/cleanup-test-data.mjs --execute --confirm-test-cleanup
 *   node scripts/cleanup-test-data.mjs --dry-run --prefix "Test"
 *   node scripts/cleanup-test-data.mjs --execute --confirm-test-cleanup --user-email "test@example.com"
 * 
 * Flags:
 *   --dry-run                 Show what would be deleted (default)
 *   --execute                 Actually delete test data (requires --confirm-test-cleanup)
 *   --confirm-test-cleanup    Required to enable actual deletion
 *   --prefix                  Match records with this prefix (default: "Test")
 *   --user-email              Delete specific user by email
 *   --user-id                 Delete specific user by ID
 *   --novel-id                Delete specific novel by ID
 *   --episode-id              Delete specific episode by ID
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config();

const pool = mysql.createPool({
  connectionLimit: 1,
  host: process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'localhost',
  user: process.env.DATABASE_URL?.split('//')[1]?.split(':')[0] || 'root',
  password: process.env.DATABASE_URL?.split(':')[1]?.split('@')[0] || '',
  database: process.env.DATABASE_URL?.split('/').pop() || 'ipenovel',
  waitForConnections: true,
  enableKeepAlive: true,
  keepAliveInitialDelayMs: 0,
});

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = !args.includes('--execute');
const hasConfirmation = args.includes('--confirm-test-cleanup');
const prefix = args.find(a => a.startsWith('--prefix='))?.split('=')[1] || 'Test';
const userEmail = args.find(a => a.startsWith('--user-email='))?.split('=')[1];
const userId = args.find(a => a.startsWith('--user-id='))?.split('=')[1];
const novelId = args.find(a => a.startsWith('--novel-id='))?.split('=')[1];
const episodeId = args.find(a => a.startsWith('--episode-id='))?.split('=')[1];

// Safety checks
if (!isDryRun && !hasConfirmation) {
  console.error('❌ ERROR: --execute requires --confirm-test-cleanup flag');
  console.error('   This is a safety measure to prevent accidental data deletion');
  process.exit(1);
}

const log = (msg, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : '✓';
  console.log(`[${timestamp}] ${prefix} ${msg}`);
};

const query = async (sql, params = []) => {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    conn.release();
  }
};

const execute = async (sql, params = []) => {
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(sql, params);
    return result;
  } finally {
    conn.release();
  }
};

async function findTestData() {
  log('Scanning for test data...');

  const testData = {
    users: [],
    novels: [],
    episodes: [],
    carts: [],
    cartItems: [],
    orders: [],
    orderItems: [],
    payments: [],
    purchases: [],
    wishlists: [],
    couponUsages: [],
    pointsTransactions: [],
    orderHistory: [],
    banners: [],
  };

  try {
    // Find test users
    let users = [];
    if (userEmail) {
      users = await query('SELECT * FROM users WHERE email = ?', [userEmail]);
    } else if (userId) {
      users = await query('SELECT * FROM users WHERE id = ?', [userId]);
    } else {
      users = await query(
        'SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR openId LIKE ?',
        [`${prefix}%`, `${prefix}%`, `${prefix}%`]
      );
    }

    testData.users = users.filter((u) => u.role !== 'admin'); // Never delete admins
    log(`Found ${testData.users.length} test users`, 'INFO');

    if (testData.users.length === 0) {
      log('No test users found. Exiting.', 'WARN');
      return testData;
    }

    const userIds = testData.users.map((u) => u.id);

    // Find test novels
    let novels = [];
    if (novelId) {
      novels = await query('SELECT * FROM novels WHERE id = ?', [novelId]);
    } else {
      novels = await query('SELECT * FROM novels WHERE title LIKE ?', [`${prefix}%`]);
    }
    testData.novels = novels;
    log(`Found ${testData.novels.length} test novels`, 'INFO');

    const novelIds = testData.novels.map((n) => n.id);

    // Find test episodes
    if (episodeId) {
      testData.episodes = await query('SELECT * FROM episodes WHERE id = ?', [episodeId]);
    } else if (novelIds.length > 0) {
      testData.episodes = await query(
        `SELECT * FROM episodes WHERE novelId IN (${novelIds.map(() => '?').join(',')}) OR title LIKE ?`,
        [...novelIds, `${prefix}%`]
      );
    } else {
      testData.episodes = await query('SELECT * FROM episodes WHERE title LIKE ?', [`${prefix}%`]);
    }
    log(`Found ${testData.episodes.length} test episodes`, 'INFO');

    const episodeIds = testData.episodes.map((e) => e.id);

    // Find related records
    if (userIds.length > 0) {
      testData.carts = await query(
        `SELECT * FROM carts WHERE userId IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );

      testData.orders = await query(
        `SELECT * FROM orders WHERE userId IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );

      testData.purchases = await query(
        `SELECT * FROM purchases WHERE userId IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );

      testData.wishlists = await query(
        `SELECT * FROM wishlists WHERE userId IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );

      testData.pointsTransactions = await query(
        `SELECT * FROM pointsTransactions WHERE userId IN (${userIds.map(() => '?').join(',')})`,
        userIds
      );
    }

    if (testData.carts.length > 0) {
      const cartIds = testData.carts.map((c) => c.id);
      testData.cartItems = await query(
        `SELECT * FROM cartItems WHERE cartId IN (${cartIds.map(() => '?').join(',')})`,
        cartIds
      );
    }

    if (testData.orders.length > 0) {
      const orderIds = testData.orders.map((o) => o.id);
      testData.orderItems = await query(
        `SELECT * FROM orderItems WHERE orderId IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      testData.payments = await query(
        `SELECT * FROM payments WHERE orderId IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      testData.couponUsages = await query(
        `SELECT * FROM couponUsages WHERE orderId IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );

      testData.orderHistory = await query(
        `SELECT * FROM orderHistory WHERE orderId IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );
    }

    if (episodeIds.length > 0) {
      testData.banners = await query(
        `SELECT * FROM banners WHERE novelId IN (${novelIds.map(() => '?').join(',')}) OR episodeId IN (${episodeIds.map(() => '?').join(',')})`,
        [...novelIds, ...episodeIds]
      );
    }

    log(`Found ${testData.cartItems.length} cart items`, 'INFO');
    log(`Found ${testData.orders.length} orders`, 'INFO');
    log(`Found ${testData.orderItems.length} order items`, 'INFO');
    log(`Found ${testData.payments.length} payments`, 'INFO');
    log(`Found ${testData.purchases.length} purchases`, 'INFO');
    log(`Found ${testData.wishlists.length} wishlist items`, 'INFO');
    log(`Found ${testData.couponUsages.length} coupon usages`, 'INFO');
    log(`Found ${testData.pointsTransactions.length} points transactions`, 'INFO');
    log(`Found ${testData.orderHistory.length} order history entries`, 'INFO');
    log(`Found ${testData.banners.length} banners`, 'INFO');

    return testData;
  } catch (err) {
    log(`Error scanning for test data: ${err.message}`, 'ERROR');
    throw err;
  }
}

async function printDryRunReport(testData) {
  console.log('\n' + '='.repeat(80));
  console.log('DRY RUN REPORT - Test Data That Would Be Deleted');
  console.log('='.repeat(80) + '\n');

  const totalRecords =
    testData.users.length +
    testData.novels.length +
    testData.episodes.length +
    testData.carts.length +
    testData.cartItems.length +
    testData.orders.length +
    testData.orderItems.length +
    testData.payments.length +
    testData.purchases.length +
    testData.wishlists.length +
    testData.couponUsages.length +
    testData.pointsTransactions.length +
    testData.orderHistory.length +
    testData.banners.length;

  console.log(`Total records to delete: ${totalRecords}\n`);

  if (testData.users.length > 0) {
    console.log('TEST USERS:');
    testData.users.forEach((u) => {
      console.log(`  - ID ${u.id}: "${u.name}" (${u.email})`);
    });
    console.log();
  }

  if (testData.novels.length > 0) {
    console.log('TEST NOVELS:');
    testData.novels.forEach((n) => {
      console.log(`  - ID ${n.id}: "${n.title}"`);
    });
    console.log();
  }

  if (testData.episodes.length > 0) {
    console.log('TEST EPISODES:');
    testData.episodes.forEach((e) => {
      console.log(`  - ID ${e.id}: "${e.title}" (Novel ${e.novelId})`);
    });
    console.log();
  }

  if (testData.orders.length > 0) {
    console.log(`ORDERS: ${testData.orders.length} records`);
    console.log(`ORDER ITEMS: ${testData.orderItems.length} records`);
    console.log(`PAYMENTS: ${testData.payments.length} records`);
    console.log(`PURCHASES: ${testData.purchases.length} records`);
    console.log(`COUPON USAGES: ${testData.couponUsages.length} records`);
    console.log(`ORDER HISTORY: ${testData.orderHistory.length} records`);
    console.log();
  }

  if (testData.carts.length > 0) {
    console.log(`CARTS: ${testData.carts.length} records`);
    console.log(`CART ITEMS: ${testData.cartItems.length} records`);
    console.log();
  }

  if (testData.wishlists.length > 0) {
    console.log(`WISHLISTS: ${testData.wishlists.length} records`);
    console.log();
  }

  if (testData.pointsTransactions.length > 0) {
    console.log(`POINTS TRANSACTIONS: ${testData.pointsTransactions.length} records`);
    console.log();
  }

  if (testData.banners.length > 0) {
    console.log(`BANNERS: ${testData.banners.length} records`);
    console.log();
  }

  console.log('='.repeat(80));
  console.log('To execute deletion, run:');
  console.log('  node scripts/cleanup-test-data.mjs --execute --confirm-test-cleanup');
  console.log('='.repeat(80) + '\n');
}

async function deleteTestData(testData) {
  log('Starting test data deletion...', 'INFO');

  try {
    // Delete in dependency order (children first, then parents)
    const deletionOrder = [
      { table: 'orderHistory', ids: testData.orderHistory, idField: 'id' },
      { table: 'couponUsages', ids: testData.couponUsages, idField: 'id' },
      { table: 'pointsTransactions', ids: testData.pointsTransactions, idField: 'id' },
      { table: 'purchases', ids: testData.purchases, idField: 'id' },
      { table: 'payments', ids: testData.payments, idField: 'id' },
      { table: 'orderItems', ids: testData.orderItems, idField: 'id' },
      { table: 'orders', ids: testData.orders, idField: 'id' },
      { table: 'cartItems', ids: testData.cartItems, idField: 'id' },
      { table: 'carts', ids: testData.carts, idField: 'id' },
      { table: 'wishlists', ids: testData.wishlists, idField: 'id' },
      { table: 'banners', ids: testData.banners, idField: 'id' },
      { table: 'episodes', ids: testData.episodes, idField: 'id' },
      { table: 'novels', ids: testData.novels, idField: 'id' },
      { table: 'users', ids: testData.users, idField: 'id' },
    ];

    let totalDeleted = 0;

    for (const { table, ids, idField } of deletionOrder) {
      if (ids.length === 0) continue;

      const idList = ids.map((r) => r[idField]).join(',');
      const sql = `DELETE FROM ${table} WHERE ${idField} IN (${ids.map(() => '?').join(',')})`;
      const result = await execute(sql, ids.map((r) => r[idField]));

      const deleted = result.affectedRows || 0;
      totalDeleted += deleted;
      log(`Deleted ${deleted} records from ${table}`, 'INFO');
    }

    log(`\n✓ Successfully deleted ${totalDeleted} test data records`, 'INFO');
    return totalDeleted;
  } catch (err) {
    log(`Error deleting test data: ${err.message}`, 'ERROR');
    throw err;
  }
}

async function main() {
  try {
    log('Test Data Cleanup Tool Started', 'INFO');
    log(`Mode: ${isDryRun ? 'DRY RUN' : 'EXECUTE'}`, 'INFO');
    log(`Prefix: "${prefix}"`, 'INFO');

    const testData = await findTestData();

    if (testData.users.length === 0) {
      log('No test data found. Nothing to delete.', 'WARN');
      process.exit(0);
    }

    if (isDryRun) {
      await printDryRunReport(testData);
      process.exit(0);
    } else {
      log('Executing deletion...', 'INFO');
      const deleted = await deleteTestData(testData);
      log(`Cleanup complete. ${deleted} records deleted.`, 'INFO');
      process.exit(0);
    }
  } catch (err) {
    log(`Fatal error: ${err.message}`, 'ERROR');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
