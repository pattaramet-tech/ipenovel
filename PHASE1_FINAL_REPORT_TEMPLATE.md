# Phase 1 Final Report — Hybrid Safety Tools

Fill-in report template for summarizing a full pass through
`PHASE1_BROWSER_MANUAL_TESTING_PROCEDURES.md` (browser Gates 1–7) and
`PHASE1_API_VERIFICATION_SCRIPTS.md` (curl/jq-level checks) against the
`phase1-hybrid-safety-tools` branch. This document itself contains no test
results yet — copy it per test pass and fill in the blanks.

---

## Project Information

- **Project:** ipenovel-v2 / Ipe นิยายแปล
- **Repo:** pattaramet-tech/ipenovel-v2
- **Branch:** phase1-hybrid-safety-tools
- **HEAD:**
  - **App-code commit:** `e6d9cda` — "Add hybrid safety tools and import preview diff" (this is the commit that actually changed application behavior — `readerService.ts`, `packageZipImportService.ts`, `routers.ts`, the two new admin pages, and the two new automated test files).
  - **Documentation / latest testing rules commit:** `9a8ea2a` — "Fix Phase 1 browser manual testing rules" (documentation-only; corrected the manual browser testing procedures, no application code changed since the app-code commit above).
- **Report filled out by:** _____________________
- **Date:** _____________________
- **Environment tested:** _____________________ (local dev server / Manus preview URL / other)

---

## How to Use This Template

1. Work through each gate below in order, following the corresponding gate
   in `PHASE1_BROWSER_MANUAL_TESTING_PROCEDURES.md` for exact steps.
2. Fill in the "Actual Results" table for each gate.
3. Mark a gate **FAIL** if — and only if — one of its listed **Critical
   Issues** is actually observed. A metadata flag being `true`/`false` is
   never on its own a critical issue (see Gate 1 and Gate 2 below).
4. Fill in the Overall Summary and Sign-off sections at the end.

---

## Gate 1 — Unpurchased User Metadata Flags

### Expected Results
- `hasContent` and `hasLegacyFile` are metadata describing the episode
  itself and are returned for every user, purchased or not.
- `canRead` / `hasPurchased` / `isPurchased` are `false` for an
  unpurchased user.
- `fileUrl` and `content` are `null`/absent for an unpurchased user,
  regardless of what `hasContent`/`hasLegacyFile` say.

### Critical Issues
- Unpurchased user receives a non-null `fileUrl`.
- Unpurchased user receives a non-null/non-empty `content`.

*(`hasContent: true` or `hasLegacyFile: true` for an unpurchased user is
**not** a critical issue — do not report it as one.)*

### Actual Results

| Episode case | hasContent | hasLegacyFile | canRead | fileUrl received? | content received? | Pass/Fail |
|---|---|---|---|---|---|---|
| Legacy-file only |  |  |  |  |  |  |
| Plaintext only |  |  |  |  |  |  |
| Hybrid (both) |  |  |  |  |  |  |

**Gate 1 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 2 — Purchased User `fileUrl` Rule

### Expected Results
- `novels.episodes` must never return full `content` — for any user,
  purchased or not.
- `novels.episodes` may return `fileUrl` **only** for purchased users,
  and only when **both** `hasLegacyFile === true` and `canRead === true`.
- Unpurchased users must never receive `fileUrl`, under any condition.
- `hasContent` / `hasLegacyFile` / `canRead` are metadata flags and are
  allowed to be `true` for any user — their presence is not a leak.

### Critical Issues
- `novels.episodes` exposes full `content`.
- Unpurchased user receives `fileUrl`.
- Unpurchased user receives `content`.
- Purchased legacy-file user **cannot** open the legacy file (i.e.
  `hasLegacyFile=true` + `canRead=true` but `fileUrl` is missing/null,
  breaking the "เปิดไฟล์เดิม" button).
- Purchased plaintext user **cannot** read the content (i.e.
  `hasContent=true` + `canRead=true` but `reader.getEpisode` fails to
  return the text, breaking the "อ่านในเว็บ" flow).

### Actual Results

| Episode case | hasContent | hasLegacyFile | canRead | content returned? | fileUrl visible only when hasLegacyFile=true and canRead=true? | fileUrl hidden from unpurchased user? | Pass/Fail |
|---|---|---|---|---|---|---|---|
| Purchased, legacy-file only |  |  |  |  |  |  |  |
| Purchased, plaintext only |  |  |  |  |  |  |  |
| Purchased, hybrid (both) |  |  |  |  |  |  |  |
| Unpurchased, legacy-file only |  |  |  |  |  |  |  |
| Unpurchased, plaintext only |  |  |  |  |  |  |  |
| Unpurchased, hybrid (both) |  |  |  |  |  |  |  |

**Gate 2 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 3 — Reader Progress

### Expected Results
- **Option A (strict read-only):** Reader UI/TOC/layout render correctly;
  no progress save/restore is exercised; zero database writes.
- **Option B (progress test mode):** progress save/restore works
  correctly; a write to `readingProgress` for the test account is expected
  and must be explicitly disclosed — it does not count as data creation
  affecting money, orders, or purchases.

### Critical Issues
- Reader UI fails to render content the user has access to.
- (Option B only) A write occurs anywhere **other than** the
  `readingProgress` row for `(userId, episodeId)` — e.g. any change to
  `orders`, `purchases`, `episodePurchases`, `payments`, or
  `walletAccounts`.

### Actual Results

- Mode used: ☐ Option A (strict read-only) ☐ Option B (progress test mode)
- If Option B, DB write disclosed: ☐ yes, `readingProgress` only ☐ other table touched (describe): _____________________

**Gate 3 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 4 — ZIP Import Preview Diff

### Expected Results
- Default import mode is Sync/Upsert.
- Preview (dry run) shows an accurate per-row diff (action, matched
  episodeId, `preserveFileUrl`, etc.) without writing to the database.
- Summary counters match the row-level table.

### Critical Issues
- Preview writes to the database (episode list changes without clicking
  the confirm/import button).
- Preview shows `action: create_new` for a row that actually matches an
  existing episode by normalized range.
- Preview loses/nulls an existing `fileUrl` in its `preserveFileUrl`
  column for a row that should preserve it.

### Actual Results

| Check | Result |
|---|---|
| Preview loaded without error | ☐ yes ☐ no |
| Episode list unchanged after preview (no confirm clicked) | ☐ yes ☐ no |
| Summary counters match row table | ☐ yes ☐ no |

**Gate 4 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 5 — Hybrid Content Health Dashboard

### Expected Results
- Overview and per-novel detail views load with accurate counts/warnings.
- Page is fully read-only — no edit/save/delete controls anywhere.

### Critical Issues
- Any control on this page mutates data.
- Counts visibly change just from viewing (indicates a hidden write).

### Actual Results

| Check | Result |
|---|---|
| Overview loads | ☐ yes ☐ no |
| Detail view loads | ☐ yes ☐ no |
| No mutation controls present | ☐ yes ☐ no |

**Gate 5 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 6 — Admin User Entitlement Lookup

### Expected Results
- Search by email/userId/orderId works and is read-only.
- Raw legacy `fileUrl` is never shown as visible text; only a
  `hasLegacyFile`/`fileUrlVisible` indicator.
- Copy-debug-report output matches the documented field set exactly.

### Critical Issues
- Raw `fileUrl` string appears anywhere on the page or in the copied
  report.
- Any control grants/revokes/repairs an entitlement from this page.

### Actual Results

| Check | Result |
|---|---|
| Search works (email/userId/orderId) | ☐ yes ☐ no |
| Raw fileUrl never shown | ☐ yes ☐ no |
| Copy report field set matches spec | ☐ yes ☐ no |

**Gate 6 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Gate 7 — No-New-Data Mode Regression Smoke Test

### Expected Results
All pages load without error; nothing is created, mutated, or purchased.

### Critical Issues
- Any page fails to load / shows a console error / blank screen.
- Any data is created or changed under the "view only" pages (cart,
  orders, wallet, payments, coupons, sports votes).

### Actual Results

| Page | Loads OK? |
|---|---|
| Home (`/`) | ☐ yes ☐ no |
| Catalog (`/novels`) | ☐ yes ☐ no |
| Novel detail (`/novels/:id`) | ☐ yes ☐ no |
| Cart (`/cart`) | ☐ yes ☐ no |
| Orders (`/orders`) | ☐ yes ☐ no |
| Wallet (`/wallet`) | ☐ yes ☐ no |
| Payment/OCR admin (`/admin/payments`) | ☐ yes ☐ no |
| Coupons (`/admin/coupons`) | ☐ yes ☐ no |
| Sports Votes (`/sports-votes`) | ☐ yes ☐ no |

**Gate 7 status:** ☐ PASS ☐ FAIL — notes: _____________________

---

## Overall Summary

- **Gates passed:** _____ / 7
- **Blocking (critical) issues found:** _____________________
- **Ready for next review step:** ☐ yes ☐ no
- **Ready for production deploy:** this template alone never authorizes a
  production deploy — that decision is separate and out of scope here.

## Sign-off

- **Tested by:** _____________________
- **Reviewed by:** _____________________
- **Date:** _____________________
