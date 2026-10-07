-- IPE-066A: remove two unused global fingerprint lookup indexes from the
-- immutable editorial draft paragraph store. The fingerprint columns and all
-- uniqueness/FK constraints remain unchanged; this migration deletes no data.
--
-- Guard each DROP with information_schema so retry/partial-application states
-- fail safe instead of erroring merely because one index is already absent.

SET @ipe066a_has_paragraph_fp_idx = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'workspaceEditorialDraftParagraphs'
    AND index_name = 'wedp_fingerprint_idx'
);
--> statement-breakpoint
SET @ipe066a_drop_paragraph_fp_idx = IF(
  @ipe066a_has_paragraph_fp_idx > 0,
  'ALTER TABLE `workspaceEditorialDraftParagraphs` DROP INDEX `wedp_fingerprint_idx`, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE ipe066a_drop_paragraph_fp_idx_stmt FROM @ipe066a_drop_paragraph_fp_idx;
--> statement-breakpoint
EXECUTE ipe066a_drop_paragraph_fp_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe066a_drop_paragraph_fp_idx_stmt;
--> statement-breakpoint

SET @ipe066a_has_source_fp_idx = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'workspaceEditorialDraftParagraphs'
    AND index_name = 'wedp_source_fingerprint_idx'
);
--> statement-breakpoint
SET @ipe066a_drop_source_fp_idx = IF(
  @ipe066a_has_source_fp_idx > 0,
  'ALTER TABLE `workspaceEditorialDraftParagraphs` DROP INDEX `wedp_source_fingerprint_idx`, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE ipe066a_drop_source_fp_idx_stmt FROM @ipe066a_drop_source_fp_idx;
--> statement-breakpoint
EXECUTE ipe066a_drop_source_fp_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE ipe066a_drop_source_fp_idx_stmt;
