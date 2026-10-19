-- IPE-070R6B: store the Admin who first requested publish execution.
-- Existing rows stay NULL. NULL means the requester was not recorded.
-- Do not backfill. A later retry must not invent a requester for those rows.
-- Rollback, after the application no longer reads the column:
--   ALTER TABLE `workspacePublishRuns` DROP FOREIGN KEY `wpr_requested_by_fk`;
--   ALTER TABLE `workspacePublishRuns` DROP COLUMN `requestedByUserId`;
ALTER TABLE `workspacePublishRuns`
  ADD COLUMN `requestedByUserId` int NULL,
  ADD CONSTRAINT `wpr_requested_by_fk`
  FOREIGN KEY (`requestedByUserId`) REFERENCES `users` (`id`);
