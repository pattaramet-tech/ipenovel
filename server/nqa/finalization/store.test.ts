import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonFileNqaBaselineLineageStore } from "./store";
import { finalizeNqaCandidateBaseline } from "./transaction";
import { buildCompletedGraduatedRolloutFixture } from "./testSupport";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("NQA M20 durable baseline lineage", () => {
  it("replays finalized baseline and predecessor history exactly after reopening", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m20-lineage-"));
    cleanup.push(root);
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const predecessor = fixture.registryState.rollbackTarget!.policy;
    const store = new JsonFileNqaBaselineLineageStore(root, predecessor);

    const event = await finalizeNqaCandidateBaseline({
      activationStore: fixture.activationStore,
      expansionStore: fixture.expansionStore,
      lineageStore: store,
      transactionId: "m20-durable-finalize",
      completionGate: fixture.completionGate,
      authorization: fixture.finalizationAuthorization,
      committedAt: "2026-09-25T01:26:00+07:00",
    });

    const reopened = new JsonFileNqaBaselineLineageStore(root, predecessor);
    expect(await reopened.readState()).toEqual(event.resultingLineageState);
    expect(await reopened.listEvents()).toEqual([event]);

    const names = await fs.readdir(path.join(root, "events"));
    expect(names.filter(name => name.endsWith(".json"))).toHaveLength(1);
  });

  it("rejects reopening the lineage journal with another predecessor baseline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m20-lineage-"));
    cleanup.push(root);
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const predecessor = fixture.registryState.rollbackTarget!.policy;
    const store = new JsonFileNqaBaselineLineageStore(root, predecessor);
    await store.readState();

    const mismatched = new JsonFileNqaBaselineLineageStore(root, {
      ...predecessor,
      minPassMeanScore: predecessor.minPassMeanScore + 0.01,
    });
    await expect(mismatched.readState()).rejects.toThrow(
      "genesis does not match predecessor baseline"
    );
  });
});
