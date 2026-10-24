-- Reader Session Controls (R2): session registry, per-user login-slot counter,
-- and the per-user paid-reading lease. Purely additive — no existing table,
-- column, or row is modified.
-- Rollback is CONSTRAINED BY THE REVOCATION FLOOR: the registry remains
-- authoritative (and revocation keeps biting) while ANY build that reads it
-- runs, and until every v2 cookie it authorized has expired — i.e. one full
-- session-JWT lifetime past the last issuance. Dropping `authSessions`
-- earlier would orphan registry-authoritative credentials (v2 tokens carry
-- sid and hard-fail without their row). Only after that window, DROP TABLE
-- in reverse dependency order (authSessions is referenced by the other two
-- and must drop LAST):
--   DROP TABLE `readingLeases`;
--   DROP TABLE `sessionSlots`;
--   DROP TABLE `authSessions`;
-- Rows are never deleted by feature-flag changes alone: flag OFF keeps the
-- floor enforced (revoked/superseded rows still reject their cookies).

--> statement-breakpoint
CREATE TABLE `authSessions` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `userId` int NOT NULL,
  -- Server-generated session identity (128-bit CSPRNG, base64url). Present on
  -- v2-minted tokens (inside the JWT `sid` claim) and on adopted legacy rows
  -- (server-side only; the legacy JWT itself is never rewritten).
  `sid` varchar(64) NOT NULL,
  -- sha256 hex of the raw cookie JWT. Revocation/replay ledger + the only way
  -- to bind a legacy (v1, sid-less) cookie to its registry row.
  `tokenHash` char(64) NOT NULL,
  `tokenVersion` tinyint NOT NULL DEFAULT 2,
  `status` enum('active','pending_choice','revoked','superseded','unslotted_legacy') NOT NULL DEFAULT 'active',
  `revokedReason` varchar(64) NULL,
  `loginAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lastSeenAt` timestamp NULL,
  `expiresAt` timestamp NOT NULL,
  `createdVia` enum('google','manus','adoption','offpath') NOT NULL,
  -- Display-only label derived from the login User-Agent. NEVER an authority.
  `clientLabel` varchar(255) NULL,
  -- Lineage pointer: id of the row this row replaced (rotation/adoption).
  `adoptOf` int NULL,
  UNIQUE KEY `auth_sessions_sid_unique` (`sid`),
  UNIQUE KEY `auth_sessions_token_hash_unique` (`tokenHash`),
  KEY `auth_sessions_user_status_idx` (`userId`, `status`),
  CONSTRAINT `auth_sessions_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `auth_sessions_adopt_of_fk` FOREIGN KEY (`adoptOf`) REFERENCES `authSessions` (`id`) ON DELETE SET NULL
);

--> statement-breakpoint
CREATE TABLE `sessionSlots` (
  -- One row per user: slot arithmetic locks THIS row only, so concurrent
  -- logins of different users never contend and financial transactions that
  -- lock the users row are never blocked by session bookkeeping.
  `userId` int NOT NULL PRIMARY KEY,
  -- Advisory counter; the authoritative active count is recomputed from
  -- authSessions inside the user-lock transaction.
  `activeCount` int NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `session_slots_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE
);

--> statement-breakpoint
CREATE TABLE `readingLeases` (
  -- One row per user: at most one active paid-reading lease.
  `userId` int NOT NULL PRIMARY KEY,
  `holderSessionId` int NOT NULL,
  `leaseVersion` int NOT NULL DEFAULT 1,
  `acquiredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiresAt` timestamp NOT NULL,
  CONSTRAINT `reading_leases_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `reading_leases_session_fk` FOREIGN KEY (`holderSessionId`) REFERENCES `authSessions` (`id`) ON DELETE CASCADE
);
