import {
  activateNqaCandidatePolicy,
  rollbackNqaActivePolicy,
} from "../activation/transaction";
import { InMemoryNqaPolicyActivationStore } from "../activation/store";
import {
  BASE_POLICY,
  buildActivationAuthorization,
  buildReadyActivationFixture,
  buildRollbackAuthorization,
} from "../activation/testSupport";
import { buildNqaControlledRolloutScope } from "./resolver";

export { BASE_POLICY };

export async function buildActivatedRolloutFixture(input?: {
  transactionId?: string;
  scopeId?: string;
  targets?: readonly { row: number; chapter: number }[];
}) {
  const fixture = buildReadyActivationFixture();
  const store = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
  const transactionId = input?.transactionId ?? "m18-activate-001";
  const activationAuthorization = await buildActivationAuthorization({
    store,
    readinessFingerprint: fixture.readiness.artifactFingerprint,
    targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    authorizationId: "m18-activation-approval",
  });

  await activateNqaCandidatePolicy({
    store,
    transactionId,
    readiness: fixture.readiness,
    materializedPolicy: fixture.materializedPolicy,
    authorization: activationAuthorization,
    committedAt: "2026-09-24T22:01:00+07:00",
  });

  const state = await store.readState();
  const scope = buildNqaControlledRolloutScope({
    state,
    scopeId: input?.scopeId ?? "m18-scope-001",
    approvedBy: "human-rollout-operator",
    approvedAt: "2026-09-24T22:02:00+07:00",
    targets: input?.targets ?? [{ row: 2, chapter: 197 }],
  });

  return { fixture, store, state, scope, transactionId };
}

export async function rollbackActivatedFixture(input: {
  store: InMemoryNqaPolicyActivationStore;
  transactionId: string;
}) {
  const state = await input.store.readState();
  const authorization = await buildRollbackAuthorization({
    store: input.store,
    sourceActivationTransactionId: input.transactionId,
    targetPolicyFingerprint: state.rollbackTarget!.policyFingerprint,
    authorizationId: "m18-rollback-approval",
  });
  return rollbackNqaActivePolicy({
    store: input.store,
    transactionId: "m18-rollback-001",
    authorization,
    committedAt: "2026-09-24T22:03:00+07:00",
  });
}
