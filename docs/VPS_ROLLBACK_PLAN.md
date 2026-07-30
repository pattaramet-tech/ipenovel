# VPS Migration Rollback Plan

Companion to `docs/VPS_MIGRATION_RUNBOOK.md` and `docs/VPS_MIGRATION_CHECKLIST.md`. This document exists so a rollback decision, if needed, is made from a pre-agreed plan under pressure — not improvised during an incident.

## Rollback trigger

Any of the following, discovered either during the cutover window (P4) or the post-cutover monitoring window (P5), is a trigger to seriously consider rollback:

- `scripts/vps-migration/compare-snapshots.mjs` reports a mismatch on any financial total, financial row count, or entitlement count between the source and target snapshots (see `docs/VPS_DATA_VALIDATION.md`'s exact-match policy) that cannot be explained by legitimate writes that happened *after* the source snapshot was taken.
- The application fails to start on the VPS, or the health check never goes healthy, within a reasonable deploy window.
- OAuth login is broken for real users on the new domain (not just a staging/rehearsal issue).
- Checkout, wallet top-up, or payment approval is broken, erroring, or producing incorrect balances/entitlements for real users after DNS switch.
- Data corruption or unexpected data loss is observed in the target MariaDB that wasn't present in the source snapshot.
- Any other correctness issue the on-call/deciding engineer judges severe enough that continuing to serve traffic from the new system is worse than rolling back.

Cosmetic issues, non-critical feature degradation (e.g. analytics not loading), or slow-but-correct behavior are **not** automatic rollback triggers — they should be fixed forward instead, per this migration's stated priority order (correctness and recoverability come first, but a rollback itself is also disruptive and should not be used as a first response to a minor issue).

## Maximum acceptable downtime

Not a fixed number in this document — it must be set from the actual timing measured during the P2 staging rehearsal (see Checklist P2's last item: "Time the full rehearsal end-to-end"). Record that measured duration here once the rehearsal has run, and set the go/no-go and rollback-decision deadlines (below) with real margin around it, not a guess made before rehearsal exists.

## DNS rollback

- Because DNS TTL was lowered ahead of the cutover window (Checklist P3), reverting the domain's A/AAAA/CNAME record back to the old Manus/Cloud system's address should propagate on the same short timescale as the original cutover.
- This is only safe to do because the old system was **not** decommissioned immediately after cutover (Runbook §12, Checklist P5) — it must still be fully intact, reachable, and not itself half-decommissioned, for a DNS rollback to actually restore service.

## Restoring the old application

- The old Manus/Cloud deployment is left running (not stopped, not decommissioned) throughout the retention window specifically so this step is "take it out of maintenance/read-only mode," not "redeploy from scratch."
- If the old system was placed in maintenance/read-only mode during cutover (Checklist P4 step 3), reverse that — restore normal read/write mode — as part of the rollback, once the decision is made.

## Restoring the database

- **The old production database (TiDB) is also left running and untouched during the retention window** — rolling back the DNS and re-enabling the old app does not require restoring anything if the old database was never touched (no writes were ever directed at it after cutover — see "Handling writes made after cutover" below for why this matters).
- If for some reason the old database *does* need restoring (e.g. it was accidentally modified during troubleshooting), restore from the P0 backup that was already test-restored — never attempt to restore an unverified backup for the first time during an active incident.

## Handling writes made after cutover

This is the hardest part of any rollback and the reason "never let both databases accept writes simultaneously post-cutover" (Runbook §12, Checklist P5) is a hard rule, not a suggestion:

- If DNS has fully switched and the old system was correctly put into maintenance/read-only mode, **no legitimate writes should have landed on the old database after the recorded cutover timestamp** (Checklist P4 step 4). In that case, rolling back is "just" a DNS revert plus taking the old system out of read-only mode — no data reconciliation needed.
- If writes *did* land on the new (VPS/MariaDB) system before the rollback decision was made (the expected, normal case — the whole point of cutting over was to start serving real traffic), those writes exist **only** in the new database and must be manually reviewed and re-applied to the old database (or preserved and merged forward once the new system is fixed and cutover is re-attempted) before or as part of resuming service on the old system. This is inherently manual, order-sensitive work (financial transactions, wallet balances, purchases must be replayed in the correct order) — there is no automated tool for this in this PR's scope, and none should be improvised live; if this scenario occurs, treat "reconstruct the write log since cutover" as its own careful, checked task before declaring the rollback complete.
- This is precisely why the rollback-decision deadline (below) exists: the longer the new system has been live and accepting writes, the more expensive and error-prone this reconciliation becomes. A fast decision, even if it turns out to be "roll back," is safer than a slow one.

## Customer communication

- Decide, per the severity of the trigger, whether customer-facing communication is warranted (a status page update, an in-app banner, or nothing if the issue is caught and resolved within the maximum-acceptable-downtime window without visible impact).
- If a rollback happens, and any customer-visible writes made during the new system's uptime cannot be preserved/replayed cleanly, that is a **support-and-trust issue**, not just a technical one — flag it to whoever owns customer communication immediately, do not let it surface only when a customer complains.

## Who decides rollback

- Must be a single named, reachable person (or a small pre-agreed on-call pair) for the duration of the cutover and monitoring windows — decided and recorded in `docs/VPS_MIGRATION_CHECKLIST.md`'s P3 section before the cutover window begins. This document deliberately does not name a specific person, since that's an operational/organizational decision outside this repo's scope — but the checklist item exists precisely so it isn't left undecided when it matters.
- The decision-maker has the authority to trigger rollback unilaterally if a trigger condition (above) is met and they judge it severe enough — they should not need to seek further approval mid-incident, since that delay is itself a risk (see "Handling writes made after cutover").

## Evidence to retain

Retain all of the following for at least as long as the old-system retention window (Runbook §12), ideally longer, in a location outside this git repository (never commit any of this — it may contain real data shapes even if not raw secrets):

- The final source-side and target-side validation snapshots (`docs/VPS_DATA_VALIDATION.md` query outputs) taken during cutover.
- The full `compare-snapshots.mjs` output from the cutover (not just the rehearsal).
- Timestamps: cutover start, DNS switch, and (if applicable) rollback decision and DNS-revert-complete.
- Smoke-test results from both the P2 rehearsal and the real P4 cutover.
- Any incident notes, error logs, or screenshots captured during the monitoring window that informed a rollback decision (or the decision *not* to roll back, if a trigger condition was evaluated and judged not severe enough).
- The specific backup file identifier/timestamp actually used for the cutover (not just "we had a backup" — the exact one).
