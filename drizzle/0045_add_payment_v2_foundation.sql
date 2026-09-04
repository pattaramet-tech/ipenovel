-- IPE-021-D / IPE-022-C02: additive, restart-safe Account Merge guard.
--
-- MySQL/MariaDB implicitly commit DDL, so a failed migration cannot rely on
-- the migrator's wrapping transaction for rollback. Every DDL statement is
-- therefore guarded by information_schema and the data step is convergent:
-- rerunning this file after any completed statement reaches the same schema
-- and fills only missing guard rows without overwriting an established guard
-- generation or merge binding.
CREATE TABLE IF NOT EXISTS `accountMutationGuards` (
	`userId` int NOT NULL,
	`generation` bigint unsigned NOT NULL DEFAULT 0,
	`mergeState` enum('open','merge_guarded') NOT NULL DEFAULT 'open',
	`activeMergeCaseId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accountMutationGuards_userId` PRIMARY KEY(`userId`),
	CONSTRAINT `accountMutationGuards_activeMergeCaseId_unique` UNIQUE(`activeMergeCaseId`)
);
--> statement-breakpoint
SET @ipenovel_0045_user_fk_exists = (
	SELECT COUNT(*) FROM information_schema.referential_constraints
	WHERE constraint_schema = DATABASE()
	  AND table_name = 'accountMutationGuards'
	  AND constraint_name = 'accountMutationGuards_userId_fk'
);
--> statement-breakpoint
SET @ipenovel_0045_user_fk_sql = IF(
	@ipenovel_0045_user_fk_exists = 0,
	'ALTER TABLE `accountMutationGuards` ADD CONSTRAINT `accountMutationGuards_userId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action',
	'DO 0'
);
--> statement-breakpoint
PREPARE ipenovel_0045_user_fk_stmt FROM @ipenovel_0045_user_fk_sql;
--> statement-breakpoint
EXECUTE ipenovel_0045_user_fk_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipenovel_0045_user_fk_stmt;
--> statement-breakpoint
-- Derive missing rows from the authoritative user + non-cancelled merge-case
-- state. ON DUPLICATE is intentionally a no-op: an existing row may carry a
-- later generation and must never be reset by a migration retry.
INSERT INTO `accountMutationGuards` (`userId`, `generation`, `mergeState`, `activeMergeCaseId`)
SELECT
  u.`id`,
  CASE WHEN amc.`id` IS NULL THEN 0 ELSE 1 END AS `generation`,
  CASE WHEN amc.`id` IS NULL THEN 'open' ELSE 'merge_guarded' END AS `mergeState`,
  amc.`id` AS `activeMergeCaseId`
FROM `users` u
LEFT JOIN `accountMergeCases` amc
  ON amc.`sourceUserId` = u.`id`
 AND amc.`status` <> 'cancelled'
ON DUPLICATE KEY UPDATE `userId` = VALUES(`userId`);
