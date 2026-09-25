ALTER TABLE `workspaceEditorialWorkItems` ADD `saleMode` enum('chapter','package');--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD `price` decimal(10,2);--> statement-breakpoint
ALTER TABLE `workspaceEditorialWorkItems` ADD `isFree` boolean;--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD `stageContract` varchar(100);--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD `saleMode` enum('chapter','package');--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD `price` decimal(10,2);--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` ADD `isFree` boolean;
