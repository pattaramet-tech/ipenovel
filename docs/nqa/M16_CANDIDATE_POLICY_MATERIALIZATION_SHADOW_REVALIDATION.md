# M16 — Candidate Policy Materialization + Controlled Shadow Revalidation

## Purpose

M16 is the safety boundary between an M15 threshold candidate that passed
offline calibration and any future production activation.

It performs three distinct operations:

1. materialize the M15 candidate as a new full M10 alignment-policy artifact
2. revalidate that inactive candidate against an explicitly supplied bounded
   human-confirmed shadow dataset
3. produce activation-readiness evidence for a separate explicit review

M16 does not activate the candidate.

## Required upstream evidence

M16 starts from an explicit M15 promotion artifact.

The artifact must:

- parse as the current M15 promotion schema
- have a valid deterministic artifact fingerprint
- contain valid baseline/candidate profile fingerprints
- have decision `PROMOTE`
- have no promotion failure reasons

A `HOLD` artifact cannot be materialized.

## Promotion-artifact integrity

M16 recomputes the M15 promotion artifact fingerprint from the complete payload:

- calibration/source dataset fingerprints
- baseline/candidate profiles
- profile fingerprints
- promotion criteria
- baseline/candidate metrics
- false-PASS deltas
- failure reasons
- promotion decision

It also recomputes both M15 profile fingerprints.

This makes accidental or unreviewed artifact mutation detectable before
materialization.

The fingerprints are deterministic integrity identifiers, not external
cryptographic signatures.

## Base-policy binding

M15 intentionally calibrates only the M10 thresholds that can be replayed from
bounded M14 score evidence.

M16 therefore requires the caller to supply the full source M10 alignment
policy that the M15 baseline represented.

M16 verifies:

- base policy version equals M15 baseline source-policy version
- base policy version equals M15 candidate source-policy version
- all replayable threshold values in the base policy equal the M15 baseline

If any of these checks fails, materialization is rejected.

## Candidate policy materialization

M16 copies the full validated base policy and changes only the replayable
threshold fields promoted by M15.

The following M10 fields are inherited unchanged from the base policy:

- `targetChunkChars`
- `maxChunkChars`
- `denseTopK`
- `maxRerankPairs`
- `lowScoreThreshold`

The candidate receives a new version.

When the caller does not provide a version explicitly, M16 derives one
deterministically from the M15 candidate-profile fingerprint:

`nqa-alignment-candidate-<fingerprint-prefix>`

The candidate version cannot equal the source-policy version.

## Inactive and immutable boundary

Every M16 candidate-policy artifact has:

`state = INACTIVE`

The materialized policy and outer artifact are frozen after validation with
`Object.freeze()`.

The artifact also records:

- materialization schema version
- candidate policy version
- source policy version
- reranker version
- M15 promotion artifact fingerprint
- M15 calibration dataset fingerprint
- M15 candidate-profile fingerprint
- base policy fingerprint
- materialized policy fingerprint
- deterministic materialization artifact fingerprint

A mutated or reconstructed artifact is revalidated before downstream use.

## M14 curation-export integrity

Controlled shadow revalidation does not trust the supplied M14
`datasetFingerprint` field by itself.

M16 recomputes the M14 curation-export fingerprint from:

- export version
- run ID
- batch fingerprint
- case counts
- curated cases and labels

A mismatch blocks shadow replay.

## Controlled shadow revalidation

M16 shadow revalidation is an offline counterfactual replay over a supplied M14
curation export.

It does not call the reranker again because M15 candidates can change only the
M10 decision thresholds that are exactly replayable from the bounded M14 M10
score snapshot.

The revalidation:

1. verifies M15 promotion integrity
2. verifies materialized-policy integrity and linkage to that M15 promotion
3. verifies M14 curation-export integrity
4. rebuilds a replay profile from the materialized full policy
5. confirms the rebuilt candidate-profile fingerprint equals the M15 promoted
   candidate profile
6. runs M15 calibration again on the supplied shadow export
7. runs the M15 promotion gate with the **same M15 criteria**

M16 exposes no criteria override for shadow promotion.

A caller cannot reduce the M15 threshold gate inside M16.

## Shadow evidence

The shadow revalidation artifact records:

- source M15 promotion artifact fingerprint
- materialized-policy artifact fingerprint
- materialized policy fingerprint
- original M15 source dataset fingerprint
- shadow M14 source dataset fingerprint
- shadow calibration dataset fingerprint
- whether the shadow dataset is distinct from the original M15 dataset
- unchanged M15 promotion criteria
- shadow baseline metrics
- shadow candidate metrics
- M15 gate failure reasons
- shadow gate decision
- deterministic revalidation artifact fingerprint

## Why a distinct shadow dataset matters

Replaying the same M14 dataset that produced the original M15 promotion is
useful for reproducibility, but it is not independent revalidation.

Therefore M16 records:

`datasetIsDistinctFromPromotion`

The final activation-readiness gate requires this value to be true.

A same-dataset replay may still reproduce `PROMOTE`, but activation readiness
remains `HOLD`.

## Fixed activation-readiness gate

M16 uses three fixed guards:

- `requireDistinctShadowDataset = true`
- `requireShadowPromote = true`
- `requireInactiveCandidate = true`

There is no caller override that can disable them.

The readiness result can be:

- `READY_FOR_EXPLICIT_ACTIVATION_REVIEW`
- `HOLD`

It can never return `ACTIVE`.

Failure reasons include:

- `M15_PROMOTION_NOT_PROMOTE`
- `CANDIDATE_NOT_INACTIVE`
- `SHADOW_DATASET_NOT_DISTINCT`
- `SHADOW_GATE_NOT_PROMOTE`
- `ARTIFACT_LINKAGE_MISMATCH`

The readiness artifact also carries through the detailed M15 shadow-gate
failure reasons.

## Artifact linkage

Before readiness evaluation, M16 verifies that:

- materialized candidate references the supplied M15 promotion
- shadow revalidation references the same M15 promotion
- shadow revalidation references the same materialization artifact
- shadow policy fingerprint equals the materialized policy fingerprint

A linkage mismatch produces `HOLD`.

## No-activation boundary

M16 is deliberately unable to activate production policy.

Production code under `server/nqa/candidatePolicy/` contains no:

- active-policy mutation API
- Google Docs/Sheets write
- filesystem write
- application listener/router
- database/Drizzle dependency
- import of the active M10 alignment policy module

The control-plane capabilities are read-only:

- `nqa.candidate_policy.materialize`
- `nqa.candidate_policy.shadow_revalidate`
- `nqa.candidate_policy.activation_readiness`

## Relationship to the current active M10 policy

M16 does not modify:

`server/nqa/semantic/alignment/policy.ts`

It also does not import the active default or the policy merge helper from that
module.

The full base policy is an explicit input, which allows its content and
provenance to be verified without silently reading or changing the current
default.

## Current milestone state

M16 implements and verifies the materialization, revalidation, and readiness
machinery.

This milestone does not claim that a real production candidate is currently
ready for activation. A real `READY_FOR_EXPLICIT_ACTIVATION_REVIEW` artifact
requires:

1. a real M15 `PROMOTE` artifact
2. the exact corresponding full source policy
3. a valid, distinct M14 human-confirmed shadow export
4. a shadow `PROMOTE` under the unchanged M15 criteria

No active NQA threshold is changed in M16.

## Next milestone

Recommended next step:

**M17 — Explicit Candidate Activation Transaction + Rollback Contract**

M17 should accept only a valid M16
`READY_FOR_EXPLICIT_ACTIVATION_REVIEW` artifact, define an explicit human
activation action, keep the previous policy as a rollback target, and separate
activation from rollback verification.
