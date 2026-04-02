ALTER TABLE `walletTopups` ADD `bonusAmount` decimal(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `creditedAmount` decimal(12,2);