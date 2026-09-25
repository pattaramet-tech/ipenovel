import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../core";
import {
  NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION,
  NqaControlledRolloutScopeSchema,
} from "./contracts";
import {
  buildNqaControlledRolloutScope,
  resolveNqaRuntimeAlignmentPolicy,
} from "./resolver";
import {
  BASE_POLICY,
  buildActivatedRolloutFixture,
  rollbackActivatedFixture,
} from "./testSupport";

describe("NQA M18 controlled runtime policy resolver", () => {
  it("selects candidate and dual-run only for an explicitly approved target", async () => {
    const { store, scope, fixture } = await buildActivatedRolloutFixture();

    const inScope = await resolveNqaRuntimeAlignmentPolicy({
      store,
      scope,
      row: 2,
      chapter: 197,
    });
    expect(inScope).toMatchObject({
      mode: "CONTROLLED_CANDIDATE",
      selectedPolicy: "CANDIDATE",
      inScope: true,
      dualRun: true,
      candidatePolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    expect(inScope.primaryPolicy).toEqual(fixture.materializedPolicy.policy);

    const outOfScope = await resolveNqaRuntimeAlignmentPolicy({
      store,
      scope,
      row: 3,
      chapter: 197,
    });
    expect(outOfScope).toMatchObject({
      mode: "BASELINE_ONLY",
      selectedPolicy: "BASELINE",
      inScope: false,
      dualRun: false,
    });
    expect(outOfScope.primaryPolicy).toEqual(BASE_POLICY);
  });

  it("suppresses an activated candidate globally when no rollout scope is supplied", async () => {
    const { store, fixture } = await buildActivatedRolloutFixture();
    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store,
      row: 2,
      chapter: 197,
    });

    expect(resolution.selectedPolicy).toBe("BASELINE");
    expect(resolution.primaryPolicy).toEqual(BASE_POLICY);
    expect(resolution.candidatePolicy).toEqual(
      fixture.materializedPolicy.policy
    );
    expect(resolution.dualRun).toBe(false);
  });

  it("returns the restored baseline immediately after an M17 rollback even if the old scope object still exists", async () => {
    const { store, scope, transactionId } =
      await buildActivatedRolloutFixture();
    await rollbackActivatedFixture({ store, transactionId });

    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store,
      scope,
      row: 2,
      chapter: 197,
    });
    expect(resolution).toMatchObject({
      mode: "ROLLED_BACK_BASELINE",
      selectedPolicy: "BASELINE",
      dualRun: false,
    });
    expect(resolution.primaryPolicy).toEqual(BASE_POLICY);
  });

  it("fails closed for a validly rehashed scope bound to another registry state", async () => {
    const first = await buildActivatedRolloutFixture({
      transactionId: "m18-activate-a",
      scopeId: "scope-a",
    });
    const second = await buildActivatedRolloutFixture({
      transactionId: "m18-activate-b",
      scopeId: "scope-b",
    });

    const { scopeFingerprint: _ignored, ...payload } = first.scope;
    const forgedPayload = {
      ...payload,
      expectedRegistryStateFingerprint: second.state.stateFingerprint,
    };
    const forged = NqaControlledRolloutScopeSchema.parse({
      ...forgedPayload,
      scopeVersion: NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION,
      scopeFingerprint: hashCanonicalJson({
        scope: "nqa:controlled-rollout-scope:v1",
        ...forgedPayload,
      }),
    });

    await expect(
      resolveNqaRuntimeAlignmentPolicy({
        store: second.store,
        scope: forged,
        row: 2,
        chapter: 197,
      })
    ).rejects.toThrow("scope is stale");
  });

  it("normalizes and bounds rollout targets deterministically", async () => {
    const { state } = await buildActivatedRolloutFixture();
    const scope = buildNqaControlledRolloutScope({
      state,
      scopeId: "sorted-scope",
      approvedBy: "operator",
      approvedAt: "2026-09-24T22:02:00+07:00",
      targets: [
        { row: 3, chapter: 2 },
        { row: 2, chapter: 9 },
        { row: 3, chapter: 2 },
      ],
    });
    expect(scope.targets).toEqual([
      { row: 2, chapter: 9 },
      { row: 3, chapter: 2 },
    ]);
  });
});
