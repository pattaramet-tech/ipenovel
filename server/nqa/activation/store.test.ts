import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../core";
import { buildNqaPolicyRegistryState } from "./integrity";
import {
  InMemoryNqaPolicyActivationStore,
  JsonFileNqaPolicyActivationStore,
} from "./store";
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

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("NQA M17 durable append-only activation store", () => {
  it("persists activation and rollback as immutable journal events and replays exact state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-activation-"));
    cleanup.push(root);
    const fixture = buildReadyActivationFixture();
    const store = new JsonFileNqaPolicyActivationStore(root, BASE_POLICY);
    const activationAuthorization = await buildActivationAuthorization({
      store,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });

    await activateNqaCandidatePolicy({
      store,
      transactionId: "durable-activate",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization: activationAuthorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });
    const active = await store.readState();
    expect(active.activePolicyFingerprint).toBe(
      fixture.materializedPolicy.policyFingerprint
    );

    const rollbackAuthorization = await buildRollbackAuthorization({
      store,
      sourceActivationTransactionId: "durable-activate",
      targetPolicyFingerprint: active.rollbackTarget!.policyFingerprint,
    });
    await rollbackNqaActivePolicy({
      store,
      transactionId: "durable-rollback",
      authorization: rollbackAuthorization,
      committedAt: "2026-09-24T22:03:00+07:00",
    });

    const reopened = new JsonFileNqaPolicyActivationStore(root, BASE_POLICY);
    const restored = await reopened.readState();
    expect(restored.activePolicy).toEqual(BASE_POLICY);
    expect(restored.revision).toBe(2);
    expect(restored.rollbackTarget).toBeNull();

    const eventFiles = await fs.readdir(path.join(root, "events"));
    expect(eventFiles.filter(name => name.endsWith(".json"))).toHaveLength(2);
    expect((await reopened.listEvents()).map(event => event.kind)).toEqual([
      "ACTIVATE",
      "ROLLBACK",
    ]);
  });

  it("rejects reopening a registry with a different genesis policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-activation-"));
    cleanup.push(root);
    const store = new JsonFileNqaPolicyActivationStore(root, BASE_POLICY);
    await store.readState();

    const mismatched = new JsonFileNqaPolicyActivationStore(root, {
      ...BASE_POLICY,
      minPassMeanScore: 0.71,
    });
    await expect(mismatched.readState()).rejects.toThrow(
      "genesis does not match initial policy"
    );
  });

  it("rejects a rehashed but semantically forged activation event", async () => {
    const fixture = buildReadyActivationFixture();
    const sourceStore = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const authorization = await buildActivationAuthorization({
      store: sourceStore,
      readinessFingerprint: fixture.readiness.artifactFingerprint,
      targetPolicyFingerprint: fixture.materializedPolicy.policyFingerprint,
    });
    const valid = await activateNqaCandidatePolicy({
      store: sourceStore,
      transactionId: "activate-forge-source",
      readiness: fixture.readiness,
      materializedPolicy: fixture.materializedPolicy,
      authorization,
      committedAt: "2026-09-24T22:01:00+07:00",
    });

    const targetStore = new InMemoryNqaPolicyActivationStore(BASE_POLICY);
    const genesis = await targetStore.readState();
    const forgedState = buildNqaPolicyRegistryState({
      revision: 1,
      activePolicy: BASE_POLICY,
      rollbackTarget: valid.resultingState.rollbackTarget,
      lastTransactionId: valid.transactionId,
    });
    const { eventFingerprint: _ignored, ...eventPayload } = valid;
    const forgedPayload = {
      ...eventPayload,
      resultingState: forgedState,
    };
    const forged = {
      ...forgedPayload,
      eventFingerprint: hashCanonicalJson({
        scope: "nqa:policy-transaction-event:v1",
        ...forgedPayload,
      }),
    };

    await expect(
      targetStore.compareAndAppend({
        expectedRevision: genesis.revision,
        expectedStateFingerprint: genesis.stateFingerprint,
        event: forged,
      })
    ).rejects.toThrow("activation journal transition is invalid");
  });
});
