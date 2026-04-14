# Local Admin Setup Guide

⚠️ **THIS GUIDE IS FOR LOCAL DEVELOPMENT ONLY**

This document explains how to set up admin accounts for local development and testing. **These methods are NOT used in production deployment.**

---

## Architecture: Canonical vs Bootstrap

### Canonical Migration Path (Production & Development)
```
apply-migrations.mjs
├─ Applies: 0000_needy_anthem.sql
├─ Applies: 0001_steep_romulus.sql
├─ Applies: 0002_goofy_hairball.sql
├─ Applies: 0003_flippant_moondragon.sql
├─ Applies: 0004_blue_rachel_grey.sql
├─ ... (all numbered 0000_*.sql through 0013_*.sql)
└─ SKIPS: LOCAL_ADMIN_BOOTSTRAP.sql (not numbered)
```

**Result:** Full production schema, no admin account

### Local Admin Bootstrap Path (Development Only)
```
apply-local-admin-bootstrap.mjs
└─ Applies: drizzle/LOCAL_ADMIN_BOOTSTRAP.sql
```

**Result:** Creates local admin account (separate from canonical migrations)

---

## Production Deployment

**Production does NOT automatically create admin accounts.** For production:

1. Run canonical migrations: `node apply-migrations.mjs`
2. Result: Full schema, no admin account
3. Admin accounts must be created through a secure bootstrap endpoint (not yet implemented)
4. Admin credentials are never stored in code or migrations

---

## Local Development Setup

### Step 1: Apply Canonical Migrations (Both Dev and Production)

```bash
# Works in both development and production
node apply-migrations.mjs
```

**Output:**
```
✓ Connected to database

ℹ️  Development mode: LOCAL_ADMIN_BOOTSTRAP.sql can be applied separately

Found 14 canonical migration files to apply

Applying drizzle/0000_needy_anthem.sql...
✓ drizzle/0000_needy_anthem.sql applied (X statements, Y skipped)
...
Applying drizzle/0013_bent_quasar.sql...
✓ drizzle/0013_bent_quasar.sql applied (X statements, Y skipped)

✓ Canonical migrations completed successfully

ℹ️  To bootstrap local admin for development:
   Option 1: ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SecurePass123 node seed-admin.mjs
   Option 2: NODE_ENV=development node apply-local-admin-bootstrap.mjs
   Option 3: Manually run: mysql ... < drizzle/LOCAL_ADMIN_BOOTSTRAP.sql
```

### Step 2: Choose One Local Admin Bootstrap Method

#### Option 1: Using seed-admin.mjs (Recommended - Explicit Credentials)

This method requires explicit environment variables, making it safe and intentional.

```bash
# Set environment variables
export ADMIN_EMAIL="admin@example.com"
export ADMIN_PASSWORD="YourSecurePassword123"

# Run the seed script
node seed-admin.mjs
```

**Output:**
```
✅ Local/dev admin account created successfully
  Email: admin@example.com
  Password: (provided via ADMIN_PASSWORD env var)

⚠️  This is a LOCAL/DEV-ONLY account
   Do not use in production

🔒 SECURITY: Store these credentials securely and change password after first login
```

#### Option 2: Using apply-local-admin-bootstrap.mjs (Automatic - Default Credentials)

This method applies the LOCAL_ADMIN_BOOTSTRAP.sql migration with default credentials.

```bash
# Apply local admin bootstrap
node apply-local-admin-bootstrap.mjs
```

**Output:**
```
✓ Connected to database
⚠️  Applying LOCAL_ADMIN_BOOTSTRAP.sql (local/dev-only)

✓ LOCAL_ADMIN_BOOTSTRAP.sql applied (1 statements, 0 skipped)

✅ Local admin bootstrap completed successfully

Local admin account credentials:
  Email: admin@ipenovel.com
  Password: Ipe@novel2026
  OpenID: admin-ipenovel

⚠️  This is a LOCAL/DEV-ONLY account for testing.
   Change password after first login.
   Do not use in production.
```

#### Option 3: Using create-admin.mjs (Quick Testing)

This method creates a test admin account with predictable credentials for quick local testing.

```bash
# Must be in development mode
NODE_ENV=development node create-admin.mjs
```

**Output:**
```
⚠️  Creating LOCAL/DEV-ONLY admin account...
✅ Local/dev admin user created successfully!
OpenID: admin-test-1713099600000
Email: admin@ipenovel.test
Name: Admin User (Local/Dev Only)
Role: admin

⚠️  This is a LOCAL/DEV-ONLY account for testing.
   Do not use in production.
```

#### Option 4: Manual SQL (Advanced)

```bash
# Manually apply the bootstrap SQL
mysql -h localhost -u root -p ipenovel < drizzle/LOCAL_ADMIN_BOOTSTRAP.sql
```

---

## Migration Safety

### Why LOCAL_ADMIN_BOOTSTRAP.sql is Separate

1. **Canonical migrations (0000_*.sql through 0013_*.sql):**
   - Tracked in drizzle migration journal
   - Applied in strict order (0000, 0001, 0002, ...)
   - Safe for production
   - Create the full schema

2. **Local admin bootstrap (LOCAL_ADMIN_BOOTSTRAP.sql):**
   - NOT numbered (no 0000_ prefix)
   - NOT in migration journal
   - NOT applied by default
   - Applied separately for local/dev only
   - Contains only INSERT statements (no schema changes)

### Why This Approach is Safe

- ✅ Canonical migrations are never affected by local admin bootstrap
- ✅ Migration journal stays clean (14 entries, not 15)
- ✅ Fresh production setup: canonical migrations only
- ✅ Fresh local/dev setup: canonical + optional bootstrap
- ✅ Existing environments: no migration journal conflicts
- ✅ No file naming conflicts (0003_LOCAL_ADMIN_SEED.sql vs 0003_flippant_moondragon.sql)

---

## Complete Local Development Setup

```bash
# 1. Apply canonical migrations (schema)
node apply-migrations.mjs

# 2. Choose ONE admin bootstrap method:

# Method A: Default credentials (easiest)
node apply-local-admin-bootstrap.mjs

# OR

# Method B: Custom credentials (more secure)
export ADMIN_EMAIL="myemail@example.com"
export ADMIN_PASSWORD="MySecurePassword123"
node seed-admin.mjs

# 3. Start development server
pnpm dev

# 4. Login with admin account
# Email: admin@ipenovel.com (Method A) or your custom email (Method B)
# Password: Ipe@novel2026 (Method A) or your custom password (Method B)
```

---

## Production Deployment

```bash
# 1. Set production environment
export NODE_ENV=production

# 2. Set all required env vars
export DATABASE_URL="..."
export JWT_SECRET="..."
# ... (other required vars)

# 3. Apply ONLY canonical migrations
node apply-migrations.mjs

# Result: Full schema, no admin account
# Admin must be created through secure endpoint (future)

# 4. Start production server
pnpm build
pnpm start
```

---

## Security Notes

1. **Never commit credentials** - Admin passwords should never be stored in code or git
2. **Use environment variables** - Always provide credentials via env vars, not hardcoded
3. **Change default passwords** - If using LOCAL_ADMIN_BOOTSTRAP.sql, change the password after first login
4. **Production bootstrap** - Production admin accounts must be created through a secure endpoint (future implementation)
5. **Local/dev only** - All bootstrap scripts are for local development only and refuse to run in production (where applicable)

---

## Troubleshooting

### Script refuses to run
```
❌ ERROR: This script is for local development only!
   Do not run in production.
```
**Solution:** Set `NODE_ENV=development` or remove `NODE_ENV=production`

### Admin account already exists
```
Admin account already exists
```
**Solution:** This is normal if you've already created the admin account. You can delete the user from the database and try again.

### Database connection failed
```
Failed to connect to database
```
**Solution:** Ensure `DATABASE_URL` environment variable is set correctly and the database is running.

### Migration journal mismatch
```
Migration tracking table not found (expected for fresh setup)
```
**Solution:** This is normal for fresh setups. The migration journal will be created automatically.

---

## Summary

| Method | Environment | Credentials | Use Case | Safety |
|--------|-------------|-------------|----------|--------|
| `apply-migrations.mjs` | Any | None (schema only) | Apply canonical schema | ✅ Safe for production |
| `apply-local-admin-bootstrap.mjs` | Dev only | Hardcoded default | Quick local testing | ✅ Separate from canonical |
| `seed-admin.mjs` | Any | Explicit env vars | Intentional admin creation | ✅ Explicit credentials |
| `create-admin.mjs` | Dev only | Hardcoded test | Quick local testing | ✅ Dev-only guard |

**Remember:** 
- Canonical migrations (0000_*.sql - 0013_*.sql) are always applied
- Local admin bootstrap (LOCAL_ADMIN_BOOTSTRAP.sql) is always separate
- Production deployment does not depend on any bootstrap scripts
- All local admin setup methods are for development only
