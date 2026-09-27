CREATE TABLE `workspaceEditorialStructuralConfirmations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workItemId` int NOT NULL,
  `draftId` int NOT NULL,
  `anomalyKey` varchar(64) NOT NULL,
  `anomalyType` varchar(80) NOT NULL,
  `sourceTabId` varchar(255) NOT NULL,
  `status` enum('confirmed','revoked') NOT NULL DEFAULT 'confirmed',
  `actorUserId` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspaceEditorialStructuralConfirmations_id` PRIMARY KEY(`id`),
  CONSTRAINT `wesc_item_draft_anomaly_unique` UNIQUE(`workItemId`,`draftId`,`anomalyKey`),
  CONSTRAINT `wesc_work_item_fk` FOREIGN KEY (`workItemId`) REFERENCES `workspaceEditorialWorkItems`(`id`) ON DELETE CASCADE,
  CONSTRAINT `wesc_draft_fk` FOREIGN KEY (`draftId`) REFERENCES `workspaceEditorialDrafts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `wesc_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `wesc_item_draft_status_idx`
  ON `workspaceEditorialStructuralConfirmations` (`workItemId`,`draftId`,`status`);
