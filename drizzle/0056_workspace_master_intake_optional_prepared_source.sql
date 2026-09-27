ALTER TABLE `workspaceMasterIntakeRows`
  MODIFY COLUMN `preparedSourceDocUrl` text NULL,
  MODIFY COLUMN `preparedSourceDocumentId` varchar(255) NULL;
