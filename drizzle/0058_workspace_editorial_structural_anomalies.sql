ALTER TABLE `workspaceEditorialCheckerRuns`
  ADD COLUMN `tabCount` int NOT NULL DEFAULT 0,
  ADD COLUMN `expectedTabCount` int NULL,
  ADD COLUMN `anomalyCount` int NOT NULL DEFAULT 0,
  ADD COLUMN `blockingAnomalyCount` int NOT NULL DEFAULT 0;

CREATE TABLE `workspaceEditorialCheckerAnomalies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runId` int NOT NULL,
  `anomalyKey` varchar(64) NOT NULL,
  `anomalyType` varchar(80) NOT NULL,
  `severity` enum('warning','error') NOT NULL,
  `sourceTabId` varchar(255),
  `tabTitle` varchar(500),
  `chapterNumber` varchar(100),
  `relatedSourceTabIdsJson` text NOT NULL,
  `message` text NOT NULL,
  `detailsJson` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workspaceEditorialCheckerAnomalies_id` PRIMARY KEY(`id`),
  CONSTRAINT `weca_run_fk`
    FOREIGN KEY (`runId`)
    REFERENCES `workspaceEditorialCheckerRuns`(`id`)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX `weca_run_anomaly_unique`
  ON `workspaceEditorialCheckerAnomalies` (`runId`, `anomalyKey`);

CREATE INDEX `weca_run_type_idx`
  ON `workspaceEditorialCheckerAnomalies` (`runId`, `anomalyType`);
