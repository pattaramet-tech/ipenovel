CREATE TABLE `ocrAnomalyAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`alertType` varchar(100) NOT NULL,
	`severity` varchar(20) NOT NULL,
	`message` text NOT NULL,
	`detectedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`metricValue` decimal(10,4) NOT NULL,
	`threshold` decimal(10,4) NOT NULL,
	`affectedCount` int NOT NULL,
	`recommendedAction` text NOT NULL,
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocrAnomalyAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ocrMetrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paymentId` int NOT NULL,
	`orderId` int NOT NULL,
	`processedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`processingDurationMs` int NOT NULL,
	`uploadSource` varchar(50) NOT NULL DEFAULT 'web',
	`slipImageUrl` text NOT NULL,
	`detectedBank` varchar(50) NOT NULL,
	`transferType` varchar(50) NOT NULL,
	`ocrOverallConfidence` decimal(5,2) NOT NULL,
	`fieldConfidenceJson` json NOT NULL,
	`signalScoresJson` json NOT NULL,
	`weightedScore` decimal(4,3) NOT NULL,
	`decision` varchar(50) NOT NULL,
	`reasonCode` varchar(100),
	`isAutoApproved` boolean NOT NULL,
	`isDuplicate` boolean NOT NULL DEFAULT false,
	`duplicateFingerprint` varchar(64),
	`duplicateReason` text,
	`extractedAmount` decimal(12,2),
	`extractedReceiverName` varchar(255),
	`extractedSenderName` varchar(255),
	`extractedTransactionDate` timestamp,
	`errorCategory` varchar(100),
	`errorMessage` text,
	`errorStack` text,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocrMetrics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ocrThresholdHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`changedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`changedByAdminId` int,
	`minWeightedScore` decimal(4,3) NOT NULL,
	`minCriticalSignalScore` decimal(4,3) NOT NULL,
	`minOcrConfidence` decimal(5,2) NOT NULL,
	`timeWindowDays` int NOT NULL,
	`autoApprovalRateBefore` decimal(5,4),
	`autoApprovalRateAfter` decimal(5,4),
	`manualReviewRateBefore` decimal(5,4),
	`manualReviewRateAfter` decimal(5,4),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocrThresholdHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ocrAnomalyAlerts_severity_idx` ON `ocrAnomalyAlerts` (`severity`);--> statement-breakpoint
CREATE INDEX `ocrAnomalyAlerts_detectedAt_idx` ON `ocrAnomalyAlerts` (`detectedAt`);--> statement-breakpoint
CREATE INDEX `ocrMetrics_paymentId_idx` ON `ocrMetrics` (`paymentId`);--> statement-breakpoint
CREATE INDEX `ocrMetrics_orderId_idx` ON `ocrMetrics` (`orderId`);--> statement-breakpoint
CREATE INDEX `ocrMetrics_processedAt_idx` ON `ocrMetrics` (`processedAt`);--> statement-breakpoint
CREATE INDEX `ocrMetrics_decision_idx` ON `ocrMetrics` (`decision`);--> statement-breakpoint
CREATE INDEX `ocrMetrics_detectedBank_idx` ON `ocrMetrics` (`detectedBank`);--> statement-breakpoint
CREATE INDEX `ocrThresholdHistory_changedAt_idx` ON `ocrThresholdHistory` (`changedAt`);