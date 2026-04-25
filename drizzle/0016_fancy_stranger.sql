ALTER TABLE `payments` ADD `approvalSource` enum('manual','auto','wallet','legacy') DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedByAdminId` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedByLabel` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedAt` timestamp;--> statement-breakpoint
CREATE INDEX `payments_approvalSource_idx` ON `payments` (`approvalSource`);--> statement-breakpoint
CREATE INDEX `payments_approvedByAdminId_idx` ON `payments` (`approvedByAdminId`);