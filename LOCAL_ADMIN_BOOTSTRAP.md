# Local Admin Bootstrap - Migration Safety Architecture

⚠️ **THIS DOCUMENT DESCRIBES LOCAL/DEV-ONLY BEHAVIOR**

This file documents the migration safety architecture and why production deployment is safe from accidental admin seeding.

---

## Problem Solved

**Previous Risk:**
- Renamed `0003_admin_seed.sql` to `0003_LOCAL_ADMIN_SEED.sql`
- Created filename conflict with `0003_flippant_moondragon.sql`
- Alphabetical sorting would apply migrations in wrong order
- Migration journal mismatch

**Solution:**
- Moved local admin seed OUT of numbered migration chain
- Renamed to `LOCAL_ADMIN_BOOTSTRAP.sql` (no 0000_ prefix)
- Created separate bootstrap script: `apply-local-admin-bootstrap.mjs`
- Canonical migrations (0000_*.sql - 0013_*.sql) remain untouched
- Local admin bootstrap is completely separate

---

## Architecture Overview

### Canonical Migration Chain (Production & Development)

```
apply-migrations.mjs
├─ Filter: Only files matching /^\d{4}_/ (0000_*, 0001_*, etc.)
├─ Applies: drizzle/0000_needy_anthem.sql
├─ Applies: drizzle/0001_steep_romulus.sql
├─ Applies: drizzle/0002_goofy_hairball.sql
├─ Applies: drizzle/0003_flippant_moondragon.sql
├─ Applies: drizzle/0004_blue_rachel_grey.sql
├─ ...
├─ Applies: drizzle/0013_bent_quasar.sql
└─ SKIPS: drizzle/LOCAL_ADMIN_BOOTSTRAP.sql (not numbered)

Result: 14 canonical migrations applied
        Migration journal: 14 entries (0000-0013)
        Schema: Complete and production-ready
        Admin: None (must be created separately)
```

### Local Admin Bootstrap Path (Development Only)

```
apply-local-admin-bootstrap.mjs
└─ Applies: drizzle/LOCAL_ADMIN_BOOTSTRAP.sql
   (Separate from canonical migrations)

Result: Local admin account created
        Migration journal: Unchanged (still 14 entries)
        Schema: Unchanged
        Admin: admin@ipenovel.com / Ipe@novel2026
```

---

## File Structure and Naming

### Migration Files

```
drizzle/
├─ 0000_needy_anthem.sql              ✅ Canonical (schema)
├─ 0001_steep_romulus.sql             ✅ Canonical (schema)
├─ 0002_goofy_hairball.sql            ✅ Canonical (schema)
├─ 0003_flippant_moondragon.sql       ✅ Canonical (schema)
├─ 0004_blue_rachel_grey.sql          ✅ Canonical (schema)
├─ ... (0005 through 0013)
├─ LOCAL_ADMIN_BOOTSTRAP.sql          ⚠️  Bootstrap (dev-only, NOT numbered)
├─ meta/
│  ├─ 0000_snapshot.json              ✅ Canonical snapshot
│  ├─ 0001_snapshot.json              ✅ Canonical snapshot
│  ├─ ... (0002 through 0013)
│  └─ _journal.json                   ✅ Tracks 14 canonical migrations
```

### Key Naming Convention

- **Numbered files (0000_*.sql):** Part of canonical migration chain
- **Non-numbered files (LOCAL_ADMIN_BOOTSTRAP.sql):** Bootstrap scripts, not in chain

---

## Safety Guarantees

### 1. Canonical Migration Order is Preserved

**Before (Risk):**
```
0003_LOCAL_ADMIN_SEED.sql      ← Alphabetically first
0003_flippant_moondragon.sql   ← Alphabetically second
```
Alphabetical sort would apply in wrong order!

**After (Safe):**
```
apply-migrations.mjs filters: /^\d{4}_/
├─ 0003_flippant_moondragon.sql   ✅ Applied in correct order
└─ LOCAL_ADMIN_BOOTSTRAP.sql      ❌ Skipped (not numbered)
```

### 2. Migration Journal Stays Clean

**Before (Risk):**
```
_journal.json entries: 15 (0000-0014)
But only 14 actual migrations exist
Journal mismatch!
```

**After (Safe):**
```
_journal.json entries: 14 (0000-0013)
Matches exactly 14 canonical migrations
No mismatch!
```

### 3. Fresh Production Setup Works Correctly

```bash
# Production deployment
export NODE_ENV=production
node apply-migrations.mjs

# Result:
# ✓ Applies 14 canonical migrations
# ✓ Skips LOCAL_ADMIN_BOOTSTRAP.sql (not numbered)
# ✓ Schema is complete and correct
# ✓ No admin account created (intentional)
# ✓ Migration journal: 14 entries
```

### 4. Fresh Local/Dev Setup Works Correctly

```bash
# Local development
export NODE_ENV=development
node apply-migrations.mjs
node apply-local-admin-bootstrap.mjs

# Result:
# ✓ Applies 14 canonical migrations
# ✓ Skips LOCAL_ADMIN_BOOTSTRAP.sql (not numbered)
# ✓ Schema is complete
# ✓ Then applies LOCAL_ADMIN_BOOTSTRAP.sql separately
# ✓ Local admin account created
# ✓ Migration journal: 14 entries (unchanged)
```

### 5. Existing Environments Not Affected

**Environments that already ran migrations:**
- Migration journal already has 14 entries
- Canonical migrations already applied
- LOCAL_ADMIN_BOOTSTRAP.sql is separate (won't re-apply)
- No conflicts or regressions

---

## Implementation Details

### apply-migrations.mjs Filter Logic

```javascript
// Only include numbered migrations (0000_*, 0001_*, etc.)
// Skip LOCAL_ADMIN_BOOTSTRAP.sql (applied separately for local/dev)
.filter(f => /^\d{4}_/.test(f))
```

**Regex Explanation:**
- `^` - Start of filename
- `\d{4}` - Exactly 4 digits (0000-9999)
- `_` - Followed by underscore
- Result: Matches `0000_*.sql`, `0001_*.sql`, etc.
- Result: Does NOT match `LOCAL_ADMIN_BOOTSTRAP.sql`

### apply-local-admin-bootstrap.mjs

```javascript
// Separate script for local admin bootstrap
// Only applies LOCAL_ADMIN_BOOTSTRAP.sql
// Does not touch canonical migrations
// Can be run independently after canonical migrations
```

---

## Deployment Paths

### Production Deployment

```bash
# 1. Set production environment
export NODE_ENV=production

# 2. Set required env vars (validated on startup)
export DATABASE_URL="..."
export JWT_SECRET="..."
# ... (other required vars)

# 3. Apply ONLY canonical migrations
node apply-migrations.mjs

# Output:
# ✓ Connected to database
# ℹ️  Production: No local admin bootstrap applied
# Found 14 canonical migration files to apply
# ... (applies 0000 through 0013)
# ✓ Canonical migrations completed successfully
# ℹ️  Production: No local admin bootstrap applied
#    Admin accounts must be created through secure endpoint (future)

# Result: Full schema, no admin account, clean migration journal
```

### Local Development Deployment

```bash
# 1. Apply canonical migrations
node apply-migrations.mjs

# Output:
# ✓ Connected to database
# ℹ️  Development mode: LOCAL_ADMIN_BOOTSTRAP.sql can be applied separately
# Found 14 canonical migration files to apply
# ... (applies 0000 through 0013)
# ✓ Canonical migrations completed successfully
# ℹ️  To bootstrap local admin for development:
#    Option 1: ADMIN_EMAIL=... ADMIN_PASSWORD=... node seed-admin.mjs
#    Option 2: NODE_ENV=development node apply-local-admin-bootstrap.mjs
#    Option 3: Manually run: mysql ... < drizzle/LOCAL_ADMIN_BOOTSTRAP.sql

# 2. Choose ONE admin bootstrap method
node apply-local-admin-bootstrap.mjs

# Output:
# ✓ Connected to database
# ⚠️  Applying LOCAL_ADMIN_BOOTSTRAP.sql (local/dev-only)
# ✓ LOCAL_ADMIN_BOOTSTRAP.sql applied (1 statements, 0 skipped)
# ✅ Local admin bootstrap completed successfully
# Local admin account credentials:
#   Email: admin@ipenovel.com
#   Password: Ipe@novel2026
#   OpenID: admin-ipenovel

# Result: Full schema + local admin account, clean migration journal
```

---

## Migration Journal Verification

### Before Fix (Risk)

```json
{
  "entries": [
    { "idx": 0, "tag": "0000_needy_anthem" },
    { "idx": 1, "tag": "0001_steep_romulus" },
    { "idx": 2, "tag": "0002_goofy_hairball" },
    { "idx": 3, "tag": "0003_flippant_moondragon" },
    // ... 0004 through 0013
    // MISSING: 0003_admin_seed (renamed to 0003_LOCAL_ADMIN_SEED)
    // CONFLICT: Two files with 0003_ prefix
  ]
}
```

### After Fix (Safe)

```json
{
  "entries": [
    { "idx": 0, "tag": "0000_needy_anthem" },
    { "idx": 1, "tag": "0001_steep_romulus" },
    { "idx": 2, "tag": "0002_goofy_hairball" },
    { "idx": 3, "tag": "0003_flippant_moondragon" },
    // ... 0004 through 0013
    // NO CONFLICT: LOCAL_ADMIN_BOOTSTRAP.sql is not numbered
    // NO MISMATCH: 14 entries match 14 canonical migrations
  ]
}
```

---

## Summary

| Aspect | Before (Risk) | After (Safe) |
|--------|---------------|-------------|
| Admin seed file | `0003_admin_seed.sql` | `LOCAL_ADMIN_BOOTSTRAP.sql` |
| Naming conflict | Yes (two 0003_*.sql files) | No (non-numbered file) |
| Migration order | Alphabetical (wrong) | Numbered only (correct) |
| Journal entries | 15 (mismatch) | 14 (correct) |
| Production risk | High (accidental seeding) | None (separate path) |
| Local/dev bootstrap | Automatic (in migrations) | Explicit (separate script) |
| Migration safety | Broken | ✅ Guaranteed |

---

## Conclusion

The new architecture:
- ✅ Eliminates filename conflicts
- ✅ Preserves canonical migration order
- ✅ Keeps migration journal clean
- ✅ Separates production and local/dev paths
- ✅ Makes local admin bootstrap explicit and intentional
- ✅ Safe for fresh setups, existing environments, and production deployment
