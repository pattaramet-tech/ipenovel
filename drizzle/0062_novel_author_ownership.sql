-- IPE-063: stable admin-as-author ownership for novels.
-- Additive and nullable so legacy novels remain untouched; no ownership is
-- guessed from the free-text author display name.

ALTER TABLE `novels` ADD COLUMN `authorUserId` int;
--> statement-breakpoint
CREATE INDEX `novels_authorUserId_idx` ON `novels` (`authorUserId`);
--> statement-breakpoint
ALTER TABLE `novels`
  ADD CONSTRAINT `novels_authorUserId_users_id_fk`
  FOREIGN KEY (`authorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
-- IPE-063R1: pen name / author display name, separate from the account name.
-- Nullable: legacy admins keep NULL and resolve to their account name.
ALTER TABLE `users` ADD COLUMN `authorName` varchar(255);
