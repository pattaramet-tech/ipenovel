CREATE TABLE `topupLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`bonus` decimal(12,2) NOT NULL DEFAULT '0.00',
	`total` decimal(12,2) NOT NULL,
	`method` enum('slip','admin_adjust','promo') NOT NULL,
	`reference` varchar(255),
	`note` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `topupLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `topupLogs_userId_idx` ON `topupLogs` (`userId`);--> statement-breakpoint
CREATE INDEX `topupLogs_method_idx` ON `topupLogs` (`method`);--> statement-breakpoint
CREATE INDEX `topupLogs_createdAt_idx` ON `topupLogs` (`createdAt`);