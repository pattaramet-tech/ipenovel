DROP TABLE `ocrAnomalyAlerts`;--> statement-breakpoint
DROP TABLE `ocrMetrics`;--> statement-breakpoint
DROP TABLE `ocrThresholdHistory`;--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `approvalSource`;--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `approvedByAdminId`;--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `approvedByLabel`;--> statement-breakpoint
ALTER TABLE `payments` DROP COLUMN `approvedAt`;