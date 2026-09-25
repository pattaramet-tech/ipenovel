import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonFileNqaNovelIdAutolinkAuditStore,
  NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
} from "./audit";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("NQA novel-id autolink append-only audit", () => {
  it("persists and verifies append-only provenance", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "nqa-autolink-audit-")
    );
    cleanup.push(root);
    const store = new JsonFileNqaNovelIdAutolinkAuditStore(root);

    const event = await store.append({
      auditVersion: NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION,
      eventId: "backfill-confirm-1",
      kind: "BACKFILL_COMMITTED",
      spreadsheetId: "sheet-1",
      sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
      row: 1744,
      previewFingerprint: "a".repeat(64),
      novelId: 812,
      authorizationId: "confirm-1",
      authorizerId: "workspace-admin-7",
      authorizationFingerprint: "b".repeat(64),
      previewStatus: "MATCH",
      writeReceipt: {
        updatedRange: "'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744",
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      },
      reason: null,
      createdAt: "2026-09-25T21:00:00+07:00",
    });

    expect(event.eventFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.list()).resolves.toEqual([event]);
    expect(
      (await fs.readdir(root)).filter(name => name.endsWith(".json"))
    ).toHaveLength(1);
  });
});
