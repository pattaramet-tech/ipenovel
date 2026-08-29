ALTER TABLE `accountMergeCases` ADD `guardedSourceMarker` int GENERATED ALWAYS AS ((case when `status` <> 'cancelled' then `sourceUserId` else NULL end)) STORED;--> statement-breakpoint
ALTER TABLE `accountMergeCases` ADD `startedAt` timestamp;--> statement-breakpoint
ALTER TABLE `accountMergeCases` ADD `failedAt` timestamp;--> statement-breakpoint
ALTER TABLE `accountMergeCases` ADD `failureReason` text;--> statement-breakpoint
ALTER TABLE `accountMergeCases` ADD CONSTRAINT `accountMergeCases_one_guarded_per_source_unique` UNIQUE(`guardedSourceMarker`);