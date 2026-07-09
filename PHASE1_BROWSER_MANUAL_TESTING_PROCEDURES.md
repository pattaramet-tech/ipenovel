# Phase 1 Browser Manual Testing Procedures — Hybrid Safety Tools

Manual browser testing checklist for the `phase1-hybrid-safety-tools`
branch. Written as a companion to `PHASE1_API_VERIFICATION_SCRIPTS.md`
(curl/jq-level checks) and `server/hybrid-access-regression.test.ts`
(automated source of truth) — this document is for a human clicking
through the actual UI in a browser.

**Ground rules for every gate below:**

- Never set `fileUrl = null` on any episode, never delete a legacy
  `fileUrl`, never edit any data as part of "testing" — every gate here is
  either read-only or, where noted, a database *write* that is limited to
  non-financial, non-entitlement data (see Gate 3, Option B).
- Do not touch payment / orders / wallet / OCR / coupons / sports votes
  flows beyond opening the page and looking at it (see Gate 7).
- Do not merge to `main`. Do not deploy production.

---

## Gate 1 — Unpurchased User: Metadata Flags Are Not Leakage

**Purpose:** confirm that `novels.episodes` may describe an episode's
*data* (via `hasContent` / `hasLegacyFile`) to a user who hasn't purchased
it, without ever handing that user the actual content or file link.

**Steps:**
1. Log in as a user account that has **not** purchased any episode of the
   target novel.
2. Open the novel's detail page (`/novels/:id`).
3. Open browser devtools → Network tab, find the `novels.episodes` tRPC
   call, inspect the response for each episode.

**Expected output** (any episode, purchased or not, from this user's POV):

```json
{
  "id": 12345,
  "hasContent": true,
  "hasLegacyFile": false,
  "canRead": false,
  "hasPurchased": false,
  "isPurchased": false,
  "fileUrl": null,
  "content": null
}
```

**Do NOT treat as a bug / do NOT report as leakage:**
- `hasContent: true` — this only says the episode *has* plaintext content
  in the database. It describes the episode, not this user's access.
- `hasLegacyFile: true` — same idea, for the legacy `fileUrl` column.

**DO treat as a P0 leak and stop testing immediately:**
- `content` has any non-null / non-empty value for this user.
- `fileUrl` has any non-null value for this user.

Real leakage is a **value** appearing where the user has no access —
never the presence of a boolean describing the episode itself.

---

## Gate 2 — Purchased User: `fileUrl` Legacy-Access Rule (corrected)

**Purpose:** confirm the corrected hybrid-access rule for purchased users:
`novels.episodes` never sends full content, but it *may* send `fileUrl`
when the user has actually paid for a legacy-file episode — that's what
lets the "เปิดไฟล์เดิม" (open legacy file) button work directly from the
episode list, without a separate `reader.getEpisode` round-trip.

**Corrected rule (replaces any earlier version of this document that said
purchased users always get `fileUrl: null`):**

- `novels.episodes` must **never** send full `content` — not for any user,
  purchased or not.
- `novels.episodes` **may** send `fileUrl`, but only when **both**:
  - `hasLegacyFile === true` (the episode actually has a legacy file), and
  - `canRead === true` (this specific user has purchased it, or it's free).
- An unpurchased user must **never** see a non-null `fileUrl`, regardless
  of `hasLegacyFile`.
- `content` is never sent by `novels.episodes` under any condition —
  purchased or not, `hasContent` true or false. Full content only ever
  comes from `reader.getEpisode`.

**Steps — repeat for three fixture episodes** (see
`server/hybrid-access-regression.test.ts` Cases A/B/C for how to seed
these, or use existing legacy data):

**2a. Purchased user, episode has legacy `fileUrl` only (Case A):**
```json
{
  "hasContent": false,
  "hasLegacyFile": true,
  "canRead": true,
  "hasPurchased": true,
  "fileUrl": "https://docs.google.com/document/d/...",
  "content": null
}
```
✅ `fileUrl` is real here — this is the one case where `novels.episodes`
legitimately hands back a working URL. Confirm the "เปิดไฟล์เดิม" button
renders and opens it.

**2b. Purchased user, episode has plaintext content only (Case B):**
```json
{
  "hasContent": true,
  "hasLegacyFile": false,
  "canRead": true,
  "hasPurchased": true,
  "fileUrl": null,
  "content": null
}
```
✅ `content` stays `null` even though the user purchased it and the
episode has content — confirm the "อ่านในเว็บ" button appears (driven by
`hasContent`, not by an actual content string being present here) and that
clicking it navigates to `/read/:episodeId` where `reader.getEpisode`
supplies the real text.

**2c. Purchased user, hybrid episode (both fileUrl and content, Case C):**
```json
{
  "hasContent": true,
  "hasLegacyFile": true,
  "canRead": true,
  "hasPurchased": true,
  "fileUrl": "https://docs.google.com/document/d/...",
  "content": null
}
```
✅ Both buttons ("อ่านในเว็บ" and "เปิดไฟล์เดิม") should render on the
package card; `fileUrl` is real, `content` is still `null`.

**Critical checks:**
- [ ] `content` is `null`/absent in all three cases above, including 2c
      where the episode genuinely has content.
- [ ] `fileUrl` is only ever real in 2a/2c (`hasLegacyFile: true` +
      `canRead: true`) — never in 2b.
- [ ] Re-run Gate 1 against the *same* three episodes as an unpurchased
      user and confirm `fileUrl` is `null` in all three, even 2a/2c.

---

## Gate 3 — Reader Progress (save/restore)

Reading progress (`readingProgress` table: `progressPercent`,
`scrollPosition`, `currentChapterNumber`, `anchorKey`, `lastReadAt`) is a
resume-position cache, not an entitlement or financial record — but it is
still a database write, so pick one mode depending on how strict this
testing pass needs to be.

### Option A — Strict read-only mode (default, recommended)
- Open the Reader page (`/read/:episodeId`) for an episode you have access
  to. Verify UI layout, header, font/theme controls, and the Table of
  Contents drawer render correctly (see
  `PHASE1_MOBILE_READER_LAYOUT` work if it exists, or just the current
  `ReaderPage.tsx`/`ReaderPage.module.css`).
- Do **not** scroll far enough to trigger a progress autosave, and do not
  click "อ่านต่อ" / any resume action.
- This mode is 100% compatible with No-New-Data Mode (Gate 7) — zero
  writes anywhere.

### Option B — Progress test mode (only if explicitly asked for)
- Scroll through the reader content far enough to trigger the debounced
  progress save (see `SCROLL_SAVE_DEBOUNCE_MS` in `ReaderPage.tsx`), or use
  the Table of Contents to jump to a chapter.
- **You must report clearly that this mode writes to the `readingProgress`
  table** for the test account used.
- This write is **not** to be counted as "data creation" under Gate 7's
  No-New-Data Mode — it does not touch `orders`, `purchases`,
  `episodePurchases`, `payments`, `walletAccounts`, `coupons`, or
  `sportsVotes`. It only ever touches one row keyed on
  `(userId, episodeId)` in `readingProgress`.
- Still forbidden even in Option B: attempting to purchase, checkout, or
  otherwise gain access to an episode you don't already have rights to,
  purely to "test" reading progress on it.

---

## Gate 4 — ZIP Import Preview Diff (Admin, dry-run only)

**Purpose:** confirm the admin ZIP import preview (`/admin/import-episodes`
→ "Import Package ZIP" section) shows an accurate diff **without writing
anything to the database**.

**Steps:**
1. Log in as an admin.
2. Go to `/admin/import-episodes`, switch to the ZIP import tab.
3. Upload a small test ZIP (manifest.csv/xlsx + a couple of `.txt` content
   files — see `server/zip-import-preview-diff.test.ts` for a minimal
   fixture shape).
4. Confirm import mode defaults to **Sync/Upsert** (recommended), with
   Create-only available as the secondary option.
5. Click "ตรวจสอบไฟล์ (Preview)" — **do not** click the confirm/"Import"
   button in this gate.

**Expected:**
- [ ] Preview table shows one row per manifest row, each with: row #, raw
      episodeNumber, normalized range, title, matched episodeId (if any),
      `currentFileUrlExists`, `incomingContentExists`, action
      (`update_existing` / `create_new` / `error_*`), `preserveFileUrl`,
      and a human-readable message.
- [ ] Summary counters (total / update / create / error / preserved
      fileUrl / duplicate range / ambiguous match / missing content file)
      match what the row-level table shows.
- [ ] After leaving the preview open (no confirm click), reload
      `/admin/episodes/:novelId` (or the health dashboard, Gate 5) and
      confirm the episode list for that novel is **byte-identical** to
      before the preview — nothing was created or updated.

**This gate stops at the preview step.** Actually confirming an import
(clicking through to a real write) is out of scope for a No-New-Data Mode
pass — if you need to test the real write path, do it in a separate,
explicitly-labeled non-read-only session and say so in your report.

---

## Gate 5 — Hybrid Content Health Dashboard (Admin, read-only)

**Purpose:** confirm `/admin/hybrid-health` loads correctly and has zero
mutation controls.

**Steps:**
1. Log in as admin, go to `/admin/hybrid-health`.
2. Confirm the overview table loads with per-novel counts (total episodes,
   content count, legacy file count, hybrid count, missing-both count,
   package/chapter counts, duplicate normalized range count, risky episode
   count).
3. Click "รายละเอียด" on any novel row, confirm the detail table loads with
   per-episode flags and warnings.

**Expected / critical checks:**
- [ ] No edit, save, delete, or "fix" button anywhere on this page — it is
      diagnostic only.
- [ ] Warnings render as plain text/badges, never as an actionable control.
- [ ] Navigating back and forth between overview and detail does not
      change any counts (confirms nothing was written as a side effect of
      viewing).

---

## Gate 6 — Admin User Entitlement Lookup (Admin, read-only)

**Purpose:** confirm `/admin/entitlement-lookup` can look up a user's
purchases/entitlements without exposing a raw legacy `fileUrl` and without
any control that changes the user's access.

**Steps:**
1. Log in as admin, go to `/admin/entitlement-lookup`.
2. Search by email for a known test user; if ambiguous (multiple matches),
   confirm the candidate list appears instead of guessing.
3. Inspect the Orders table and Purchased Episodes table for that user.
4. Click the "copy debug report" button on one purchased episode row and
   paste the clipboard contents somewhere to inspect them.

**Expected / critical checks:**
- [ ] The purchased-episodes table shows `hasLegacyFile` as a "มีไฟล์
      (sensitive)" badge — never the raw Google Docs/PDF URL as visible
      text anywhere on the page.
- [ ] The copied debug report contains exactly: `userId`, `novelId`,
      `episodeId`, `canRead`, `hasContent`, `hasLegacyFile`,
      `fileUrlVisible`, and progress state — and does **not** contain a
      raw URL string.
- [ ] No button on this page grants, revokes, or repairs an entitlement
      (that's the separate, pre-existing `/admin/entitlements` repair
      tool, out of scope for this read-only lookup page).

---

## Gate 7 — No-New-Data Mode Regression Smoke Test

**Purpose:** confirm the rest of the app still loads correctly after the
Phase 1 changes, without creating or mutating any data anywhere outside
what Gate 3 Option B explicitly allows.

**Forbidden in this gate — do not perform any of these:**
- Add an episode/package to cart.
- Checkout / place an order.
- Create an order of any kind.
- Create a wallet top-up or submit a payment slip.
- Approve or reject a payment (admin).
- Cast a vote on Sports Votes.
- Any action that writes to `orders`, `purchases`, `episodePurchases`,
  `payments`, `walletAccounts`, `walletTransactions`, `coupons`,
  `couponUsage`, or `sportsVotes`.

**Steps — open each page and confirm it loads without error; do nothing
else:**
- [ ] Home (`/`) — loads, banners/sections render.
- [ ] Catalog (`/novels`) — loads, list/search/filter render.
- [ ] Novel detail (`/novels/:id`) — loads, episode list renders with
      correct metadata (cross-check against Gates 1–2 while you're there).
- [ ] Cart page (`/cart`) — loads, view only, do not add/remove items.
- [ ] Orders page (`/orders`) — loads, view only, do not create an order.
- [ ] Wallet page (`/wallet`) — loads, view only, do not top up.
- [ ] Payment/OCR admin page (`/admin/payments`) — loads, view only, do
      not approve/reject anything.
- [ ] Coupons page (`/admin/coupons`) — loads, view only, do not
      create/edit/delete a coupon.
- [ ] Sports Votes page (`/sports-votes`) — loads, view only, do not cast
      a vote.

**Expected:** every page above loads without a console error or a blank
screen, and no data anywhere in the app changed as a result of this pass
(diff the row counts in Gate 5's dashboard before/after if you want a
concrete before/after check).

---

## Sign-off Checklist

| Gate | Area | Read-only? | Status |
|---|---|---|---|
| 1 | Unpurchased metadata flags | Yes | ☐ |
| 2 | Purchased fileUrl rule | Yes | ☐ |
| 3 | Reader progress | Yes (Option A) / DB write limited to `readingProgress` (Option B) | ☐ |
| 4 | ZIP import preview diff | Yes (stops before confirm) | ☐ |
| 5 | Hybrid content health dashboard | Yes | ☐ |
| 6 | Admin entitlement lookup | Yes | ☐ |
| 7 | App-wide smoke test | Yes | ☐ |

If every box above is checked with no P0 leaks found (per Gate 1/2's
definition of real leakage), this branch is ready for the next review
step — still not a production deploy on its own.
