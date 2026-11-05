-- P3 Chapter-to-Package Upgrade (P3-R2; originally drafted as 0067 before the
-- notifications-engagement migration landed on main as 0067 first - see the
-- journal: 0067_notifications_engagement (idx 67) precedes this file (idx 68).: additive-only financial ledger for
-- "own chapters individually -> upgrade to the package, paying only the
-- difference". Three new tables, purely additive - no existing table,
-- column, or row is modified; episode IDs remain the stable entitlement
-- anchors (packageChapterMappings/packageUpgradeCreditItems reference
-- episodes.id by plain int columns, same convention as every other
-- entitlement table in this schema - purchases, episodePurchases,
-- adminGiftEntitlements have no FK constraints either).
--
-- Rollback (only after the feature flag/code is gone and no quoting is in
-- flight - these tables ARE the financial audit trail, so dropping them
-- destroys the only evidence of upgrade credits ever applied):
--   DROP TABLE `packageUpgradeCreditItems`;
--   DROP TABLE `packageUpgrades`;
--   DROP TABLE `packageChapterMappings`;

--> statement-breakpoint
CREATE TABLE `packageChapterMappings` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `novelId` int NOT NULL,
  `packageEpisodeId` int NOT NULL,
  `chapterEpisodeId` int NOT NULL,
  `sortOrder` int DEFAULT 0 NOT NULL,
  `derivation` varchar(60) DEFAULT 'episode_number_range' NOT NULL,
  `createdAt` timestamp DEFAULT (now()) NOT NULL,
  CONSTRAINT `unique_package_chapter_mapping` UNIQUE (`packageEpisodeId`, `chapterEpisodeId`)
);
--> statement-breakpoint
CREATE INDEX `packageChapterMappings_novelId_idx` ON `packageChapterMappings` (`novelId`);
--> statement-breakpoint
CREATE INDEX `packageChapterMappings_chapterId_idx` ON `packageChapterMappings` (`chapterEpisodeId`);
--> statement-breakpoint
CREATE TABLE `packageUpgrades` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `userId` int NOT NULL,
  `novelId` int NOT NULL,
  `packageEpisodeId` int NOT NULL,
  `idempotencyKey` varchar(128) NOT NULL,
  `status` ENUM('quoted', 'order_created', 'expired', 'void') DEFAULT 'quoted' NOT NULL,
  `packagePriceSnapshot` decimal(10, 2) NOT NULL,
  `creditAmountSnapshot` decimal(10, 2) NOT NULL,
  `payableAmountSnapshot` decimal(10, 2) NOT NULL,
  `quoteExpiresAt` timestamp NOT NULL,
  `orderId` int,
  `createdAt` timestamp DEFAULT (now()) NOT NULL,
  `updatedAt` timestamp DEFAULT (now()) NOT NULL,
  CONSTRAINT `packageUpgrades_idempotency_unique` UNIQUE (`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `packageUpgrades_user_package_idx` ON `packageUpgrades` (`userId`, `packageEpisodeId`);
--> statement-breakpoint
CREATE INDEX `packageUpgrades_orderId_idx` ON `packageUpgrades` (`orderId`);
--> statement-breakpoint
CREATE TABLE `packageUpgradeCreditItems` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `upgradeId` int NOT NULL,
  `userId` int NOT NULL,
  `novelId` int NOT NULL,
  `chapterEpisodeId` int NOT NULL,
  `source` ENUM('wallet_purchase', 'approved_order') NOT NULL,
  `sourceRefId` int NOT NULL,
  `pricePaidSnapshot` decimal(10, 2) NOT NULL,
  `creditApplied` decimal(10, 2) NOT NULL,
  `createdAt` timestamp DEFAULT (now()) NOT NULL,
  CONSTRAINT `unique_upgrade_chapter_credit` UNIQUE (`upgradeId`, `chapterEpisodeId`)
);
--> statement-breakpoint
CREATE INDEX `packageUpgradeCreditItems_chapterId_idx` ON `packageUpgradeCreditItems` (`chapterEpisodeId`);
--> statement-breakpoint
CREATE INDEX `packageUpgradeCreditItems_userId_idx` ON `packageUpgradeCreditItems` (`userId`);
