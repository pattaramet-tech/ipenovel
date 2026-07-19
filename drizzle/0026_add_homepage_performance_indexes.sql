CREATE INDEX `episodes_isPublished_createdAt_idx` ON `episodes` (`isPublished`,`createdAt`);--> statement-breakpoint
CREATE INDEX `novels_publicationStatus_createdAt_idx` ON `novels` (`publicationStatus`,`createdAt`);--> statement-breakpoint
CREATE INDEX `purchases_novelId_idx` ON `purchases` (`novelId`);