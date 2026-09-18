ALTER TABLE `workspaceEditorialEpisodeStages` ADD CONSTRAINT `wees_approval_episode_unique` UNIQUE(`approvalId`,`episodeNumber`);--> statement-breakpoint
ALTER TABLE `workspaceEditorialEpisodeStages` DROP INDEX `wees_approval_unique`;
