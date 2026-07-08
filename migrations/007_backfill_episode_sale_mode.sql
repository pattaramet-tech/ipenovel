-- Backfill saleMode for episodes created before the saleMode column existed.
--
-- The schema migration (drizzle/0023_add_episode_sale_mode.sql) adds
-- `saleMode ENUM('chapter','package') DEFAULT 'chapter' NOT NULL`, which
-- means MySQL backfills every pre-existing row with the literal 'chapter' -
-- including old "ขายไฟล์" rows that were actually multi-chapter file
-- packages. This migration reclassifies those rows as 'package' so the new
-- web-only package reader treats them correctly, without needing every read
-- path to re-derive it at query time.
--
-- Idempotent: safe to run multiple times. Only touches rows that still look
-- like legacy file-based or range-numbered episodes; never touches rows an
-- admin has already explicitly set.
--
-- Run this AFTER drizzle/0023_add_episode_sale_mode.sql has been applied.

UPDATE episodes
SET saleMode = 'package'
WHERE saleMode = 'chapter'
  AND (
    (fileUrl IS NOT NULL AND TRIM(fileUrl) <> '')
    OR episodeNumber REGEXP '^[[:space:]]*[0-9]+(\\.[0-9]+)?[[:space:]]*-[[:space:]]*[0-9]+(\\.[0-9]+)?[[:space:]]*$'
  );
