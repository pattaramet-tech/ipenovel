# M17 — Explicit Candidate Activation Transaction + Rollback Contract

## Purpose

M17 introduces the first NQA component that is allowed to represent an active
policy change.

It does not silently enable production mutation. Instead it defines a
transaction boundary that requires all of the following at the same time:

1. valid M16 `READY_FOR_EXPLICIT_ACTIVATION_REVIEW` evidence
2. the exact M16 materialized candidate artifact linked to that readiness
3. explicit human authorization bound to the current registry state
4. a compare-and-swap match against the current active policy revision
5. an enabled `PRODUCTION_MUTATION` control-plane tier

The default NQA V1 enabled permission tiers remain:

- `READ`
- `QA_OPERATE`

Therefore the M17 production capabilities exist but remain disabled by default.

## Production capabilities

M17 adds:

- `nqa.policy.activate_candidate`
- `nqa.policy.rollback`

Both require:

`PRODUCTION_MUTATION`

and have effect:

`PRODUCTION_MUTATION`

Because `PRODUCTION_MUTATION` is not present in
`NQA_V1_ENABLED_PERMISSION_TIERS`, an actor with that permission is still
denied with `TIER_DISABLED` unless the tier is explicitly enabled by the
calling environment.

M17 does not change the default enabled tiers.

## Human authorization contract

Activation and rollback require explicit authorization artifacts.

### Activation authorization

The approval statement is fixed:

`I_APPROVE_NQA_POLICY_ACTIVATION`

The authorization binds:

- authorization ID
- authorizer ID
- action = ACTIVATE
- current registry revision
- current active-policy fingerprint
- target candidate-policy fingerprint
- M16 readiness artifact fingerprint
- approval timestamp
- validity deadline

### Rollback authorization

The approval statement is fixed:

`I_APPROVE_NQA_POLICY_ROLLBACK`

The authorization binds:

- authorization ID
- authorizer ID
- action = ROLLBACK
- current registry revision
- current active-policy fingerprint
- exact rollback-target fingerprint
- source activation transaction ID
- approval timestamp
- validity deadline

Authorization artifacts have deterministic fingerprints.

The fingerprint protects artifact integrity and intent binding. It is not a
replacement for identity authentication or a cryptographic human signature.
The surrounding control plane is responsible for authenticating the actor
represented by `authorizerId`.

## Authorization validity window

Every authorization is bounded by:

- `approvedAt`
- `validUntil`

A new activation/rollback commit must occur inside that interval.

Expired or not-yet-valid approvals fail closed.

A previously committed transaction may still be returned idempotently after
the window expires; this does not execute another mutation.

## M16 readiness verification

M17 recomputes the M16 activation-readiness artifact fingerprint.

Activation requires:

- decision = `READY_FOR_EXPLICIT_ACTIVATION_REVIEW`
- zero readiness failure reasons
- `requireDistinctShadowDataset = true`
- `requireShadowPromote = true`
- `requireInactiveCandidate = true`

M17 then verifies the supplied materialized candidate artifact and checks:

- readiness materialization fingerprint matches the candidate artifact
- readiness candidate-policy fingerprint matches the candidate policy
- readiness candidate version matches the candidate version

A HOLD or linkage mismatch cannot enter an activation transaction.

## Active-policy registry

M17 does not overwrite:

`server/nqa/semantic/alignment/policy.ts`

Instead it introduces a dedicated active-policy registry.

Registry state contains:

- schema version
- monotonic revision
- active policy version
- active policy fingerprint
- complete active policy
- optional rollback target
- last transaction ID
- deterministic state fingerprint

The registry genesis state is revision 0 with the explicitly supplied initial
policy.

## Append-only transaction journal

The durable registry uses:

```text
<activation-root>/
  genesis.json
  transaction.lock
  events/
    00000001-<transactionId>-<eventFingerprint>.json
    00000002-<transactionId>-<eventFingerprint>.json
    ...
```

`genesis.json` is create-only.

Each transaction event is also create-only.

Current registry state is reconstructed by validating and reducing the
append-only journal. There is no mutable `active-policy.json` file that is
blindly overwritten.

## Compare-and-swap

Every mutation binds to:

- expected registry revision
- expected registry-state fingerprint
- expected active-policy fingerprint

The store serializes durable commits with an exclusive transaction lock.

After obtaining the lock it reconstructs the current journal state and applies
the transaction only if the expected state is still current.

If another transaction wins first, the losing transaction returns a conflict
and fails closed.

## Activation transaction

An activation transaction verifies:

1. M16 readiness artifact integrity
2. M16 materialized candidate integrity
3. readiness/candidate linkage
4. current active policy equals the candidate's M16 base policy
5. human authorization fingerprint
6. authorization validity window
7. authorization revision/current-policy binding
8. authorization readiness binding
9. authorization target equals the candidate policy
10. compare-and-swap state match

The resulting active policy is exactly the M16 materialized candidate policy.

## Immediate rollback target

During activation, M17 copies the complete previous active policy into the new
registry state's rollback target.

The rollback target records:

- previous policy version
- previous policy fingerprint
- complete previous policy
- source activation transaction ID
- M16 readiness fingerprint that authorized the activation

This means rollback does not reconstruct or approximate the old policy. It
restores the exact policy artifact that was active immediately before the
activation.

## Rollback transaction

Rollback requires a separate explicit human approval.

The authorization must identify the exact activation transaction that created
the rollback target.

Rollback verifies:

- current state still contains that rollback target
- authorization current revision/fingerprint matches
- authorization target equals the preserved rollback target
- source activation transaction matches
- authorization is inside its validity window
- compare-and-swap still succeeds

The resulting active policy is the exact preserved previous policy.

After a successful rollback the rollback target is cleared.

This makes the M17 rollback one-shot rather than an uncontrolled policy toggle.

A future roll-forward requires a new activation transaction and new human
authorization.

## Idempotency

Transaction IDs are unique journal identities.

Repeating the exact same transaction ID and intent returns the existing
committed event without adding a second event.

Reusing the same transaction ID with different:

- action
- authorization
- target policy

fails closed.

## Audit provenance

Every committed event records:

- transaction ID
- kind: ACTIVATE or ROLLBACK
- complete human authorization artifact
- previous/next revisions
- previous registry-state fingerprint
- previous active version/fingerprint
- resulting registry state
- commit timestamp
- M16 readiness artifact for activation
- M16 materialized artifact fingerprint for activation
- source activation transaction for rollback
- deterministic event fingerprint

The journal reducer validates the complete chain.

## Semantic transition validation

M17 does not rely only on hashes.

When replaying or appending an event, the registry verifies transition
semantics.

For ACTIVATE:

- authorization action must be ACTIVATE
- authorization target must equal resulting active policy
- resulting active policy must equal the M16-ready candidate
- materialized-artifact linkage must match readiness
- rollback target must exactly preserve the previous active policy
- rollback target must reference the current activation transaction

For ROLLBACK:

- authorization action must be ROLLBACK
- previous state must have a rollback target
- source activation linkage must match
- target must equal the preserved rollback policy
- resulting active policy must exactly equal the rollback target
- resulting rollback target must be null

Therefore an attacker or bug cannot make an arbitrary transition acceptable
merely by recomputing the event hash.

## Durable store

M17 provides:

- `InMemoryNqaPolicyActivationStore`
- `JsonFileNqaPolicyActivationStore`

The JSON store uses an exclusive create-only lock file around
compare-and-append.

Transaction events are written with create-only `wx` semantics.

If the process crashes while holding the lock, later attempts fail closed after
the bounded lock-acquisition timeout rather than proceeding without
serialization.

Operational stale-lock recovery is intentionally deferred to later operational
hardening.

## Isolation boundary

M17 production activation code does not:

- write Google Docs
- write Google Sheets
- modify novel/source/translation content
- register HTTP routes/listeners
- import a production database/ORM
- import the static active M10 policy module
- modify `DEFAULT_NQA_ALIGNMENT_POLICY`
- call `mergeNqaAlignmentPolicy`

Its filesystem mutation is limited to the dedicated activation registry.

## Important distinction

M17 creates a safe activation transaction mechanism.

This milestone does **not** enable `PRODUCTION_MUTATION` in the default NQA V1
control plane and does not execute a real production activation as part of the
milestone tests.

A real activation still requires an explicit environment decision to enable the
production tier plus a fresh human authorization artifact.

## Relationship to M18

Recommended next milestone:

**M18 — Controlled Production Activation + Dual-Run Monitoring**

M18 should integrate the M17 active-policy registry with policy resolution in
the runtime, activate a candidate only in a controlled scope, preserve the M17
rollback path, and monitor old/new behavior during a bounded production soak.
