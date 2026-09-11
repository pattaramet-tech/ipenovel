# M06 operational evidence collection and controlled Preview execution readiness

Status: **readiness audit only**. This document does not authorize publish execution, legacy retirement, ZIP fallback removal, rollback, cutover, or Production mutation.

Audited source baseline: `e56837b72aa48ac4551f2df0ea625dce6be8aa3f` (`integrate/workspace-m06-main-39b9792`).

## Preview baseline under review

Candidate:

- `workspaceId=2`
- `workspaceNovelId=2`
- `novelId=4020002`
- current synthetic `publishRunId=2`
- publish ownership `workspace / cutoverEpoch=1 / version=2`
- latest ownership transition is the initial `sheets/0/v1 -> workspace/1/v2` cutover
- current receipt is synthetic: `preview-m06-positive-synthetic-receipt`

Control:

- `workspaceNovelId=1`
- `novelId=4020003`
- publish ownership `sheets / cutoverEpoch=2 / version=3`
- two transitions: initial cutover followed by rollback

The current Preview runtime must remain `WORKSPACE_PUBLISH_EXECUTION_ENABLED=false` until a later, separate authorization explicitly permits a controlled side-effect window.

## What the current M05-B implementation already guarantees

These statements are derived from the current repository implementation and tests.

1. `requestPublishExecution` fails closed when execution is disabled, requires owner/editor membership, validates an active destination and current publish hash, and requires exactly one Workspace-owned publish registry row at the caller's expected cutover epoch.
2. Enqueue is transactional: a run transitions to `publishing` and a deterministic outbox row is created with the expected ownership epoch. The outbox identity is deterministic for the publish run.
3. Outbox claim is atomic and lease-bounded. A claim rechecks Workspace ownership at the outbox epoch before the row is claimed.
4. Worker processing rechecks ownership and the expected last-published hash before processing, again before provider reconciliation, and again before provider execution when reconciliation has no receipt.
5. Item request keys are deterministic from run, destination, policy version, item identity and source hash.
6. The provider contract is reconcile-first. A receipt discovered by reconciliation prevents a second provider execution.
7. A successful provider receipt is persisted while the item is still `publishing`, before terminal `published` state. If a worker later sees a `publishing` item with a persisted receipt, it terminalizes the item without calling the provider.
8. Already-published items with receipts are skipped on retry. Partial failure retry therefore preserves succeeded items and retries only unfinished work.
9. Finalization requires the active outbox lease, rechecks ownership at the outbox epoch and rechecks the current publish hash. A fully receipt-backed run delivers the outbox; partial/failed runs leave it retryable.
10. The M05-B service itself contains no network SDK and no direct `novels`/`episodes` write. External delivery is intentionally behind a provider port.

## Blocking gaps found by this audit

**Do not authorize `WORKSPACE_PUBLISH_EXECUTION_ENABLED=true` yet.** The current code is not capable of producing trustworthy operational publish evidence for the candidate.

### B1 — no external publish provider implementation

`WorkspacePublishProvider` is an interface only. The repository has M05-B mock-provider integration coverage, but no concrete external publish adapter is wired for Workspace publish execution. Consequently there is no reviewed implementation that can turn a Workspace publish request into the intended IpeNovel publication mutation and reconciliation receipt.

### B2 — no runtime publish worker

`claimPublishOutbox` and `processClaimedPublishOutbox` are internal service functions and are exercised by integration tests, but no runtime worker/runner invokes them. The authenticated router exposes `requestExecution`, which can enqueue an outbox row, but enqueue alone cannot deliver it.

### B3 — current `publishRunId=2` is synthetic and cannot prove provider execution

Run 2 already contains a synthetic `published` item with a synthetic receipt. M05-B deliberately skips an already-published receipt-backed item, so running M05-B against run 2 would not call `provider.execute`. Operational evidence requires a **fresh run with a pending item** created after the provider/worker prerequisites are deployed.

### B4 — `lastPublishedSha256` is not advanced by M05-B execution

The current execution service validates `workspaceDocumentFingerprints.lastPublishedSha256`, but does not update that projection after a successful publish. Tests mutate the field directly only to exercise stale-hash rejection. Before operational rollout, ownership of this projection update must be defined and implemented atomically/safely so the next publish can use the real last-published hash rather than a stale `null` projection.

### B5 — execution ownership checks use owner + epoch, not registry version

M05-D cutover/rollback uses exact owner/epoch/version CAS. M05-B worker checks exact owner + epoch but does not accept or recheck an expected registry `version`. The controlled Preview run therefore needs an operator pre/post invariant for `version=2`; a production-ready scoped execution design should decide whether version belongs in the worker fence as well.

### B6 — the execution feature flag is global

The router derives execution permission from the global `WORKSPACE_PUBLISH_EXECUTION_ENABLED` flag. There is no per-workspace/per-run allowlist. A controlled Preview window should not rely on a global switch alone; a narrow execution scope for the exact candidate/fresh run is a prerequisite before a real provider is enabled.

### B7 — M06 operational evidence is declarative, not measured

The M06 gate accepts four `{passed,evidenceRef}` inputs. It verifies that `passed=true` and the reference is non-empty, but it does not verify the referenced measurements. Therefore a green M06 gate is not, by itself, proof that sustained parity, SLO, rollback drill or legacy-action freeze actually occurred.

### B8 — sustained parity/SLO thresholds are not defined in the repository

The coexistence strategy names `sustained parity/SLO` as the Phase 4 exit condition, but does not define a sample count, observation duration, success/error threshold or latency objective. Those policy thresholds must be explicitly approved before evidence can truthfully be marked passed.

### B9 — legacy-action freeze requires evidence outside Workspace DB

The Workspace database can prove Workspace ownership/history and publish receipts, but it cannot prove that the Google Sheets/Apps Script legacy path performed no new actions for the approved novel. That evidence must come from the legacy controls/logs or an explicit operator freeze procedure.

### B10 — no attempts cap/dead-letter transition is implemented in M05-B worker flow

The schema has `dead_letter`, but the current M05-B service retries failed outbox rows without an attempts ceiling that transitions them to dead-letter. A controlled one-shot Preview window can be operated fail-closed by stopping after the agreed attempt count, but durable operational policy should be implemented before broad rollout.

## Evidence classification

### Evidence already available — synthetic only

The following is useful contract/rehearsal evidence but must not be relabeled as operational publication evidence:

- M05-E Preview final-gate synthetic package and deterministic digest.
- M05-D read-only cutover/rollback rehearsal.
- M05-D actual Preview ownership cutover + rollback on control `workspaceNovelId=1`, including receipt preservation.
- M06 negative-path Preview smoke on the rolled-back control.
- M06 positive-path synthetic gate smoke on `workspaceNovelId=2`.
- Candidate package digest `11774512eb567f4bf425a0fe9c89812f0a03a42dcd6b71baeacd80f64c09c0ba`.
- Candidate synthetic receipt `preview-m06-positive-synthetic-receipt`.

These prove contracts, fail-closed behavior and ownership transitions; they do **not** prove an external publish side effect, provider latency, operational error rate, sustained parity, or legacy-action freeze.

### Operational evidence still required

For each real controlled Preview publish run, capture at minimum:

- exact workspace/novel/destination/run/snapshot IDs;
- ownership owner, epoch and version before enqueue and after finalization;
- run idempotency key and deterministic per-item request key(s);
- expected and observed last-published hashes;
- item counts and terminal states;
- provider reconcile outcome and execute-call count per request key;
- provider receipt for every published item;
- outbox ID, ownership epoch, attempts, status, `availableAt`, `deliveredAt` and final backlog count;
- run terminal state and duration evidence;
- target-side reconciliation proving the intended published identity/content version matches the planned source;
- control `workspaceNovelId=1` ownership/history unchanged;
- explicit legacy-side evidence showing no legacy action for candidate novel during the window.

## Proposed evidence policy — requires operator approval

The repository does not define numeric parity/SLO thresholds. The following is a **proposal**, not an existing M06 rule and not yet an approved pass criterion.

1. **Parity:** every controlled run must have zero missing, unexpected, duplicate or hash-mismatched target items; every published item must have a durable receipt and reconcile to the same provider identity on retry.
2. **Reliability:** no duplicate provider execution for the same deterministic request key; no published item may end without a receipt; final outbox backlog must be zero.
3. **SLO:** choose and record an operator-approved maximum enqueue-to-delivered duration and an observation/sample requirement before the first real execution. Do not retroactively choose a threshold after seeing results.
4. **Sustained evidence:** choose and record the required number of consecutive runs and/or observation duration before execution. One successful run proves execution correctness, not "sustained" behavior.
5. **Legacy freeze:** record the exact freeze start/end timestamps and the legacy-side log/control reference showing zero new legacy actions for candidate `novelId=4020002` during that interval.
6. **Rollback:** the existing Preview rollback drill may be referenced only as rollback-drill evidence; it does not substitute for parity/SLO/freeze evidence.

## Required implementation work before a real execution authorization

Complete and verify these prerequisites locally first, then obtain separate approval to push/deploy them to Preview without enabling execution:

1. Implement a concrete Workspace publish provider adapter with deterministic reconciliation and a durable provider receipt. The adapter must use the existing IpeNovel publication application boundary; do not add hidden direct writes in the M05-B orchestration service.
2. Implement a runtime one-shot/worker entry point for claim -> reconcile/execute -> finalize with bounded lease and explicit logging/receipts.
3. Add a narrow Preview execution scope that binds authorization to the intended `workspaceId`, `workspaceNovelId`, fresh `runId`, expected cutover epoch and preferably expected registry version. The global flag must not be the sole scope control.
4. Define and implement the successful-publication update contract for `lastPublishedSha256`, including crash/reconcile behavior and optimistic concurrency.
5. Define a bounded retry/dead-letter policy suitable for operational use.
6. Add observability sufficient to distinguish reconcile hits, provider execute calls, receipts, attempts, terminal status and durations without logging document bodies or credentials.
7. Pin the operator-approved parity/SLO/sustained-window policy in a versioned evidence record or equivalent immutable artifact rather than accepting an unexplained boolean.

All of that implementation work must be tested before any real Preview side effect is enabled.

## Fail-closed Preview preflight

Run `scripts/workspace-m06-preview-baseline.mts` inside the Preview application container while execution is still disabled. It performs SELECT-only database checks for the exact candidate/control state and exits non-zero on any drift.

Expected preflight outcome at the current synthetic checkpoint:

```text
baselinePass=true
executionEnabled=false
candidate=workspace/epoch1/version2
candidateRun2=synthetic published receipt, no outbox
control=sheets/epoch2/version3, two transitions
```

A baseline PASS does **not** mean execution is authorized; it only proves that the known checkpoint has not drifted.

## Controlled Preview execution window — sequence after prerequisites are deployed

The sequence below is the intended operating order. It must not be started until the provider/worker/scope/hash-update prerequisites above are implemented, reviewed, pushed and deployed with execution still disabled.

1. Run the read-only baseline preflight and save its JSON output.
2. Confirm the exact approved evidence policy/window before any side effect.
3. With execution still disabled, create a **fresh** candidate snapshot/dry-run whose item is pending and whose expected last-published hash matches the current projection. Never reuse synthetic run 2 as operational proof.
4. Read back and record fresh run/item/destination/ownership state. Assert candidate ownership is still `workspace / epoch1 / version2` and control remains `sheets / epoch2 / version3`.
5. Obtain the separate execution authorization described below.
6. Enable the scoped Preview execution switch for only the approved candidate/fresh run. Keep Production unchanged.
7. Enqueue the fresh run once, claim it once, reconcile-first, execute only if reconciliation has no receipt, persist receipt, and finalize.
8. Immediately disable execution again after the approved run/window. Do not leave the global switch enabled for evidence collection convenience.
9. Run postflight SELECT-only checks: receipt integrity, request/idempotency identity, outbox delivered/backlog zero, updated last-published hash, candidate ownership/version unchanged, control ownership/history unchanged.
10. Reconcile against the target-side publication state and capture legacy-freeze evidence.
11. Repeat only to the pre-approved sustained-evidence requirement. Every additional side-effect run requires that it falls inside the explicitly approved window/scope.
12. Feed the measured evidence references into M06 only after the measurements satisfy the policy. M06 must still return `separateHumanApprovalRequired=true`, `retirementApplied=false`, and retain legacy/ZIP/read-export fallback.

## Authorization boundaries

### Authorization needed next — prerequisite implementation/deploy, not execution

The current audit is blocked before real execution. The next useful approval should authorize implementation of the missing provider/worker/scope/hash/observability prerequisites and, later, their Preview deploy **with `WORKSPACE_PUBLISH_EXECUTION_ENABLED=false`**.

Suggested authorization wording:

> อนุญาตให้ implement M06/M05-B operational publish prerequisites แบบ Automation Loop: external publish provider adapter, bounded runtime worker, exact Preview execution scope, lastPublishedSha256 success contract, retry/dead-letter policy และ observability; local commit onlyก่อน และห้าม provider side effect/ห้ามเปิด WORKSPACE_PUBLISH_EXECUTION_ENABLED=true. หลัง review ขออนุญาต push/deploy Preview แยกอีกครั้ง.

### Separate authorization required later — real Preview side effect

Only after those prerequisites are deployed and the read-only preflight passes should the execution authorization be requested. It must name the exact fresh run, not run 2.

Template:

> อนุญาตเปิด WORKSPACE_PUBLISH_EXECUTION_ENABLED=true ชั่วคราวเฉพาะ Controlled Preview execution window สำหรับ workspaceId=2 / workspaceNovelId=2 / novelId=4020002 / fresh runId=<RUN_ID> / expectedCutoverEpoch=1 / expectedOwnershipVersion=2 ตาม scoped allowlist ที่ deploy แล้ว; อนุญาต provider side effect ตาม run นี้เท่านั้น และให้ปิด execution ทันทีหลัง postflight. ห้าม Production, rollback, legacy retirement หรือ ZIP fallback removal.

Without that exact later authorization, no publish side effect is permitted.
