ALTER TABLE `novels` MODIFY COLUMN `status` enum('ongoing','completed','hiatus','pending') DEFAULT 'ongoing';--> statement-breakpoint
ALTER TABLE `novels` ADD `publicationStatus` enum('published','archived') DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE `novels` ADD `storyStatus` enum('ongoing','finished') DEFAULT 'ongoing' NOT NULL;--> statement-breakpoint
CREATE INDEX `novels_publicationStatus_idx` ON `novels` (`publicationStatus`);