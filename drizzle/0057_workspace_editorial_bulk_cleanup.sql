ALTER TABLE `workspaceEditorialDraftEditEvents`
  MODIFY COLUMN `editKind` enum(
    'replace_sentence',
    'replace_range',
    'replace_paragraph',
    'bulk_cleanup',
    'undo'
  ) NOT NULL;
