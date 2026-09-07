CREATE TABLE IF NOT EXISTS `paymentProviderClaims` (
 `claimKey` varchar(64) NOT NULL PRIMARY KEY,
 `subjectType` varchar(16) NOT NULL,
 `subjectId` int NOT NULL,
 `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
ALTER TABLE `walletTopups` MODIFY COLUMN `approvalSource` enum('manual','ocr_auto','provider_auto') DEFAULT 'manual';
