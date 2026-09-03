# IPE-021 — Payment Approval V2 Architecture and Lock Invariants

**Phase:** IPE-021-A — Architecture & Lock Invariant Design
**Baseline:** `b56c849a5860cee97f5d817b31ae032ee2014668` (`fix/wallet-approval-timeout-parity`)
**Status:** Design specification; no production route cutover in this phase.

## 1. Executive summary

The recurring approval failures are not primarily an API error-mapping problem. The current architecture uses the `users` row as both:

1. the Account Merge exclusion barrier; and
2. the serialization primitive for points balance mutations.

Order approval therefore takes an exclusive `users ... FOR UPDATE` lock before the payment row, while Wallet approval and OCR persistence take a shared `users ... LOCK IN SHARE MODE` barrier. Those locks remain held across more work than is necessary for account-merge correctness.

The most important long-transaction finding is that `claimSlip()` is not only a unique-registry insert. Before inserting, it calls `evaluateSlipConflict()`, which can fall back to `findLegacyApprovedSlipDuplicate()`. While the trusted anti-replay backfill is incomplete or its checksum is not current, the compatibility layer performs an uncapped scan of the approved historical corpus. Missing historical file hashes may be recovered by fetching and hashing historical slip files from storage. Today this can occur inside an Order or Wallet approval transaction while `users` and the approval subject are already locked.

C03/C04 shortened the current target slip hash to three seconds and improved lock-stage diagnostics, but those changes do not bound a legacy historical scan or remove the `users` hot-row coupling. A request can therefore still wait until MySQL's lock-wait timeout even though the current-slip hash itself is bounded.

Payment Approval V2 must use a two-phase application protocol:

- **PREPARE:** expensive reads, OCR/storage I/O, identifier derivation, and legacy compatibility evaluation outside any financial commit transaction.
- **COMMIT:** a short transaction containing only database-local locking, evidence/version revalidation, the authoritative unique claim, financial state changes, entitlements, idempotency records, and audit writes.

V2 must also separate the Account Merge barrier from the `users` profile row and give points its own serialization resource. The long-term target is that no payment approval uses a `users` row as a general-purpose financial mutex.

## 2. Non-negotiable correctness invariants

The redesign is valid only if all of these remain true.

### 2.1 Financial atomicity

For one approval attempt, the anti-replay claim and all value created by that approval must commit together or roll back together.

Order approval value includes, as applicable:

- payment/order approved state;
- purchase entitlements;
- points redemption;
- points award;
- coupon usage/reward state;
- order history;
- legacy-resolution audit.

Wallet approval value includes:

- top-up approved state;
- wallet balance change;
- wallet transaction ledger row;
- top-up audit log;
- legacy-resolution audit.

No state may be durably left as “approved” when the corresponding claim or financial finalization rolled back.

### 2.2 Exactly-one replay ownership

`paymentSlipClaims` global unique constraints on `referenceHash`, `fileHash`, and `qrPayloadHash` remain the authoritative final arbiter for exact strong identifiers. Two different sources must never both create value from the same exact strong identifier.

### 2.3 Subject state race safety

The commit transaction must lock and reload the payment/top-up and refuse to proceed if it is no longer reviewable. A stale browser or stale PREPARE result may never approve a finalized subject.

### 2.4 Slip/evidence binding

The evidence used in COMMIT must correspond to the same slip version that was prepared. At minimum the commit must revalidate:

- source type and source id;
- owner user id;
- reviewable status;
- slip storage reference;
- `slipSubmittedAt`;
- a monotonic evidence/version token introduced for V2;
- persisted extraction/evidence version;
- durable integrity-block state.

`updatedAt` alone is not a sufficient security version because unrelated writes can change it and timestamp precision/semantics are not a purpose-built concurrency contract.

### 2.5 Current-byte integrity

V2 must not weaken IPE-001-C09. A DB row pointing at the same storage key is not, by itself, proof that the bytes are unchanged.

Modern V2 slips therefore require one of these explicit proofs:

1. **Preferred:** immutable/content-addressed private object references. The storage key is derived from or durably bound to the exact file hash and the storage API refuses overwrite of an existing key with different bytes; or
2. a trusted immutable object version identifier stored with the subject and verified by the application contract.

The existing random timestamp key generation is collision-resistant but is not a write-once guarantee. `putPrivateObject()` currently performs a normal `PutObject` and therefore cannot be treated as immutable merely because keys are normally unique.

Legacy mutable URLs/keys must not silently enter the V2 fast path.

### 2.6 Account Merge safety

Once Account Merge has activated a durable Source-account guard, a financial/classified Source mutation must not commit. Conversely, a financial mutation that acquired the common guard before Merge activation must either commit before the merge snapshot is made authoritative or cause Merge to wait.

This invariant needs a dedicated guard resource, not the `users` profile row.

### 2.7 No external I/O under V2 financial locks

The V2 fast commit transaction must not perform:

- R2/CloudFront HTTP fetches;
- OCR/provider calls;
- legacy historical file recovery;
- unbounded historical scans;
- filesystem/network operations.

The commit path must be database-local and bounded.

## 3. Current architecture inventory

| Flow | First account lock | Subject lock | Work performed while account lock is held | Risk |
|---|---|---|---|---|
| Order manual approval | Exclusive `users FOR UPDATE` via `assertAccountMergePointsMutationAllowed` | `payments FOR UPDATE` | current-byte hash, `claimSlip`, possible legacy scan/storage recovery, payment/order writes, purchases, points, coupon, audit | Critical |
| Order automatic approval | Exclusive `users FOR UPDATE` | `payments FOR UPDATE` | claim/finalization; expensive OCR is mostly before tx, but claim compatibility can still be expensive | High |
| Wallet manual approval | Shared `users LOCK IN SHARE MODE` via classified guard | `walletTopups FOR UPDATE` | current-byte hash, `claimSlip`, possible legacy scan/storage recovery, wallet balance and ledger writes, audit | Critical |
| OCR Recheck final persist | Shared `users LOCK IN SHARE MODE` | payment conditional update/subject lock path | external OCR/hash/conflict work is mostly outside lock; final persistence still contends on user guard | Medium |
| Points mutation | Exclusive `users FOR UPDATE` | no dedicated points-balance row | points ledger read-modify-write | High hot-row coupling |
| Account Merge lifecycle | Exclusive `users FOR UPDATE`, users sorted ascending | merge-case rows + classified resources | potentially broad reconciliation work depending phase | Intentionally exclusive, but coupled to all financial user locks |

### 3.1 Why C03/C04 could not remove the 50-second wait

C03/C04 correctly bounded the **current subject** storage hash to 3 seconds. They did not change the fact that `claimSlip()` may invoke legacy compatibility work while the transaction holds account/subject locks.

`scanApproved()` deliberately has no correctness cap. It pages until the historical approved corpus is exhausted. When a historical approved row lacks a persisted file hash, compatibility recovery can fetch/hash its slip file. Therefore total claim preparation latency is not bounded by the three-second current-slip hash timeout.

### 3.2 When the legacy scan is active

`isLegacyScanRequired()` fails closed. Live compatibility scanning remains required unless the singleton backfill state proves:

- write phase completed;
- completion timestamp exists; and
- stored checksum equals the current approved-corpus checksum.

This is correct anti-replay behavior, but it is incompatible with a short financial transaction if performed after taking hot locks.

### 3.3 Points has no dedicated balance resource

The current points balance is derived from the latest `pointsTransactions` row. There is no `pointsAccounts`/`pointsBalances` row and no unique idempotency key for every order award/redeem operation. The `users` row is consequently used as the serialization lock for points read-modify-write.

This must change before Order Approval V2 can completely stop using `users FOR UPDATE`.

### 3.4 Wallet already has the correct natural balance resource

`walletAccounts.userId` is unique and contains the wallet balance. Wallet V2 should lock this row when credit arithmetic begins; a user profile row is not the natural balance mutex.

## 4. Target V2 resource model

### 4.1 Dedicated account mutation guard

Introduce a dedicated row per user, conceptually:

```text
accountMutationGuards
  userId              PRIMARY KEY
  generation          BIGINT NOT NULL
  mergeState          ENUM('open','merge_guarded') NOT NULL
  activeMergeCaseId   BIGINT NULL
  updatedAt           ...
```

Exact naming/schema belongs to IPE-021-D, but the semantics are required now.

Ordinary financial/classified commits acquire this small guard row in a shared mode (or an equivalent lock that conflicts with Merge activation but not with other ordinary mutations), verify that mutation is allowed, and hold that guard until their transaction commits. Account Merge acquires the same guard rows exclusively in ascending `userId`, activates the durable guard, and increments `generation` when guard state changes. This preserves fail-closed Merge exclusion without recreating an unnecessary same-user global mutex for unrelated ordinary mutations.

The `users` profile row is no longer the common exclusion primitive.

### 4.2 Dedicated points balance resource

Introduce a points balance row, conceptually:

```text
pointsAccounts
  userId       PRIMARY KEY
  balance      DECIMAL(...) NOT NULL
  version      BIGINT NOT NULL
  updatedAt    ...
```

`pointsTransactions` remains the immutable audit ledger. The balance row becomes the serialization point for points arithmetic.

Add explicit idempotency uniqueness for financial effects, for example an effect key equivalent to:

```text
(userId, effectType, referenceType, referenceId)
```

or a dedicated `financialEffectClaims` table. The exact migration is an implementation decision for the later phase, but V2 must not depend solely on “query ledger, then insert” without a unique guard.

### 4.3 Subject evidence version

Add a monotonic `evidenceVersion`/`slipVersion` integer to `payments` and `walletTopups` (or a dedicated immutable evidence record referenced by the subject).

Rules:

- every genuine slip replacement increments the version atomically with publishing the new reference and clearing/reseeding extracted evidence;
- OCR/Recheck persistence records which evidence version it evaluated;
- PREPARE captures the version;
- COMMIT requires exact equality after locking the subject.

This is stronger and clearer than using `updatedAt` as a proxy.

### 4.4 Immutable modern slip object contract

Preferred modern upload contract:

```text
hash exact bytes before/during upload
key = payment-slips/<namespace>/<sha256-or-content-id>/<random-safe-name>
write object with create-only semantics
persist fileHash + immutable object identity + evidenceVersion atomically when publishing
```

At minimum, storage write must reject replacing an already-published object identity with different bytes. If the underlying provider cannot enforce create-only semantics directly, the application needs an equivalent durable write-once registry.

Once this contract is proven, COMMIT does not need network I/O to establish that an unchanged immutable object identity still represents the bytes hashed during PREPARE.

### 4.5 Legacy evidence classification

Legacy mutable URLs/objects remain a distinct evidence class. They do not inherit modern immutability by migration-free assumption.

The V2 route must know whether a subject is:

- `modern_immutable` — eligible for V2 fast path;
- `legacy_migrated_immutable` — eligible after migration verification;
- `legacy_compatibility_required` — not eligible for fast path.

## 5. V2 application protocol

## 5.1 PREPARE — no financial transaction

PREPARE may be retried and may take seconds. It creates no financial value.

1. Read subject and immutable owner relationship.
2. Require the subject to look reviewable as an early UX check.
3. Capture `SubjectSnapshot`:
   - source type/id;
   - owner user id;
   - status;
   - slip reference;
   - `slipSubmittedAt`;
   - `evidenceVersion`;
   - persisted extraction digest/version;
   - integrity/review block fields.
4. Read/hash current slip bytes or verify immutable-object evidence.
5. Perform OCR/provider work when relevant.
6. Derive strong identifiers and semantic fingerprint.
7. Run conflict/legacy compatibility evaluation outside the financial transaction.
8. Capture anti-replay compatibility state used by the decision.
9. Produce an internal `PreparedApproval` object. It is server-generated and must never trust browser-provided identifiers/hashes.

The browser may carry an opaque attempt token, but authoritative prepared evidence must be server-verifiable or recomputable.

## 5.2 COMMIT — short database-only transaction

The target p95 commit section should be comfortably below one second under normal DB conditions; no operation is allowed to consume a storage/OCR timeout.

Canonical sequence for a single-user approval:

1. lock `accountMutationGuards(userId)`;
2. verify merge guard is open and expected generation is acceptable;
3. lock approval subject (`payments` or `walletTopups`);
4. reload and revalidate exact `SubjectSnapshot`/`evidenceVersion` and reviewability;
5. validate the PREPARE compatibility epoch/backfill state required by the selected path;
6. perform authoritative `paymentSlipClaims` insert/ownership check using prepared identifiers;
7. lock the actual balance resource only if this approval changes that balance:
   - Order points effect → `pointsAccounts(userId)`;
   - Wallet credit → `walletAccounts(userId)`;
8. perform subject status writes and financial/entitlement writes;
9. write idempotency/audit/history records;
10. commit.

No storage fetch, OCR, or historical scan may occur between steps 1 and 10.

### 5.3 Why account guard comes before subject

Account Merge may involve many classified resources. A common dedicated guard row acquired first gives Merge and ordinary financial mutations one small, deterministic rendezvous point without making the mutable user profile the mutex.

For multi-user operations, account guard rows are always locked in ascending `userId`.

### 5.4 Claim/balance lock ordering and mixed-mode compatibility

The anti-replay claim is taken after the subject but **before** a balance mutex. This order matches the existing V1 financial shape: Order and Wallet establish the claim before their downstream points/wallet balance effect. Keeping that relative order avoids introducing a V1/V2 inversion during the period when an explicitly classified legacy V1 fallback still coexists with V2, and it avoids holding a balance row while waiting on a duplicate-claim decision.

Balance rows are therefore taken only after the authoritative claim succeeds. Non-approval points/wallet operations that never touch a claim simply acquire the account guard and then their balance resource; operations combining more classes must preserve the same relative order.

Global class order for IPE-021 implementation tests:

```text
ACCOUNT_GUARD
  -> APPROVAL_SUBJECT
  -> ANTI_REPLAY_CLAIM
  -> BALANCE_RESOURCE
  -> LEAF/LEDGER/AUDIT WRITES
```

No path may acquire an earlier class after a later class.

**Mixed-mode bridge is mandatory before V2 enablement.** During migration, every V1 financial/classified mutation that can race Account Merge must begin by acquiring the new `ACCOUNT_GUARD` even if it temporarily still needs a `users` row for a legacy implementation detail. Account Merge must likewise acquire the new guard first and may retain its old `users` locks only as a downstream transitional lock. Once Merge starts treating the new guard as authoritative, no enabled V1 fallback may remain `users`-only. Likewise, all points mutators that can coexist with V2 must be moved onto the new points balance/idempotency resource before V2 points effects are enabled; otherwise V1 and V2 would serialize different representations of the same balance.

The final implementation review must re-evaluate foreign-key side effects and InnoDB unique-index locking against this class order using real-database tests; the class order is a design contract, not a substitute for database concurrency verification.

## 6. Legacy anti-replay strategy

The live historical scan is the largest obstacle to a truly short V2 commit.

### 6.1 Recommended initial cutover rule

**Do not enable the V2 fast path while `isLegacyScanRequired()` is true.**

Before V2 becomes the default financial approval path, complete and verify the anti-replay backfill so the trusted registry/collision tables cover the approved historical corpus. When the backfill state is current and checksum-valid, the unique registry is sufficient for the normal fast path and no unbounded compatibility scan is needed during commit.

This is simpler and safer than inventing a complex transaction epoch around an unbounded live scan for the first release.

### 6.2 Compatibility fallback during rollout

Until trusted backfill completion:

- existing V1 approval remains available only as an explicitly labeled legacy compatibility fallback;
- C03/C04 diagnostics remain enabled;
- V2 routes/shadow evaluation must report `LEGACY_COMPATIBILITY_NOT_READY` rather than silently dropping anti-replay coverage;
- Preview should expose the readiness state so cutover cannot happen accidentally.

### 6.3 Future alternative if live scan must coexist with V2

If business requirements demand V2 before backfill completion, introduce a global historical-approval generation/epoch resource:

- PREPARE captures an epoch, performs the scan, then confirms the epoch did not move during preparation;
- every approval that extends the historical approved corpus changes that epoch in its COMMIT;
- COMMIT locks/checks the epoch before applying prepared legacy evidence.

This is more complex and creates a global serialization point. It is therefore a fallback design, not the recommended initial implementation.

## 7. Current-byte strategy and cutover classes

### 7.1 Modern immutable fast path

For a modern immutable slip:

PREPARE hashes/verifies the exact object outside the transaction. COMMIT revalidates `evidenceVersion` and immutable object identity under the subject lock. Because published object identity is guaranteed write-once, unchanged identity means unchanged bytes.

### 7.2 Legacy mutable path

For a legacy object without immutable identity proof, V2 must not claim that PREPARE hash remains current merely because DB fields are unchanged.

Options, in priority order:

1. migrate the object to a new immutable private key, publish a new evidence version, then use V2;
2. require a stable Recheck/migration step that materializes immutable evidence before approval;
3. temporarily retain V1 bounded in-lock verification for explicitly classified legacy rows.

No generic silent bypass is allowed.

## 8. Order Approval V2 boundary — IPE-021-B

IPE-021-B should implement an Order V2 path behind a feature flag or separate internal route, without deleting V1.

Required behavior:

- PREPARE performs current evidence verification and conflict evaluation outside commit locks.
- COMMIT uses dedicated account guard, payment subject, points balance resource, and unique claim.
- purchase entitlement creation remains transactionally coupled and protected by existing `uniqueUserEpisode`.
- order points redeem/award require explicit idempotency uniqueness.
- coupon usage must remain atomically coupled; any coupon lock ordering must be incorporated into the global resource order before cutover.
- no call reachable from COMMIT may invoke `computeSlipFileHash`, `computeTrustedLegacySlipFileHash`, OCR/provider code, or `scanApproved`.

Success for B does not mean route cutover; it means a testable V2 Order engine exists in parallel.

## 9. Wallet Approval V2 boundary — IPE-021-C

Required behavior:

- account guard replaces `users LOCK IN SHARE MODE`;
- wallet top-up is the subject lock;
- `walletAccounts(userId)` is the wallet balance mutex;
- current evidence/conflict preparation is outside commit;
- wallet transaction + top-up log + subject approval + anti-replay claim commit atomically;
- concurrent top-up credits for the same user serialize at `walletAccounts`, not at `users`;
- no external I/O in COMMIT.

## 10. Account Merge / points resource migration — IPE-021-D

IPE-021-D owns the cross-cutting schema/protocol work required to make B/C safe for cutover:

1. dedicated account mutation guard rows + generation semantics;
2. a mixed-mode bridge: all still-enabled V1 classified/financial mutations acquire the new account guard first, and Account Merge acquires the same guard before any transitional `users` lock;
3. migration of Account Merge prepare/cancel/finalize to those guard rows;
4. dedicated points balance row and migration/backfill from ledger state, with all coexisting points mutators moved to that same mutex before V2 points effects are enabled;
5. points financial-effect idempotency uniqueness;
6. modern immutable slip evidence/version contract;
7. trusted anti-replay backfill readiness gate required by V2 fast path.

All migration scripts must be idempotent or explicitly guarded and must have rollback/reconciliation instructions.

## 11. Required concurrency and failure matrix — IPE-021-E

All scenarios below require real MySQL integration coverage, not static tests alone.

| Scenario | Required outcome |
|---|---|
| Order V2 vs same Order V2 double click | exactly one approval/value effect; loser gets deterministic state conflict/idempotent result |
| Wallet V2 vs same Wallet V2 double click | exactly one wallet credit |
| V1 legacy fallback vs V2, same user/shared claim | no lock inversion or split-brain merge barrier; both acquire the new account guard first and preserve CLAIM-before-BALANCE relative order |
| V1 fallback vs Account Merge after guard migration | common account guard serializes them; no enabled V1 mutation remains `users`-only |
| Different Order approvals, same user | no user-profile mutex; serialize only shared points resource when points effect exists |
| Different Wallet top-ups, same user | serialize on wallet balance row; both can succeed exactly once |
| Order vs Wallet, same user | no `users` lock blocking; only genuinely shared account guard/financial resources interact |
| Order/Wallet vs OCR Recheck same subject | subject/evidence version decides; stale PREPARE aborts |
| Approval vs genuine slip replacement | replacement/evidence version race cannot bind old identifiers to new slip |
| Same storage key bytes changed after PREPARE | modern immutable contract prevents mutation; legacy path refuses fast commit |
| Two sources same referenceHash | unique claim permits one owner only |
| Two sources same fileHash | unique claim permits one owner only |
| Cross-axis overlap (A shares ref with B; B shares file with C) | no duplicate value, no deadlock; deterministic claim failure |
| Approval vs Account Merge prepare | common guard serializes correctly; either financial commit precedes authoritative merge snapshot or mutation sees guard and refuses |
| Points award/redeem concurrent with approval | dedicated points row prevents lost update |
| Wallet credit concurrent with wallet spend | wallet account row prevents lost update/overspend |
| Failure after claim but before financial write | whole transaction rolls back claim and value |
| Failure after status update before entitlement/credit | whole transaction rolls back |
| DB deadlock victim 1213 | safe whole-transaction retry policy only where idempotency proof exists |
| Lock timeout 1205 | no automatic immediate retry; fixed retryable API response and stage telemetry |
| PREPARE exceeds provider/storage timeout | no financial locks are held |
| Legacy backfill not trusted | V2 fast path refuses/falls back; never skips live compatibility requirement |

## 12. Performance/observability acceptance criteria

Before Preview cutover:

- zero external-I/O functions are statically reachable from V2 COMMIT;
- no V2 approval acquires `users FOR UPDATE` or `users LOCK IN SHARE MODE` as its financial/account-merge mutex;
- normal commit p95 target < 500 ms on Preview DB, p99 target < 1 s excluding DB infrastructure incidents;
- no normal approval request should approach the server's 50-second InnoDB lock-wait timeout;
- structured server telemetry records PREPARE duration and COMMIT duration separately;
- lock timeout telemetry names only whitelisted resource stages and never exposes SQL/params/credentials;
- metrics distinguish `PREPARE_STORAGE`, `PREPARE_LEGACY_COMPAT`, `COMMIT_ACCOUNT_GUARD`, `COMMIT_SUBJECT`, `COMMIT_BALANCE`, `COMMIT_CLAIM`, `COMMIT_FINALIZE`.

C03/C04 diagnostics stay in place during V2 shadow/Preview comparison.

## 13. Preview rollout / rollback plan

1. Deploy schema/guard/evidence prerequisites without route cutover.
2. Enable the mixed-mode bridge first: V1 classified/financial mutations and Account Merge both acquire the new account guard before any transitional legacy lock; migrate all coexisting points mutators to the new points balance resource.
3. Backfill/verify points balance and immutable slip evidence as required.
4. Require trusted anti-replay backfill readiness for V2 fast path.
5. Deploy Order V2 behind feature flag / separate internal endpoint.
6. Shadow PREPARE against eligible Preview subjects; compare V1/V2 classifications without creating value.
7. Enable Order V2 commit in Preview; retain V1 fallback only for explicit legacy class that already participates in the mixed-mode bridge.
8. Repeat for Wallet V2.
9. Run IPE-021-E real concurrency suite against the deployed schema, including V1/V2/Account Merge coexistence cases.
10. Observe lock waits, deadlocks, commit latency, claim conflicts, and rollback integrity.
11. Cut over public admin routes only after independent review + Final Verify.
12. Keep a one-switch rollback to bridged V1 until a stable Preview window passes.
13. Remove legacy approval architecture only in IPE-021-G after production-readiness verification.

## 14. Explicit non-solutions

The following do not solve the architectural problem and must not be used as the primary fix:

- increasing `innodb_lock_wait_timeout`;
- adding repeated automatic 1205 retries;
- moving only the current target hash outside the transaction while leaving legacy scan inside;
- removing Account Merge checks;
- trusting client-provided hashes/references;
- using `updatedAt` alone as the slip/evidence version;
- assuming random R2 object keys are immutable without enforcing write-once semantics;
- capping the historical legacy scan and treating “not found in first N rows” as proof of no replay.

## 15. Gate from IPE-021-A to implementation

IPE-021-A is complete when independent review agrees on these implementation decisions:

1. dedicated account mutation guard replaces `users` as Account Merge rendezvous;
2. mixed-mode bridge makes Account Merge, all still-enabled V1 classified mutations, and V2 rendezvous on that same guard before V2 enablement;
3. dedicated points balance/idempotency resource replaces `users` as points mutex for every coexisting points mutator;
4. modern slip evidence becomes immutable/versioned;
5. V2 fast path requires trusted anti-replay backfill readiness;
6. expensive conflict/legacy preparation runs outside financial commit locks;
7. COMMIT follows `ACCOUNT_GUARD -> SUBJECT -> CLAIM -> BALANCE -> LEAF` and is database-local;
8. V1 remains only as a temporary, explicitly classified **bridged** legacy fallback during rollout;
9. IPE-021-B and C build parallel engines before any admin route cutover.

## 16. Handoff sequence and dependency gate

The audit changes the safest implementation order from the original B/C-first sketch. B and C cannot fully remove the `users` mutex until the cross-cutting resources exist. The recommended execution order after A is therefore:

1. **IPE-021-D Foundation slice first:** dedicated Account Merge guard, points balance/idempotency, immutable evidence/version prerequisites, anti-replay backfill readiness gate and migrations. This is infrastructure only; no public approval cutover.
2. **IPE-021-B:** Order Approval V2 engine + tests against the new resources, no public cutover.
3. **IPE-021-C:** Wallet Approval V2 engine + tests against the new resources, no public cutover.
4. **IPE-021-E:** full real-DB concurrency/failure matrix across Order, Wallet, OCR, Points and Account Merge.
5. **IPE-021-F:** Preview shadow/cutover with telemetry and rollback switch.
6. **IPE-021-G:** legacy removal, full regression, Final Verify and merge gate.

B/C interface scaffolding may be explored in parallel, but neither engine may be declared complete or Preview-eligible while it still depends on `users FOR UPDATE` / `LOCK IN SHARE MODE` as its common approval mutex or while modern slip evidence lacks the required immutability/version proof.
