CREATE TABLE `authIdentities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`provider` varchar(32) NOT NULL,
	`providerSubject` varchar(255) NOT NULL,
	`emailAtLink` varchar(320) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `authIdentities_id` PRIMARY KEY(`id`),
	CONSTRAINT `authIdentities_provider_providerSubject_unique` UNIQUE(`provider`,`providerSubject`),
	CONSTRAINT `authIdentities_userId_provider_unique` UNIQUE(`userId`,`provider`)
);
--> statement-breakpoint
ALTER TABLE `authIdentities` ADD CONSTRAINT `authIdentities_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `authIdentities_userId_idx` ON `authIdentities` (`userId`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);