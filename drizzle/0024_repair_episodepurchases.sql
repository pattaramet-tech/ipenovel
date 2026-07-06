-- Safe idempotent repair for episodePurchases schema mismatch
-- Adds missing columns to episodePurchases if they don't exist
-- Safe to run multiple times

-- Add walletTransactionId column if missing
ALTER TABLE `episodePurchases` ADD COLUMN `walletTransactionId` int NULL COMMENT 'Reference to wallet debit transaction';

-- Add purchasedAt column if missing (defaults to current timestamp)
ALTER TABLE `episodePurchases` ADD COLUMN `purchasedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the episode was purchased';

-- Add createdAt column if missing (defaults to current timestamp)
ALTER TABLE `episodePurchases` ADD COLUMN `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the record was created';

-- Create index on walletTransactionId if missing
CREATE INDEX IF NOT EXISTS `episodePurchases_walletTransactionId_idx` ON `episodePurchases` (`walletTransactionId`);
