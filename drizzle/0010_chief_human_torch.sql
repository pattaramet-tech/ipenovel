ALTER TABLE `payments` MODIFY COLUMN `status` enum('pending','approved','rejected','pending_review') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `payments` ADD `extractedData` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reviewReason` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `fingerprint` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `autoApprovedAt` timestamp;--> statement-breakpoint
CREATE INDEX `payments_fingerprint_idx` ON `payments` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`);