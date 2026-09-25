import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { NqaAdminRun } from "./contracts";
import { JsonNqaAdminRunStore } from "./store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))
  );
});

function run(actorUserId: number): NqaAdminRun {
  const now = "2026-09-26T00:00:00.000Z";
  return {
    version: "nqa-admin-run-v1",
    runId: "nqa-admin-00000000-0000-4000-8000-000000000001",
    actorUserId,
    mode: "FULL_QA",
    startRow: 1584,
    endRow: 1584,
    googleConnectionId: 1,
    sampleParagraphs: 10,
    qcEligibilityOnly: false,
    status: "READY",
    blocker: null,
    rows: [],
    cursor: { rowIndex: 0, chapterIndex: 0 },
    results: [],
    writebacks: [],
    summary: {
      totalRows: 1,
      eligibleRows: 1,
      totalChapters: 0,
      processedChapters: 0,
      decisions: {
        PASS: 0,
        REVIEW: 0,
        MISMATCH: 0,
        INSUFFICIENT: 0,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("M26 NQA Admin run store", () => {
  it("persists checkpointed runs and scopes reads/history by actor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-admin-store-"));
    roots.push(root);
    const store = new JsonNqaAdminRunStore({
      NQA_AUTOLINK_AUDIT_DIR: root,
    });
    await store.save(run(42));

    expect((await store.get(run(42).runId, 42)).actorUserId).toBe(42);
    await expect(store.get(run(42).runId, 99)).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    expect(await store.list(42)).toHaveLength(1);
    expect(await store.list(99)).toHaveLength(0);
  });
});
