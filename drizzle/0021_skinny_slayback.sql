ALTER TABLE `payments` MODIFY COLUMN `ocrConfidence` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `ocrConfidence` int NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `ocrDecision` enum('auto_approved','needs_review','rejected','ocr_disabled','shadow_auto_approved') NOT NULL DEFAULT 'needs_review';