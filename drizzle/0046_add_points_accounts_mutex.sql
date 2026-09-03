CREATE TABLE `pointsAccounts` (
	`userId` int NOT NULL,
	`balance` decimal(10,2) NOT NULL DEFAULT '0.00',
	`version` bigint unsigned NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pointsAccounts_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
-- Backfill every existing user from the exact ledger ordering the application
-- used before 0046. Users with no ledger history start at 0.00.
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
FROM `users` u;
--> statement-breakpoint
ALTER TABLE `pointsTransactions` ADD `effectKey` varchar(191);--> statement-breakpoint
ALTER TABLE `pointsTransactions` ADD CONSTRAINT `pointsTransactions_userId_effectKey_unique` UNIQUE(`userId`,`effectKey`);--> statement-breakpoint
ALTER TABLE `pointsAccounts` ADD CONSTRAINT `pointsAccounts_userId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;