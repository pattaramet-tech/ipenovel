// Diagnostic script for "false insufficient wallet balance" bug report.
// Read-only - does not modify any data.
//
// Usage:
//   DATABASE_URL="mysql://user:pass@host:port/db" node migrations/006_diagnose_wallet_insufficient_false_positive.mjs <userId> <episodeId>

import mysql from "mysql2/promise";

const [, , userIdArg, episodeIdArg] = process.argv;
const userId = Number(userIdArg);
const episodeId = Number(episodeIdArg);

if (!Number.isFinite(userId) || !Number.isFinite(episodeId)) {
  console.error("Usage: node migrations/006_diagnose_wallet_insufficient_false_positive.mjs <userId> <episodeId>");
  process.exit(1);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }

  const connection = await mysql.createConnection(databaseUrl);

  try {
    console.log(`\n=== 1. Wallet account for userId=${userId} ===`);
    const [wallet] = await connection.query(
      `SELECT id, userId, balance, totalTopupApproved, totalSpent, createdAt, updatedAt
       FROM walletAccounts WHERE userId = ?`,
      [userId]
    );
    console.log(wallet);

    console.log(`\n=== 2. Last 10 wallet topups for userId=${userId} ===`);
    const [topups] = await connection.query(
      `SELECT id, userId, requestedAmount, creditedAmount, bonusAmount, totalCredited, status, ocrDecision, reviewReason, createdAt, updatedAt
       FROM walletTopups WHERE userId = ? ORDER BY createdAt DESC LIMIT 10`,
      [userId]
    );
    console.log(topups);

    console.log(`\n=== 3. Last 20 wallet transactions for userId=${userId} ===`);
    const [transactions] = await connection.query(
      `SELECT id, userId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, note, createdAt
       FROM walletTransactions WHERE userId = ? ORDER BY createdAt DESC LIMIT 20`,
      [userId]
    );
    console.log(transactions);

    console.log(`\n=== 4. Episode data for episodeId=${episodeId} ===`);
    const [episode] = await connection.query(
      `SELECT id, novelId, episodeNumber, title, price, isFree, isPublished, fileUrl, contentFormat, LENGTH(content) AS contentLength
       FROM episodes WHERE id = ?`,
      [episodeId]
    );
    console.log(episode);

    console.log(`\n=== 5. Numeric compare (balance vs price) ===`);
    const [compare] = await connection.query(
      `SELECT wa.userId, wa.balance, e.price,
              CAST(wa.balance AS DECIMAL(12,2)) AS balanceDecimal,
              CAST(e.price AS DECIMAL(12,2)) AS priceDecimal,
              CAST(wa.balance AS DECIMAL(12,2)) >= CAST(e.price AS DECIMAL(12,2)) AS canAfford
       FROM walletAccounts wa JOIN episodes e ON e.id = ?
       WHERE wa.userId = ?`,
      [episodeId, userId]
    );
    console.log(compare);

    console.log(`\n=== 6. Existing purchase record (duplicate check) ===`);
    const [purchase] = await connection.query(
      `SELECT id, userId, novelId, episodeId, pricePaid, walletTransactionId, purchasedAt, createdAt
       FROM episodePurchases WHERE userId = ? AND episodeId = ?`,
      [userId, episodeId]
    );
    console.log(purchase);

    console.log("\nDiagnostic complete. No data was modified.");
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});
