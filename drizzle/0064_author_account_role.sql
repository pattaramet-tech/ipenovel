-- IPE-070R1: add the author account role beside user and admin.
-- Additive ENUM change. Existing user and admin rows keep their values.
-- Rollback, only after every author row has been reassigned:
--   UPDATE `users` SET `role` = 'user' WHERE `role` = 'author';
--   ALTER TABLE `users` MODIFY COLUMN `role` ENUM('user','admin') NOT NULL DEFAULT 'user';
ALTER TABLE `users`
  MODIFY COLUMN `role` ENUM('user','author','admin') NOT NULL DEFAULT 'user';
