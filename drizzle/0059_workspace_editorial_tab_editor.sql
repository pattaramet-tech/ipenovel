ALTER TABLE `workspaceEditorialDraftEditEvents`
  MODIFY COLUMN `editKind` enum(
    'replace_sentence',
    'replace_range',
    'replace_paragraph',
    'replace_tab',
    'bulk_cleanup',
    'undo'
  ) NOT NULL;
