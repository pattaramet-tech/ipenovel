ALTER TABLE `walletTopups` MODIFY COLUMN `status` enum('pending','pending_review','approved','rejected','cancelled') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `slipSubmittedAt` timestamp;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `approvedAt` timestamp;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `approvedByAdminId` int;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `rejectedAt` timestamp;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `extractedData` text;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `ocrConfidence` decimal(5,2);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `visionConfidence` decimal(5,2);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `structuredConfidence` decimal(5,2);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `finalConfidence` decimal(5,2);--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `duplicateStatus` text;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `ocrDecision` enum('approved','needs_review','rejected');--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `reviewReason` text;--> statement-breakpoint
ALTER TABLE `walletTopups` ADD `approvalSource` enum('manual','ocr_auto') DEFAULT 'manual';