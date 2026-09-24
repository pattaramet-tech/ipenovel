import { describe, expect, it } from "vitest";

import {
  buildNqaHumanPolicyAuthorization,
  verifyNqaPolicyTransactionEvent,
} from "./integrity";
import { InMemoryNqaPolicyActivationStore } from "./store";
import {
  activateNqaCandidatePolicy,
  rollbackNqaActivePolicy,
} from "./transaction";
import {
  BASE_POLICY,
  buildActivationAuthorization,
  buildReadyActivationFixture,
  buildRollbackAuthorization,
} from "./testSupport";

describe("NQA M17 activation transaction", () => {
  it("activates only an M16-ready candidate and preserves the exact previous policy as rollback target", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const authorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });

    const event = await activateNqaCandidatePolicy({
      store,
      transactionId: "activate-001",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });

    expect(event.kind).toBe("ACTIVATE");
    expect(event.previousRevision).toBe(0);
    expect(event.nextRevision).toBe(1);
    expect(event.resultingState.activePolicyVersion).toBe(
      fixture.materializedPolicy.candidatePolicyVersion
    );
    expect(event.resultingState.activePolicyFingerprint).toBe(
      fixture.materializedPolicy.policyFingerprint
    );
    expect(event.resultingState.rollbackTarget).toMatchObject({
      policyVersion: BASE_POLICY.version,
      sourceActivationTransactionId: "activate-001",
      sourceReadinessArtifactFingerprint: fixture.readiness.artifactFingerprint,
    });
    expect(event.resultingState.rollbackTarget?.policy).toEqual(BASE_POLICY);
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("is idempotent for the exact same transaction intent", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const authorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    const input = {
      store,
      transactionId: "activate-idempotent",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    } as const;

    const first = await activateNqaCandidatePolicy(input);
    const second = await activateNqaCandidatePolicy(input);

    expect(second).toEqual(first);
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("rejects expired human authorization and mismatched readiness linkage", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const expired = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
      approvedAt: "2026-09-24T21:00:00+07:00",
      validUntil: "2026-09-24T21:05:00+07:00",
    });

    await expect(
      activateNqaCandidatePolicy({
        store,
        transactionId: "activate-expired",
        readiness: fixture.readiness,
        materializedPolicy: fixture.materializedPolicy,
        authorization: expired,
        committedAt: "2026-09-24T22:01:00+07:00",
      })
    ).rejects.toThrow("outside its validity window");

    const state = await store.readState();
    const wrongReadiness = buildNqaHumanPolicyAuthorization({
      authorizationId: "approve-wrong-readiness",
      authorizerId: "human-reviewer-a",
      action: "ACTIVATE",
      approvalStatement: "I_APPROVE_NQA_POLICY_ACTIVATION",
      expectedRegistryRevision: state.revision,
      expectedActivePolicyFingerprint: state.activePolicyFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
      readinessArtifactFingerprint: "0".repeat(64),
      sourceActivationTransactionId: null,
      approvedAt: "2026-09-24T22:00:00+07:00",
      validUntil: "2026-09-24T22:10:00+07:00",
    });

    await expect(
      activateNqaCandidatePolicy({
        store,
        transactionId: "activate-wrong-readiness",
        readiness: fixture.readiness,
        materializedPolicy: fixture.materializedPolicy,
        authorization: wrongReadiness,
        committedAt: "2026-09-24T22:01:00+07:00",
      })
    ).rejects.toThrow("authorization readiness linkage mismatch");
  });

  it("fails closed when two activation intents race from the same registry revision", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const state = await store.readState();
    const makeAuthorization = (id: string) =>
      buildNqaHumanPolicyAuthorization({
        authorizationId: id,
        authorizerId: "human-reviewer-a",
        action: "ACTIVATE",
        approvalStatement: "I_APPROVE_NQA_POLICY_ACTIVATION",
        expectedRegistryRevision: state.revision,
        expectedActivePolicyFingerprint: state.activePolicyFingerprint,
        targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
        readinessArtifactFingerprint: fixture.readiness.artifactFingerprint,
        sourceActivationTransactionId: null,
        approvedAt: "2026-09-24T22:00:00+07:00",
        validUntil: "2026-09-24T22:10:00+07:00",
      });

    const results = await Promise.allSettled([
      activateNqaCandidatePolicy({
        store,
        transactionId: "activate-race-a",
        readiness: fixture.readiness,
        materializedPolicy: fixture.materializedPolicy,
        authorization: makeAuthorization("race-auth-a"),
        committedAt: "2026-09-24T22:01:00+07:00",
      }),
      activateNqaCandidatePolicy({
        store,
        transactionId: "activate-race-b",
        readiness: fixture.readiness,
        materializedPolicy: fixture.materializedPolicy,
        authorization: makeAuthorization("race-auth-b"),
        committedAt: "2026-09-24T22:01:00+07:00",
      }),
    ]);

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    expect((await store.readState()).revision).toBe(1);
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("detects transaction audit tampering", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const authorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    const event = await activateNqaCandidatePolicy({
      store,
      transactionId: "activate-tamper-check",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });

    expect(() =>
      verifyNqaPolicyTransactionEvent({
        ...event,
        committedAt: "2026-09-24T22:01:01+07:00",
      })
    ).toThrow("event fingerprint mismatch");
  });
});

describe("NQA M17 rollback transaction", () => {
  it("restores the exact previous policy and clears the one-shot rollback target", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const activationAuthorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    await activateNqaCandidatePolicy({
      store,
      transactionId: "activate-for-rollback",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization: activationAuthorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });

    const activeState = await store.readState();
    const rollbackAuthorization = await buildRollbackAuthorization({
      store,
      sourceActivationTransactionId: "activate-for-rollback",
      targetPolicyFingerprint: activeState.rollbackTarget!.policyFingerprint,
    });
    const rollback = await rollbackNqaActivePolicy({
      store,
      transactionId: "rollback-001",
      authorization: rollbackAuthorization,
      committedAt: "2026-09-24T22:03:00+07:00",
    });

    expect(rollback.kind).toBe("ROLLBACK");
    expect(rollback.rolledBackActivationTransactionId).toBe(
      "activate-for-rollback"
    );
    expect(rollback.resultingState.activePolicy).toEqual(BASE_POLICY);
    expect(rollback.resultingState.rollbackTarget).toBeNull();
    expect(rollback.resultingState.revision).toBe(2);
  });

  it("is idempotent for the same rollback transaction and rejects a second unrelated rollback", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const activationAuthorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    await activateNqaCandidatePolicy({
      store,
      transactionId: "activate-idempotent-rollback",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization: activationAuthorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });
    const activeState = await store.readState();
    const rollbackAuthorization = await buildRollbackAuthorization({
      store,
      sourceActivationTransactionId: "activate-idempotent-rollback",
      targetPolicyFingerprint: activeState.rollbackTarget!.policyFingerprint,
    });
    const input = {
      store,
      transactionId: "rollback-idempotent",
      authorization: rollbackAuthorization,
      committedAt: "2026-09-24T22:03:00+07:00",
    } as const;

    const first = await rollbackNqaActivePolicy(input);
    const second = await rollbackNqaActivePolicy(input);
    expect(second).toEqual(first);
    expect(await store.listEvents()).toHaveLength(2);

    const stateAfter = await store.readState();
    const unrelatedAuthorization = buildNqaHumanPolicyAuthorization({
      authorizationId: "approve-second-rollback",
      authorizerId: "human-reviewer-a",
      action: "ROLLBACK",
      approvalStatement: "I_APPROVE_NQA_POLICY_ROLLBACK",
      expectedRegistryRevision: stateAfter.revision,
      expectedActivePolicyFingerprint: stateAfter.activePolicyFingerprint,
      targetPolicyFingerprint: stateAfter.activePolicyFingerprint,
      readinessArtifactFingerprint: null,
      sourceActivationTransactionId: "activate-idempotent-rollback",
      approvedAt: "2026-09-24T22:04:00+07:00",
      validUntil: "2026-09-24T22:14:00+07:00",
    });
    await expect(
      rollbackNqaActivePolicy({
        store,
        transactionId: "rollback-second",
        authorization: unrelatedAuthorization,
        committedAt: "2026-09-24T22:05:00+07:00",
      })
    ).rejects.toThrow("rollback target is not available");
  });

  it("rejects rollback authorization linked to the wrong activation transaction", async () => {
    const fixture = buildReadyActivationFixture();
    const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const activationAuthorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    await activateNqaCandidatePolicy({
      store,
      transactionId: "activate-linkage",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization: activationAuthorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });
    const activeState = await store.readState();
    const badAuthorization = await buildRollbackAuthorization({
      store,
      sourceActivationTransactionId: "wrong-activation",
      targetPolicyFingerprint: activeState.rollbackTarget!.policyFingerprint,
    });

    await expect(
      rollbackNqaActivePolicy({
        store,
        transactionId: "rollback-wrong-linkage",
        authorization: badAuthorization,
        committedAt: "2026-09-24T22:03:00+07:00",
      })
    ).rejects.toThrow("rollback authorization activation linkage mismatch");
  });
});
