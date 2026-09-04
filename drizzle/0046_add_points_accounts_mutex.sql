-- IPE-021-D / IPE-022-C02: additive, restart-safe points mutex + mirror.
-- Every DDL statement is independently guarded because MySQL/MariaDB DDL
-- implicitly commits. The backfill is repeatable and converges each user's
-- mirror to the deterministic latest committed ledger row.
CREATE TABLE IF NOT EXISTS `pointsAccounts` (
	`userId` int NOT NULL,
	`balance` decimal(10,2) NOT NULL DEFAULT '0.00',
	`version` bigint unsigned NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pointsAccounts_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
-- Backfill/reconcile every existing user from the exact ledger ordering the
-- legacy application uses. Replaying after a partial migration also catches
-- users or ledger rows committed by an older instance after the first pass.
INSERT INTO `pointsAccounts` (`userId`, `balance`, `version`)
SELECT
  u.`id`,
  COALESCE((
    SELECT pt.`balanceAfter`
    FROM `pointsTransactions` pt
    WHERE pt.`userId` = u.`id`
    ORDER BY pt.`createdAt` DESC, pt.`id` DESC
    LIMIT 1
  ), '0.00'),
  0
FROM `users` u
ON DUPLICATE KEY UPDATE `balance` = VALUES(`balance`);
--> statement-breakpoint
SET @ipenovel_0046_effect_key_exists = (
	SELECT COUNT(*) FROM information_schema.columns
	WHERE table_schema = DATABASE()
	  AND table_name = 'pointsTransactions'
	  AND column_name = 'effectKey'
);
--> statement-breakpoint
SET @ipenovel_0046_effect_key_sql = IF(
	@ipenovel_0046_effect_key_exists = 0,
	'ALTER TABLE `pointsTransactions` ADD `effectKey` varchar(191)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0046_effect_key_stmt FROM @ipenovel_0046_effect_key_sql;
--> statement-breakpoint
EXECUTE ipenovel_0046_effect_key_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0046_effect_key_stmt;
--> statement-breakpoint
SET @ipenovel_0046_effect_unique_exists = (
	SELECT COUNT(*) FROM information_schema.statistics
	WHERE table_schema = DATABASE()
	  AND table_name = 'pointsTransactions'
	  AND index_name = 'pointsTransactions_userId_effectKey_unique'
);
--> statement-breakpoint
SET @ipenovel_0046_effect_unique_sql = IF(
	@ipenovel_0046_effect_unique_exists = 0,
	'ALTER TABLE `pointsTransactions` ADD CONSTRAINT `pointsTransactions_userId_effectKey_unique` UNIQUE(`userId`,`effectKey`)',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0046_effect_unique_stmt FROM @ipenovel_0046_effect_unique_sql;
--> statement-breakpoint
EXECUTE ipenovel_0046_effect_unique_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0046_effect_unique_stmt;
--> statement-breakpoint
SET @ipenovel_0046_user_fk_exists = (
	SELECT COUNT(*) FROM information_schema.referential_constraints
	WHERE constraint_schema = DATABASE()
	  AND table_name = 'pointsAccounts'
	  AND constraint_name = 'pointsAccounts_userId_fk'
);
--> statement-breakpoint
SET @ipenovel_0046_user_fk_sql = IF(
	@ipenovel_0046_user_fk_exists = 0,
	'ALTER TABLE `pointsAccounts` ADD CONSTRAINT `pointsAccounts_userId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0046_user_fk_stmt FROM @ipenovel_0046_user_fk_sql;
--> statement-breakpoint
EXECUTE ipenovel_0046_user_fk_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0046_user_fk_stmt;
