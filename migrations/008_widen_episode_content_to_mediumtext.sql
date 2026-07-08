-- Widen episodes.content from TEXT (~64KB max) to MEDIUMTEXT (~16MB max).
--
-- A "package" episode (saleMode = 'package') bundles many chapters worth of
-- plaintext into a single row - e.g. 50-100 chapters routinely exceeds
-- TEXT's ~64KB limit. MEDIUMTEXT comfortably covers realistic package sizes
-- (tens of thousands of words) while LONGTEXT is not needed at this scale.
--
-- Safe/idempotent: MODIFY COLUMN to a strictly larger text type does not
-- truncate or alter existing data. Safe to re-run if already applied (MySQL
-- will just report the column as already mediumtext with no data change).
--
-- IMPORTANT: Run this BEFORE deploying code that imports large package
-- content (the ZIP/TXT package importer) - a package import against an
-- unmigrated TEXT column will silently truncate content over ~64KB.

ALTER TABLE episodes MODIFY COLUMN content MEDIUMTEXT;
