# VPS Migration Runbook — Manus/Cloud → VPS (Coolify + MariaDB)

**Status: Phase 0 (Production Readiness Audit). No infrastructure has been provisioned and no data has moved.** This document is a plan, not a record of completed work.

Audited at repo HEAD `da3a65e16b51ed7e81cead6fd3559e444fd3a814` (origin/main), which includes PR #23 (merge commit `3c70afbde87d12fd494e3331a8c4d9e1c555259b`).

Priority order for this migration, per the current cloud-credit deadline: **(1) data recoverability, (2) financial/entitlement correctness, (3) VPS deploy, (4) rollback** — all ahead of any new feature work. Nothing in this document adds, removes, or changes business logic, payment/wallet/purchase logic, auth (MFA/password reset/session management), or schema.

---

## 1. Current architecture

- **Hosting**: Manus/Cloud (proxy sets `X-Forwarded-Proto`/`X-Forwarded-For`; `server/_core/index.ts` does `app.set("trust proxy", 1)` assuming exactly one hop).
- **Database**: TiDB (TiDB Cloud, confirmed v8.5.3 per `server/migration-0024-content-downgrade.integration.test.ts:26-28`), accessed via `mysql2`/Drizzle with `dialect: "mysql"` — TiDB speaks the MySQL wire protocol, so the app has always run against a "MySQL-compatible" server rather than true MySQL.
- **App process**: a single Node.js process. `pnpm build` runs `vite build` (client SPA) then `esbuild` bundles `server/_core/index.ts` → `dist/index.js` (ESM, `--packages=external`, so `node_modules` must exist alongside `dist/` at runtime). `pnpm start` runs `NODE_ENV=production node dist/index.js`, which self-triggers Drizzle migrations on boot (see §9) before opening the HTTP port.
- **File storage**: Cloudflare R2, two separate buckets — a public bucket (novel covers, banners) and a private bucket (payment slips, paid episode files, accessed only via short-lived presigned URLs). A legacy Manus storage proxy (`BUILT_IN_FORGE_API_URL`/`KEY`) is still used for two things: sports-match images and AI-generated images.
- **Auth**: Manus's own OAuth service (`OAUTH_SERVER_URL`/`VITE_OAUTH_PORTAL_URL`/`VITE_APP_ID`) for regular users, plus a separate local email/password admin login (`admin.login`, unaffected by Manus OAuth) that already runs entirely against this app's own database and `JWT_SECRET`-signed session cookies.
- **OCR/LLM**: Manus's "Forge" platform (Gemini-backed), used for payment-slip OCR, AI image generation, and other LLM-backed features.
- **No email feature exists.** No payment-gateway API integration exists — payment is Manus-independent manual bank-transfer + OCR-assisted review, already fully in this app's own code.
- **No existing Dockerfile, docker-compose, or Coolify config** anywhere in the repo — this migration starts from zero deployment manifests.

## 2. Target architecture

- **Hosting**: a VPS running Coolify, deploying this repo's `main` branch via Coolify's GitHub integration (build pack/Dockerfile TBD at provisioning time — see §3).
- **Database**: self-hosted MariaDB, reachable only over Coolify's internal Docker network (never a public port — see §12 firewall baseline). `DATABASE_URL` changes; no schema/migration changes are made as part of this move (see the Database Compatibility Audit, §9, for what needs live verification before cutover).
- **App process**: unchanged build/start commands (`pnpm build` / `pnpm start`) — Coolify just needs a Dockerfile/Nixpacks config that runs them, plus an `.env` populated per `docs/VPS_ENVIRONMENT_INVENTORY.md`.
- **File storage**: R2 stays R2 — it's already host-agnostic (S3-compatible API over the public internet), so no data needs to move for covers/banners/slips/episode files. The one storage dependency that *does* need attention is the legacy Manus proxy for sports-match/AI-generated images (see §13 known limitations).
- **Auth**: unchanged mechanism, but **contingent on Manus continuing to serve `OAUTH_SERVER_URL`/`VITE_OAUTH_PORTAL_URL` for a non-Manus-hosted app** — this is an external dependency this migration does not control (see §13). Local admin login is unaffected either way.
- **OCR/LLM**: same contingency as auth — `BUILT_IN_FORGE_API_URL`/`KEY` must keep working after leaving Manus hosting, or OCR/image-generation/notifications need a replacement provider (out of scope for this PR; flagged as a blocking *dependency to verify*, not a blocking *code change*).

## 3. GitHub → Coolify deployment

Coolify is pointed at this repository's `main` branch (never a feature branch) for production deploys. Concretely, in Coolify's UI:

1. **New Resource → Application → Public/Private Git Repository**, `https://github.com/pattaramet-tech/ipenovel`, branch `main`.
2. **Build pack**: since there's no existing `Dockerfile`, the simplest correct choice is Coolify's **Nixpacks** auto-detection (it detects `package.json`, runs `pnpm install`, then needs an explicit build/start command override — see below) *or* a minimal hand-written `Dockerfile` added in a **separate, later PR** (out of scope here — this PR is docs/scripts only, no `Dockerfile` is added). Either choice must end up running exactly `pnpm build` then `pnpm start` — see §5 (Coolify deployment plan) for the full non-secret settings table.
3. **Auto-deploy on push to `main`**: enable Coolify's webhook so a merge to `main` (i.e. an approved, merged PR — never a direct push) triggers a new build automatically. This does **not** change this repo's existing rule that `main` is only ever updated via merged PRs.
4. **Health check**: Coolify needs an HTTP health-check path to know a deploy succeeded before routing traffic to it. **`getHealthStatus()`/`getReadinessStatus()` already exist in `server/_core/healthCheck.ts` but are not wired to any HTTP route today** (confirmed: no `app.get("/health"...)` registration anywhere in `server/_core/index.ts`). Wiring one of these functions to a real route (e.g. `GET /healthz`) is a **required follow-up code change**, but it is a small, additive, non-business-logic change — deliberately **not made in this PR** (this PR is audit/docs/scripts only, per its explicit scope). Track it as a blocking pre-cutover TODO in `docs/VPS_MIGRATION_CHECKLIST.md`'s P1 section.
5. **Zero-downtime**: Coolify's default rolling/recreate deploy strategy should be selected explicitly (see §5) rather than assumed — verify during the staging rehearsal (§4), not left to defaults.

## 4. MariaDB private network

- Provision a MariaDB service **inside Coolify** (its own "Database" resource type, or a Docker Compose service on the same Coolify-managed network as the app) so the app reaches it over the internal Docker network hostname — **never** by exposing MariaDB's port 3306 publicly (see §12).
- `DATABASE_URL` on the VPS points at that internal hostname (something like `mysql://user:pass@<coolify-internal-service-name>:3306/ipenovel`) — a private, Coolify-generated DNS name, not a public IP.
- The app's production DB connection (`server/db.ts`'s `getDb()`) sets **no explicit TLS options of its own** — it inherits whatever's in the `DATABASE_URL` query string. The current production string almost certainly has TLS parameters assumed for TiDB Cloud's public, TLS-required endpoint; when constructing the new internal `DATABASE_URL`, those should be dropped for a plaintext internal-network connection (test helpers already have a documented, narrowly-scoped precedent for this exact "Coolify-internal MariaDB, no TLS" case — see `server/test-helpers/testDbConnectionOptions.ts:88-171` — but that logic covers only the **test** connection path, not production; production simply needs the URL's query string to omit `ssl=...`, no code change required).
- Provision the MariaDB database and user with `utf8mb4` as the connection/database default explicitly (see §9 — nothing in the schema pins charset itself, so this must be set at provisioning time, not assumed).

## 5. R2 / external services

No data migration needed for R2 (already host-agnostic) — just carry every `R2_*`/`R2_PRIVATE_*` variable from `docs/VPS_ENVIRONMENT_INVENTORY.md` into the VPS `.env` unchanged. Two things that *do* need action before/around cutover, both **outside this PR's scope** (config/coordination, not code):

- Confirm with whoever administers the Manus "Forge" platform account whether `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` continue to function once the app is no longer hosted on Manus. If not, OCR, AI image generation, notifications, and voice transcription all break simultaneously (they share this one credential pair) until replaced.
- Confirm with whoever administers the Manus OAuth app (`VITE_APP_ID`) whether the OAuth provider needs the new VPS domain registered as an allowed redirect target. The app itself computes the redirect URI dynamically from `window.location.origin` (no hardcoded domain in code), but OAuth providers typically allowlist redirect URIs server-side — this can only be checked/configured on Manus's side, not in this repo.

## 6. Staging rehearsal

Before touching production, rehearse the entire cutover procedure (§8/§ F below) end-to-end against a **disposable** staging VPS/Coolify instance and a **disposable** MariaDB loaded from a real (but non-production-credentialed) snapshot:

1. Provision a throwaway Coolify app + MariaDB exactly per §3–§4.
2. Populate `.env` with staging-safe values (a **separate** `JWT_SECRET`, a **separate** R2 prefix/bucket or dry-run mode, `NODE_ENV=production` to exercise the real code paths).
3. Restore a real (sanitized or access-controlled) database dump into the staging MariaDB and run `pnpm db:migrate` against it — this is the first real MariaDB run of every migration in `drizzle/`, not just a syntax read-through (see §9's "needs live verification" list — this rehearsal is *how* those get verified).
4. Run the full read-only validation queries in `docs/VPS_DATA_VALIDATION.md` against both the staging MariaDB and the still-live production TiDB, and diff the results with `scripts/vps-migration/compare-snapshots.mjs`.
5. Smoke-test manually: login (OAuth + local admin), browse novels, add to cart, checkout with a slip upload, wallet top-up, admin approval flow, daily check-in, coupon redemption.
6. Only after a clean rehearsal — with zero unexplained mismatches in the financial/entitlement queries — proceed to scheduling the real cutover.

## 7. Final cutover

See `docs/VPS_MIGRATION_CHECKLIST.md`'s P4 (Cutover) section for the exact ordered checklist, and this doc's §11 (Cutover data safety) for the underlying procedure and rationale for each step. Summary: freeze writes on the old system → snapshot/export → import to MariaDB → migrate/verify target-only → compare snapshots → smoke test → DNS switch → monitor.

## 8. DNS switch

- Lower the DNS TTL for the production domain **well before** the cutover window (see checklist P3) so the eventual switch propagates quickly.
- Point the domain's A/AAAA (or CNAME, depending on current setup) at the VPS's IP / Coolify-managed proxy.
- `CANONICAL_HOST` (env var) should already match the production domain; `LEGACY_REDIRECT_HOSTS` should keep the old Manus subdomain in its list so old bookmarks/links still 301-redirect correctly after cutover (`server/_core/canonicalDomainRedirect.ts`).
- Because `app.set("trust proxy", 1)` assumes exactly one reverse-proxy hop in front of the app (`server/_core/index.ts:72-77`), and Coolify's default reverse proxy (Traefik) is also exactly one hop, this should continue to work — but it must be explicitly smoke-tested post-cutover (see checklist P5), because a proxy-detection miss here has **already caused a real production incident once** ("the likely cause of admin sessions not persisting", per the comment at `server/_core/cookies.ts:32-34`) and cookie `secure`/`sameSite` behavior depends on it.

## 9. Database Compatibility Audit (TiDB → MariaDB)

Full detail; scanned all 33 journal-tracked migrations (`drizzle/0000`–`0032`, plus two non-journal-tracked standalone scripts `0003_admin_seed.sql` and `LOCAL_ADMIN_BOOTSTRAP.sql` — see the discrepancy note below) and `drizzle/schema.ts` directly. **No migration files were modified as part of this audit**, per this PR's explicit scope — any fix found below is deferred to a separate PR.

### Confirmed compatible

- **No TiDB-only DDL syntax anywhere.** Zero occurrences of `AUTO_RANDOM`, `SHARD_ROW_ID_BITS`, `/*T! ... */` optimizer-hint comments, or TiFlash-replica statements in any migration file.
- **No MySQL-8-only / MariaDB-incompatible DDL constructs found**: no `JSON_TABLE`, no `WITH ... AS` CTEs, no window functions (`OVER (`), no `INVISIBLE` columns, no functional indexes, no generated/virtual (`GENERATED ALWAYS`) columns anywhere in the schema or migrations.
- `ON DUPLICATE KEY UPDATE`, `PREPARE`/`EXECUTE`/`DEALLOCATE PREPARE` with session `SET @var` idempotency guards (used extensively in migrations 0022, 0027, 0029–0032), `MODIFY COLUMN`, and application-level `FOR UPDATE` locking reads (`server/db.ts:834,862`) are all standard SQL fully supported by MariaDB.
- `dialect: "mysql"` in `drizzle.config.ts` (generic MySQL dialect, not a TiDB-specific one) — Drizzle was never configured with TiDB-specific assumptions to begin with.
- `drizzle-orm/mysql2/migrator`'s `migrate()` call in `scripts/migrate.mjs` is engine-agnostic; its post-migration schema-verification step (`findMissingSchemaObjects`) already explicitly handles the MySQL-vs-MariaDB `lower_case_table_names` casing difference — this was added **after a real disposable-database run against local MariaDB already caught the bug** (`scripts/migrate.mjs:128-140`), i.e. this script has already been partially exercised against MariaDB once.
- The `FOR UPDATE` locking-read pattern in `server/db.ts:818-859` (`lockCartForCheckout`) is explicitly documented in its own docstring as written to be correct on **both** TiDB's snapshot semantics and standard InnoDB REPEATABLE READ (MariaDB's default) — this is a load-bearing comment confirming the fix is engine-agnostic by design, not TiDB-specific.

### Needs live MariaDB verification

*(These are not known bugs — they are places where the code/schema makes an assumption that has only ever been exercised against TiDB, and should be explicitly re-run against a real MariaDB instance during the staging rehearsal, §6, before being trusted for cutover.)*

- **Charset/collation**: zero `CHARACTER SET`/`COLLATE` clauses exist anywhere in `drizzle/schema.ts` or any migration SQL file — the schema relies entirely on the connected server's/database's *default* charset. MariaDB's server-level default charset is `utf8mb4` only from 11.x onward; earlier MariaDB versions default to `latin1` unless the server/database is explicitly provisioned otherwise. Since this app stores Thai-language novel content, an incorrectly-defaulted MariaDB instance risks silent truncation/mojibake on insert. **Action**: explicitly provision the MariaDB database with `utf8mb4`/`utf8mb4_unicode_ci` (or `utf8mb4_general_ci`, matching whatever the source TiDB database's default collation actually is — confirm via `SHOW CREATE DATABASE` against production before provisioning) rather than relying on server defaults. This is a provisioning-time action, not a schema/migration code change.
- **SQL strict mode**: no code sets or checks `sql_mode` anywhere. The app already has one documented production incident (`server/db.ts:1299-1306`, the `ocrConfidence` `MODIFY COLUMN` bug) that depended on strict mode being enabled to *fail loudly* instead of silently coercing bad inserts. MariaDB's default `sql_mode` includes `STRICT_TRANS_TABLES` from 10.2+, but this should be explicitly confirmed on the actual VPS MariaDB install (`SELECT @@sql_mode`) rather than assumed.
- **Migration journal / file-count discrepancy**: `drizzle/meta/_journal.json` lists 33 entries (idx 0–32), but the `drizzle/*.sql` glob returns 34 files — `0003_admin_seed.sql` and `0023_gifted_juggernaut.sql` are **not** in the journal (the journal has `0003_flippant_moondragon` and `0023_add_episode_sale_mode` at those indices instead) and are therefore **never executed by `migrate()`**. `0003_admin_seed.sql` and the separate `drizzle/LOCAL_ADMIN_BOOTSTRAP.sql` both contain a bootstrap `INSERT ... ON DUPLICATE KEY UPDATE role = 'admin'` statement — these appear to be manually-invoked, one-off scripts, not part of the tracked migration chain. **Action for the rehearsal**: confirm this is intentional (not a broken/orphaned migration) before relying on `pnpm db:migrate` alone to fully provision a fresh MariaDB from empty — if an admin bootstrap row is expected on a fresh install, it must be applied as a deliberate, separate, documented step, not assumed to run automatically. **Not fixed in this PR** (would be a change to the migration chain, out of scope).
- **`JSON_EXTRACT` usage** (`server/ocr-slip-integration-staging.ts:183`, comment: "For MySQL/TiDB, use JSON_EXTRACT to search within extractedData") — MariaDB 10.2+ supports `JSON_EXTRACT`/`->`/`->>`, but stores JSON as `LONGTEXT` with a `CHECK` constraint rather than a native binary JSON type, which can have subtly different behavior from MySQL/TiDB's native JSON type in edge cases (e.g. key ordering, whitespace normalization). Re-run any OCR-search query path exercising this against the staging MariaDB.
- **Transaction isolation semantics**: `server/db.ts:818-859`'s docstring explicitly reasons about TiDB's *pessimistic-transaction snapshot* behavior differing from standard InnoDB REPEATABLE READ for non-locking reads — the code was written to be correct on both (see "Confirmed compatible" above), but this is exactly the kind of subtle runtime-behavior claim that should be spot-checked with a concurrent-checkout test against real MariaDB during rehearsal, not trusted from the comment alone.

### Potential blocker

- **TiDB-specific runtime *behaviors* the app has already had to work around, which will not reproduce identically on MariaDB** — these are not migration blockers (nothing here prevents `migrate()` from succeeding), but they represent load-bearing incident-response code that assumes TiDB-specific error codes/behaviors and should be reviewed for whether they're still needed / whether they need a MariaDB-equivalent fallback:
  - **TiDB errno 8176** ("query cancelled because the TiDB server memory limit was exceeded") — drives a page-first/bounded-scan query design in `server/services/hybridHealthQueries.ts` and a hotfix comment in `server/routers.ts:1861`. MariaDB has no equivalent errno; the bounded-scan query shape is harmless (just a query pattern) but any error-code-based *retry/fallback* logic keyed specifically to `8176` will simply never trigger on MariaDB — confirm this doesn't silently disable an important safety net (read the surrounding code in a follow-up, not fixed here).
  - **TiDB errno 8025** ("Reorg-Data" failure on certain column-type changes) — documented in `server/migration-0024-content-downgrade.integration.test.ts` and `server/migration-legacy-pending-chain-static.test.ts` as having previously aborted a real production deployment. `server/migration-0024-content-downgrade.integration.test.ts:26-28` **already explicitly states**: "MariaDB does not reproduce TiDB's errno-8025 Reorg-Data failure mode" — i.e. this specific historical risk is *lower* on MariaDB, not higher, but any code that specifically detects/handles errno 8025 will simply never fire there. Not a blocker; flagged for awareness.
  - **TiDB TCP-close/FIN-handling quirk** — `server/test-helpers/closeMysqlConnectionSafely.ts` extensively documents TiDB not sending a remote FIN / not emitting a socket `'end'` event on connection close, and was written specifically to tolerate that. MariaDB's TCP-close behavior should be standard/well-behaved; this helper should still work (it tolerates the *absence* of the event, not require it), but is worth a quick connection-lifecycle smoke test during rehearsal.
  - **TiDB named-lock (`GET_LOCK`/`RELEASE_LOCK`) session-scoping assumptions** referenced in `docs/DAILY_CHECKIN_DYNAMIC_REWARDS_DESIGN.md` and used as the migration-serialization mechanism in `scripts/migrate.mjs`. `GET_LOCK`/`RELEASE_LOCK` are standard MySQL/MariaDB functions with well-defined, matching session-scoping semantics on both engines — **not expected to be a blocker**, but since the startup-migration lock is a fail-closed safety mechanism (a stuck lock blocks the app from ever booting), explicitly test acquiring/releasing it against the staging MariaDB during rehearsal.

### Not applicable

- **TiDB Cloud's mandatory-TLS requirement** (`server/test-helpers/testDbConnectionOptions.ts:7-12`'s documented "Connections using insecure transport are prohibited" error) — this was a TiDB Cloud *hosting* requirement, not a TiDB *engine* requirement; a self-hosted MariaDB on Coolify's internal Docker network has no equivalent constraint. Not applicable to the target architecture (see §4).
- **`AUTO_RANDOM`/`SHARD_ROW_ID_BITS`** (TiDB's answer to auto-increment hotspotting on a distributed cluster) — not applicable, because the schema never used these in the first place (single-node MariaDB has no such concept, and didn't need to be examined for a fix — there's nothing to migrate away from).

## 10. Rollback

See `docs/VPS_ROLLBACK_PLAN.md` for the full procedure, triggers, and decision-making process. One-line summary: keep the old Manus/Cloud system fully intact and reachable (not decommissioned) for a minimum of 3–7 days after DNS switch (budget-dependent), never let both databases accept writes simultaneously post-cutover, and have a named decision-maker and a hard deadline for the rollback-or-commit call.

## 11. Post-cutover monitoring

- Watch application logs and the (to-be-added, see §3 item 4) health-check endpoint continuously for the first hours after DNS switch.
- Re-run `docs/VPS_DATA_VALIDATION.md`'s read-only queries against the now-live MariaDB periodically during the monitoring window to catch any drift (e.g. a checkout succeeding but a purchase entitlement failing to grant) early, not just once at cutover.
- Watch for OCR/Forge-API failures specifically (see §5/§13) — this is the one external dependency most likely to break silently if Manus-hosting-tied credentials stop working, and slip auto-approval failing open/closed incorrectly has direct financial impact.
- Confirm the Discord OCR-review webhook (if configured) is still firing — it's a canary for whether the OCR pipeline is behaving at all.

## 12. Old-cloud decommission

- **Do not decommission the old Manus/Cloud system immediately after the DNS switch.** Keep it running, fully intact, for at least 3–7 days (budget-dependent — see the urgency note at the top of this doc; if cloud credit truly cannot stretch that long, that tradeoff must be an explicit, informed decision by whoever owns the rollback call, not a default).
- Confirm the *last* backup/export taken from the old system before decommission is the same one already verified restorable in `docs/VPS_ROLLBACK_PLAN.md` and `docs/VPS_MIGRATION_CHECKLIST.md`'s P0 section — do not decommission on the assumption that "we probably won't need it."
- Only after the rollback window has fully elapsed with no rollback decision made: revoke the old system's credentials/API keys (Manus OAuth app, Forge API key, old TiDB credentials) and shut it down.

## 13. Known limitations / external dependencies this PR cannot resolve

- **OAuth and OCR/LLM both depend on Manus continuing to serve `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, and `BUILT_IN_FORGE_API_URL`/`KEY` for an app no longer hosted on Manus's own platform.** This cannot be verified or fixed from inside this repository — it requires confirmation from whoever administers the Manus platform account. If either stops working post-migration, user login or OCR/AI features break regardless of how correctly the VPS/Coolify/MariaDB side is configured. Flagged here as the single largest non-code risk to this migration.
- **The legacy Manus storage proxy** (`server/storage.ts`) is still actively used for sports-match images and AI-generated images — moving off Manus hosting does not automatically migrate this dependency; it needs either continued Manus API access (same caveat as above) or a follow-up PR routing these two upload paths through R2 like covers/banners already were. Not fixed here (would be a business-logic/feature code change, out of scope for this PR).
- **No HTTP health-check route exists yet** (§3 item 4) — required before Coolify can reliably detect deploy failures, but deliberately not added in this docs/scripts-only PR.
- **No `Dockerfile`/Nixpacks config exists yet** — required before Coolify can build this repo at all; deliberately not added in this PR (would touch application-adjacent build config beyond the agreed `docs/`, `scripts/vps-migration/`, tests, and narrow `package.json` scope).
