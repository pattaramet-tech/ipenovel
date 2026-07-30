# VPS Migration Checklist

Companion to `docs/VPS_MIGRATION_RUNBOOK.md`. Work through phases in order — do not start P2 before P0/P1 are done, do not start P4 before P3 is done. Every item is a manual verification step for a human operator; nothing here is automated by this PR (see `scripts/vps-migration/README.md` for what tooling exists and its explicit limits).

Priority reminder: data recoverability > financial/entitlement correctness > deploy > rollback, ahead of any new feature work.

## P0 — Backup

- [ ] Take a full production database export (TiDB) using the team's normal export tooling — **not** from this sandbox (this PR/environment must never export production data, see repo-wide constraints).
- [ ] Verify the export completed without truncation/error (row-count spot check against a few known-large tables: `episodes`, `orders`, `purchases`).
- [ ] **Test-restore the export into a disposable database** (not production, not the target VPS yet) and confirm it comes up cleanly. An export that has never been restored is not a verified backup.
- [ ] Record the export's timestamp, size, and storage location (private location — not committed to this repo, not pasted into chat/PR text).
- [ ] Confirm R2 bucket contents (both public and private buckets) are covered by Cloudflare's own retention/versioning, or take an explicit inventory/export if not — R2 is not touched by the database export above.
- [ ] Confirm who has access to the backup and where it's stored; this must be recoverable by more than one person.
- [ ] Snapshot current environment variable values (names only need to appear in this repo's docs — the actual values belong in a password manager / secrets vault, never in git).

## P1 — VPS provisioning

- [ ] Provision the VPS (sizing TBD by team — out of scope for this doc) and install Coolify.
- [ ] Provision the MariaDB service inside Coolify (§4 of the Runbook) on the internal Docker network only — confirm port 3306 is **not** exposed publicly (`docker ps` / Coolify's service network settings should show no public port mapping).
- [ ] Explicitly set the MariaDB database's default charset/collation to `utf8mb4`/an explicit collation matching production (see Runbook §9 — "Needs live MariaDB verification") — do not rely on server defaults.
- [ ] Confirm the target MariaDB version is recorded (for future reference — no specific minimum version is enforced by this app's code today per the Runbook's audit, but note it here anyway).
- [ ] **Blocking pre-cutover code change (tracked here, not fixed in this PR)**: wire `getHealthStatus()`/`getReadinessStatus()` (`server/_core/healthCheck.ts`) to a real HTTP route so Coolify's health check has something to poll. Do this in a follow-up PR before P4.
- [ ] **Blocking pre-cutover code change (tracked here, not fixed in this PR)**: add a `Dockerfile` or Nixpacks build config so Coolify can build this repo. Do this in a follow-up PR before P4.
- [ ] Create the Coolify application resource pointed at this GitHub repo, branch `main`, per Runbook §3.
- [ ] Populate the Coolify app's environment variables per `docs/VPS_ENVIRONMENT_INVENTORY.md` — every row marked Required, plus every Optional row the team wants to preserve current behavior for. No secret values are copied into this repo at any point.
- [ ] Configure Coolify's deploy strategy explicitly (rolling/recreate — see Runbook §3 item 5) rather than leaving it as an unverified default.
- [ ] Set up TLS/HTTPS termination at Coolify's reverse proxy for the domain that will eventually be used (can be a staging subdomain for now).
- [ ] Firewall baseline confirmed: only SSH, HTTP, HTTPS are publicly reachable (see Runbook §12's cross-reference and this doc's own firewall note below). Docker daemon TCP port is **not** exposed.

## P2 — Rehearsal

- [ ] Deploy this app to the (still-staging) Coolify instance from `main` and confirm it builds and starts.
- [ ] Restore the P0 test-restore database (or a fresh export) into the staging MariaDB.
- [ ] Run `pnpm db:migrate` against the staging MariaDB and confirm it completes with no errors and no missing-schema-object failures (`scripts/migrate.mjs`'s own post-migration verification).
- [ ] Run every "Needs live MariaDB verification" item from the Runbook's Database Compatibility Audit (§9) against this staging database and record the outcome of each (confirmed OK / found an issue → file a separate follow-up issue, do not fix inline during rehearsal).
- [ ] Run all read-only queries in `docs/VPS_DATA_VALIDATION.md` against both the still-live production database and the staging MariaDB; save both result sets as JSON snapshots (format: see `scripts/vps-migration/README.md`).
- [ ] Run `node scripts/vps-migration/compare-snapshots.mjs <source.json> <target.json>` on the two snapshots and confirm it exits 0 (or triages every reported mismatch as explained/expected, e.g. natural time-of-day drift between when each snapshot was taken).
- [ ] Manual smoke test on staging: OAuth login, local admin login, browse novels, add to cart, checkout with a slip upload, wallet top-up + OCR review flow, admin payment approval, daily check-in, coupon redemption, episode reading (both `chapter` and `package` sale modes).
- [ ] Confirm R2 uploads/downloads work from the staging deployment (both public and private buckets).
- [ ] Confirm the OAuth login round-trip actually completes against Manus's OAuth server from the staging domain (validates the redirect-URI-allowlist question from Runbook §5/§13).
- [ ] Confirm OCR/slip-verification actually completes against the Forge API from the staging deployment (validates the Forge-credential-continuity question from Runbook §5/§13).
- [ ] Time the full rehearsal end-to-end — this becomes the basis for the "maximum acceptable downtime" estimate in `docs/VPS_ROLLBACK_PLAN.md`.
- [ ] Fix anything broken found during rehearsal in its own separate PR, then **re-run the rehearsal** before proceeding to P3. Do not proceed on a rehearsal with unresolved failures.

## P3 — Pre-cutover

- [ ] Confirm all P1 blocking code changes (health-check route, Dockerfile/Nixpacks) have merged and been exercised in a rehearsal (P2), not just written.
- [ ] Lower the production domain's DNS TTL well ahead of the cutover window (hours to a day, per your DNS provider's propagation behavior).
- [ ] Schedule the cutover window and communicate it internally (and to customers if the team decides that's warranted — see Rollback Plan's "Customer communication").
- [ ] Confirm who has the authority to make the go/no-go and rollback decisions during the cutover window (see Rollback Plan).
- [ ] Re-verify the P0 backup is recent enough to be the one actually used for cutover, or take a fresh one right before the window starts.
- [ ] Confirm the staging Coolify app used for rehearsal is either promoted to production config or a fresh production Coolify app is provisioned identically — do not accidentally cut over to a staging app with staging credentials.
- [ ] Freeze non-critical merges to `main` for the duration of the cutover window (consistent with this migration's stated priority: correctness and deploy readiness over new features).

## P4 — Cutover

Full step-by-step rationale is in the Runbook §7/§11 and `docs/VPS_ROLLBACK_PLAN.md`. This is the ordered execution checklist:

- [ ] 1. Confirm DNS TTL is already lowered (should have happened in P3, not now).
- [ ] 2. Verify the latest backup one more time (exists, is recent, was already test-restored in P0/P2 — do not skip this because P0 did it once, days ago).
- [ ] 3. Put the old (Manus/Cloud) site into maintenance/read-only mode.
- [ ] 4. Record the exact cutover start timestamp (this is the reference point for "writes made after cutover" in the Rollback Plan).
- [ ] 5. Take the final source (production TiDB) validation snapshot per `docs/VPS_DATA_VALIDATION.md`.
- [ ] 6. Take the final source database export.
- [ ] 7. Import that export into the target MariaDB.
- [ ] 8. Run `pnpm db:migrate` against the target **only** (never re-run migrations against the still-live source).
- [ ] 9. Run the target-side validation snapshot and `compare-snapshots.mjs` against the two final snapshots — this must show **zero** mismatches on every financial and entitlement check (see `docs/VPS_DATA_VALIDATION.md`'s exact-match policy). A mismatch here is a stop-the-cutover condition, not a "note it and continue."
- [ ] 10. Run the same manual smoke-test list as P2, now against the real production-configured target.
- [ ] 11. Switch DNS to the VPS.
- [ ] 12. Monitor actively (see P5) — do not walk away immediately after the DNS switch.
- [ ] 13. Confirm/record the rollback decision deadline (see Rollback Plan) before ending the active cutover session.

## P5 — Post-cutover

- [ ] Monitor application logs and the health-check endpoint continuously for the first few hours.
- [ ] Re-run `docs/VPS_DATA_VALIDATION.md` queries against the now-live MariaDB at least once more a few hours in, to catch anything that only manifests under real production traffic (not just the cutover-moment snapshot).
- [ ] Confirm OAuth login is working for real users hitting the new domain (not just the rehearsal/staging domain).
- [ ] Confirm OCR/slip verification and the Discord review webhook (if configured) are firing correctly under real traffic.
- [ ] Confirm the `trust proxy`/cookie `secure` behavior is correct in production (session persistence, especially for admins) — this exact mechanism has caused a real incident before (see Runbook §8).
- [ ] Do **not** decommission the old system yet (see P0/Runbook §12 — minimum 3–7 days, budget-dependent).
- [ ] Confirm the old system remains read-only/maintenance-mode (never accepting writes) for the entire retention window — the old and new databases must never both accept writes after cutover.
- [ ] At the end of the retention window, with no rollback decision made: revoke old credentials (Manus OAuth app if being fully retired, old TiDB credentials, old Forge API key if replaced) and decommission the old system.
- [ ] Retain the cutover evidence (final snapshots, compare-snapshots.mjs output, smoke-test results, timestamps) per the Rollback Plan's "Evidence to retain" section for at least as long as the retention window, ideally longer.

---

## Firewall baseline (cross-reference, P1)

Only these are public:
- SSH (restrict to known IPs if possible — out of scope for this doc to mandate, but strongly recommended)
- HTTP (port 80, for ACME/Let's Encrypt challenge + redirect to HTTPS)
- HTTPS (port 443)

Never public:
- MariaDB (port 3306) — internal Docker network only.
- Docker daemon TCP port — must not be exposed at all (Coolify manages Docker locally; there is no legitimate reason to expose the daemon socket over TCP for this deployment).
