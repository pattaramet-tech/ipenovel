-- P3-R8 FINAL SAFETY CLOSURE: transactional execution mutex for the
-- chapter-to-package upgrade. Replaces the connection-scoped MySQL named
-- lock (GET_LOCK/RELEASE_LOCK on `packageUpgrade:cart:<userId>`) with a
-- per-user row held FOR UPDATE NOWAIT inside the execute transaction - the
-- lock is released by commit/rollback ITSELF, so there is no explicit
-- release step that can fail, no connection-scoped state that can leak
-- into the pool, and no kill-based cleanup shortcut. Purely additive; the
-- row is a permanent mutex handle seeded by quotePackageUpgrade and never
-- deleted.
--
-- Rollback (only after the feature flag/code is gone):
--   DROP TABLE `packageUpgradeExecLocks`;

--> statement-breakpoint
CREATE TABLE `packageUpgradeExecLocks` (
  `userId` int PRIMARY KEY,
  `createdAt` timestamp DEFAULT (now()) NOT NULL
);
