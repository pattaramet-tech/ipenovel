# Root Cause — Migration 0024 Fails on a Fresh Database

Audited from `fix/daily-checkin-safe` after a real migration run against a
disposable `ipenovel_test` database failed at
`drizzle/0024_widen_episode_content_mediumtext.sql`:

```sql
ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext;
```

with an unknown-column error, because `episodes.content` did not exist yet.

## Root cause: **A — Missing executable migration / snapshot drift**

`drizzle/0023_gifted_juggernaut.sql` exists on disk and contains exactly
the schema changes that are missing:

```sql
CREATE TABLE `episodePurchases` (...);
CREATE TABLE `readingProgress` (...);
ALTER TABLE `episodes` ADD `content` text;
ALTER TABLE `episodes` ADD `contentFormat` varchar(50) DEFAULT 'plain_text';
ALTER TABLE `episodes` ADD `isPublished` boolean DEFAULT true NOT NULL;
ALTER TABLE `episodes` ADD `publishedAt` timestamp;
ALTER TABLE `episodes` ADD `wordCount` int;
ALTER TABLE `episodes` ADD `sortOrder` int;
CREATE INDEX ... (9 indexes across episodePurchases/readingProgress/episodes)
```

But `drizzle/meta/_journal.json` has **no entry** with
`tag: "0023_gifted_juggernaut"`. Its only `idx: 23` entry is
`tag: "0023_add_episode_sale_mode"`.

`drizzle-orm`'s migrator never scans the `drizzle/` directory. Verified by
reading the installed package directly
(`node_modules/.pnpm/drizzle-orm@0.44.7.../drizzle-orm/migrator.js`):

```js
function readMigrationFiles(config) {
  const journal = JSON.parse(fs.readFileSync(`${migrationFolderTo}/meta/_journal.json`));
  for (const journalEntry of journal.entries) {
    const query = fs.readFileSync(`${migrationFolderTo}/${journalEntry.tag}.sql`).toString();
    // ... pushed into migrationQueries
  }
  return migrationQueries;
}
```

It reads **only** `journal.entries` and resolves each entry's `.sql` file
by tag. A `.sql` file with no journal entry is invisible to `migrate()`,
full stop — this is not an execution bug, the statements are never even
read off disk.

Confirmed for real, not by inference:

| Check | Result |
|---|---|
| `drizzle/0001_steep_romulus.sql`'s `CREATE TABLE episodes` | No `content`/reader columns (verified by reading the file) |
| `drizzle/0002` through `drizzle/0022` (every journal-registered file) | None create `content`, `contentFormat`, `isPublished`, `publishedAt`, `wordCount`, `sortOrder`, `episodePurchases`, or `readingProgress` (verified via grep across every file) |
| `drizzle/0023_add_episode_sale_mode.sql` (the only journal-registered "0023") | Contains exactly one statement: `ALTER TABLE episodes ADD saleMode ...` — nothing else |
| `drizzle/meta/0022_snapshot.json`'s `episodes.columns` | 12 columns, none of the missing ones |
| `drizzle/meta/0023_snapshot.json`'s `episodes.columns` | 18 columns — **includes all 6 missing columns**, plus `saleMode` |
| `drizzle/meta/0023_snapshot.json`'s tables | **Includes `episodePurchases` and `readingProgress`** |

This is the direct proof of "snapshot drift": the snapshot recorded as the
state *after* journal index 23 already reflects `gifted_juggernaut.sql`'s
changes, but the *only executable migration actually registered* at that
index (`0023_add_episode_sale_mode.sql`) does not produce that state from
a database that only has `0000`–`0022` applied. The snapshot chain and the
executable chain diverged at index 23 and every migration after it
(`0024`, `0025`) was generated against the (correct-looking but
unreachable) snapshot state, not against what the executable chain
actually produces.

`drizzle/0025_add_reading_progress_toc_columns.sql` has the same
precondition problem one level down — it `ALTER TABLE readingProgress ADD
...`, which requires the table `gifted_juggernaut.sql` was supposed to
create.

## Why this is NOT root cause C (a migrator execution bug)

Ruling out C requires proof the migrator *received* the missing
statements and skipped them. It did not: `readMigrationFiles()` never even
opens `0023_gifted_juggernaut.sql` because no journal entry names it. The
statements were never read off disk, never handed to the SQL driver, and
never logged as attempted — there is nothing for a "skip" to have
happened to. This is a data problem (an orphaned file + a journal that
never referenced it), not a code-execution problem.

## Why editing `0024`'s SQL directly is safe (not root-causing a NEW bug)

Read `mysql-core/dialect.js`'s `migrate()` directly:

```js
const dbMigrations = await session.all(
  sql`select id, hash, created_at from ${migrationsTable} order by created_at desc limit 1`
);
const lastDbMigration = dbMigrations[0];
for (const migration of migrations) {
  if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
    // execute migration.sql, then record it
  }
}
```

Skip/resume is decided **only** by comparing each migration's journal
`when` timestamp (`folderMillis`) against the single latest recorded
`created_at` — **never by hash, never by file content.** This means:

- A database that has *already* recorded `0024` successfully will skip it
  by timestamp regardless of what its file contains today - editing the
  file changes nothing for that database.
- A database that has *never* successfully recorded `0024` (true of every
  database this bug has ever been hit on, by definition - a failed
  migration is never recorded) will run whatever the file currently
  contains.

Editing `0024`'s SQL to be self-healing is therefore safe for every
database in every state - see the fix below and
`docs/TEST_INFRASTRUCTURE.md` for the regression tests that exercise this
directly (`readingProgress`/`episodes` in every combination of already
-present, partially-present, and absent, migration rerun, and journal
resume-by-timestamp).

## The fix

Two-part repair, per the explicit design this task required:

1. **`drizzle/0024_widen_episode_content_mediumtext.sql` was rewritten**
   to idempotently create everything `gifted_juggernaut.sql` was supposed
   to create (`CREATE TABLE IF NOT EXISTS` for the two tables,
   `information_schema`-guarded `ALTER TABLE ADD COLUMN`/`CREATE INDEX`
   for the six columns and nine indexes) *before* its original
   `MODIFY COLUMN content mediumtext` statement — this is what lets a
   genuinely fresh database migrate 0000 through 0027 successfully.
2. **`drizzle/0028_repair_episode_reader_schema.sql`** (new, final,
   idempotent) re-applies the exact same guarded checks, so a database
   whose `__drizzle_migrations` high-water mark is already past 0024/0025
   (and therefore would skip the repaired 0024 by timestamp, per the
   resume logic above) still gets repaired if its actual schema is
   missing these objects for any other reason (a manually-managed
   database, a partial `drizzle-kit push`, or any other drift). For a
   database whose schema is already correct, every check in 0028 is a
   guarded no-op.

Both files reproduce the exact, historically-correct intermediate state:
`content` is added as `TEXT` (not `MEDIUMTEXT` directly - 0024's own
`MODIFY COLUMN` still does that upgrade afterward) and `readingProgress`
is created *without* the `currentChapterNumber`/`currentChapterTitle`/
`anchorKey` columns (0025 still adds those afterward) - see requirement 9.
