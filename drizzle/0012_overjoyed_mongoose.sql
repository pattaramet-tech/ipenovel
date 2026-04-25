ALTER TABLE `payments` ADD `approvalSource` enum('auto','manual');--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedByAdminId` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedByLabel` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `approvedAt` timestamp;