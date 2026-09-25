import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildNqaOperationalSample,
  JsonFileNqaOperationalSampleStore,
} from "./telemetry";
import { buildNqaScopeExpansionAuthorization } from "./integrity";
import { JsonFileNqaScopeExpansionStore } from "./store";
import { expandNqaControlledRolloutScope } from "./transaction";
import { buildHealthySoakFixture } from "./testSupport";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("NQA M19 durable stores", () => {
  it("persists operational samples append-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m19-telemetry-"));
    cleanup.push(root);
    const { activation } = await buildHealthySoakFixture({
      targets: [{ row: 2, chapter: 197 }],
    });
    const store = new JsonFileNqaOperationalSampleStore(root);
    const sample = buildNqaOperationalSample({
      sampleId: "durable-sample",
      scopeId: activation.scope.scopeId,
      scopeFingerprint: activation.scope.scopeFingerprint,
      row: 2,
      chapter: 197,
      status: "SUCCESS",
      durationMs: 120,
      monitoringRecordId: "durable-record",
      monitoringRecordFingerprint: "b".repeat(64),
      observedAt: "2026-09-24T22:20:00+07:00",
    });

    await store.append(sample);
    expect(await store.list(activation.scope.scopeId)).toEqual([sample]);
    await expect(store.append(sample)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("replays durable scope expansion journal to the same current scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m19-expansion-"));
    cleanup.push(root);
    const { activation, state, gate } = await buildHealthySoakFixture();
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "durable-expansion-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "durable-expanded-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });
    const store = new JsonFileNqaScopeExpansionStore(root, activation.scope);

    const event = await expandNqaControlledRolloutScope({
      activationStore: activation.store,
      expansionStore: store,
      transactionId: "durable-expand-001",
      sourceSoakGate: gate,
      authorization,
      proposedTargets,
      committedAt: "2026-09-24T23:06:00+07:00",
    });

    const reopened = new JsonFileNqaScopeExpansionStore(root, activation.scope);
    const restored = await reopened.readState();
    expect(restored).toEqual(event.resultingState);
    expect(await reopened.listEvents()).toEqual([event]);
  });
});
