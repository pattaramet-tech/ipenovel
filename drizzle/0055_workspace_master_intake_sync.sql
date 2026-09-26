CREATE TABLE `workspaceMasterIntakeRows` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `workspaceNovelId` int NOT NULL,
  `workItemId` int NOT NULL,
  `spreadsheetId` varchar(128) NOT NULL,
  `sheetId` int NOT NULL,
  `sheetName` varchar(255) NOT NULL,
  `rowNumber` int NOT NULL,
  `rawTitle` varchar(500) NOT NULL,
  `normalizedTitle` varchar(500) NOT NULL,
  `episodeNumber` varchar(100) NOT NULL,
  `translationDocUrl` text NOT NULL,
  `translationDocumentId` varchar(255) NOT NULL,
  `webSourceUrl` text,
  `preparedSourceDocUrl` text NOT NULL,
  `preparedSourceDocumentId` varchar(255) NOT NULL,
  `rowFingerprint` varchar(64) NOT NULL,
  `lastSyncedByUserId` int NOT NULL,
  `createdAt` timestamp DEFAULT (now()) NOT NULL,
  `updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT `workspaceMasterIntakeRows_id` PRIMARY KEY(`id`),
  CONSTRAINT `wmir_workspace_sheet_row_unique` UNIQUE(`workspaceId`,`spreadsheetId`,`sheetId`,`rowNumber`),
  CONSTRAINT `wmir_work_item_unique` UNIQUE(`workItemId`)
);
--> statement-breakpoint
ALTER TABLE `workspaceMasterIntakeRows` ADD CONSTRAINT `wmir_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaceWorkspaces`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceMasterIntakeRows` ADD CONSTRAINT `wmir_workspace_novel_fk` FOREIGN KEY (`workspaceNovelId`) REFERENCES `workspaceNovels`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceMasterIntakeRows` ADD CONSTRAINT `wmir_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `workspaceMasterIntakeRows` ADD CONSTRAINT `wmir_synced_by_fk` FOREIGN KEY (`lastSyncedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `wmir_workspace_updated_idx` ON `workspaceMasterIntakeRows` (`workspaceId`,`updatedAt`);
