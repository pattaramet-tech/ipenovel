CREATE TABLE `accountMutationGuards` (
	`userId` int NOT NULL,
	`generation` bigint unsigned NOT NULL DEFAULT 0,
	`mergeState` enum('open','merge_guarded') NOT NULL DEFAULT 'open',
	`activeMergeCaseId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accountMutationGuards_userId` PRIMARY KEY(`userId`),
	CONSTRAINT `accountMutationGuards_activeMergeCaseId_unique` UNIQUE(`activeMergeCaseId`)
);
--> statement-breakpoint
ALTER TABLE `accountMutationGuards` ADD CONSTRAINT `accountMutationGuards_userId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO `accountMutationGuards` (`userId`, `generation`, `mergeState`, `activeMergeCaseId`)
SELECT
  u.`id`,
  CASE WHEN amc.`id` IS NULL THEN 0 ELSE 1 END AS `generation`,
  CASE WHEN amc.`id` IS NULL THEN 'open' ELSE 'merge_guarded' END AS `mergeState`,
  amc.`id` AS `activeMergeCaseId`
FROM `users` u
LEFT JOIN `accountMergeCases` amc
  ON amc.`sourceUserId` = u.`id`
 AND amc.`status` <> 'cancelled';