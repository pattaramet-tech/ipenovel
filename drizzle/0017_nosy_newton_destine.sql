ALTER TABLE `payments` ADD `ocrConfidence` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `ocrDecision` enum('auto_approved','needs_review','rejected','ocr_disabled','shadow_auto_approved');--> statement-breakpoint
CREATE INDEX `payments_ocrConfidence_idx` ON `payments` (`ocrConfidence`);--> statement-breakpoint
CREATE INDEX `payments_ocrDecision_idx` ON `payments` (`ocrDecision`);