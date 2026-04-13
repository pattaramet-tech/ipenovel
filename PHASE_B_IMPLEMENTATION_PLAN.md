# Phase B: Implementation Plan for Remaining 6 Blockers

**Date:** April 13, 2026  
**Status:** In Progress  
**Local Admin:** Preserved for dev/local use only

---

## Blocker 1: Episode Upload Architecture

**Current State:** Uses base64-over-JSON (unsafe for large files)

**Fix:**
- Replace with multipart/form-data upload
- Keep file validation (size, type)
- Maintain admin workflow
- Add progress tracking

**Files to Change:**
- `server/routes/uploadRoute.ts` - Switch to multipart
- `client/src/pages/AdminEpisodeUploadPage.tsx` - Use FormData
- `server/routers.ts` - Update upload procedure

**Validation:**
- Large files (50MB+) must work
- Invalid types must fail
- Oversized must fail cleanly

---

## Blocker 2: Migration Reliability

**Current State:** apply-migrations.mjs auto-discovers all 15

**Fix:**
- Verify all 15 migrations apply on fresh DB
- Document canonical deployment command
- Remove any partial migration path
- Add migration status reporting

**Files to Change:**
- `apply-migrations.mjs` - Add status reporting
- `DEPLOYMENT.md` - Document canonical command
- `package.json` - Add migration script

**Validation:**
- Fresh DB reaches latest schema
- Existing DB remains compatible
- No partial migration remains

---

## Blocker 3: Frontend Navigation Links

**Current State:** All /login links fixed, need to audit for dead links

**Fix:**
- Audit all navigation links
- Remove dead routes
- Verify logout flow
- Check admin navigation

**Files to Change:**
- `client/src/App.tsx` - Verify routes exist
- `client/src/components/DashboardLayout.tsx` - Check nav links
- All page files - Remove dead links

**Validation:**
- No 404 on any navigation link
- Logout works correctly
- Admin nav is correct

---

## Blocker 4: Health/Readiness Endpoints

**Current State:** Already implemented in server/_core/index.ts

**Fix:**
- Verify endpoints work correctly
- Test with curl
- Document response format
- Add to deployment checklist

**Files to Change:**
- `server/_core/healthCheck.ts` - Verify implementation
- `DEPLOYMENT.md` - Document endpoints

**Validation:**
- GET /health returns 200 when healthy
- GET /readiness returns 200 when ready
- Both return JSON with status

---

## Blocker 5: Wallet/Payment Insert Brittleness

**Current State:** Uses result[0].insertId (brittle)

**Fix:**
- Add defensive result handling
- Check for insertId existence
- Use safer extraction pattern
- Add error handling

**Files to Change:**
- `server/db.ts` - Defensive wallet insert
- `server/services/walletService.ts` - Safe result handling
- `server/routers.ts` - Error handling in procedures

**Validation:**
- Wallet creation succeeds
- Payment creation succeeds
- Errors handled gracefully

---

## Blocker 6: Upload Security

**Current State:** Partially hardened

**Fix:**
- Require authentication
- Validate magic bytes
- Sanitize filenames
- Check file size
- Audit for bypass paths

**Files to Change:**
- `server/routes/uploadRoute.ts` - Add auth + validation
- `server/_core/index.ts` - Auth middleware
- `server/services/uploadService.ts` - Magic-byte check

**Validation:**
- Unauthorized uploads rejected (401)
- Invalid files rejected (400)
- Valid files accepted (200)
- No bypass path exists

---

## Blocker 7: Dead Code Cleanup

**Current State:** Obsolete implementations may exist

**Fix:**
- Remove old download implementations
- Remove obsolete upload paths
- Remove dead auth paths
- Remove old startup logic

**Files to Change:**
- Multiple files - Remove dead code
- `server/routers.ts` - Remove obsolete procedures
- `client/src/pages/` - Remove dead pages

**Validation:**
- Build succeeds
- No unused imports
- No dead routes

---

## Blocker 8: Regression Tests

**Current State:** 14 test suites added (placeholder assertions)

**Fix:**
- Replace with real tests
- Test secure download flow
- Test unauthorized access rejection
- Test upload validation
- Test OAuth session
- Test wallet insert
- Test health/readiness

**Files to Change:**
- `server/blockers-regression.test.ts` - Real tests
- `server/upload.test.ts` - Upload tests
- `server/download.test.ts` - Download tests

**Validation:**
- All tests pass
- No placeholder assertions
- Real behavior verified

---

## Local Admin Preservation

**Important:** Local Admin is preserved for local/dev use only

**Current Setup:**
- seed-admin.mjs requires ADMIN_EMAIL and ADMIN_PASSWORD env vars
- Script fails if credentials not provided
- Clear comments about local-only use
- Not treated as production default

**What We Keep:**
- Local admin seeding for development
- Admin dashboard for testing
- Admin procedures for testing

**What We Ensure:**
- Production does not depend on local admin defaults
- No hardcoded credentials in code
- Clear documentation about local-only use

---

## Implementation Order

1. Fix episode upload architecture (multipart)
2. Verify migration reliability
3. Audit and fix frontend navigation
4. Verify health/readiness endpoints
5. Fix wallet/payment insert brittleness
6. Strengthen upload security
7. Clean up dead code
8. Add real regression tests
9. Run full verification (typecheck, build, tests)
10. Generate final deliverables

---

## Success Criteria

- ✅ All 14 blockers addressed
- ✅ Build passes
- ✅ TypeScript passes (or pre-existing errors only)
- ✅ Tests pass
- ✅ Local Admin works for dev
- ✅ Production is safe and stable
