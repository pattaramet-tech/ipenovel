import fs from "node:fs/promises";
import path from "node:path";

import { hashCanonicalJson } from "../core";
import type { NqaNovelIdBackfillWriteReceipt } from "./contracts";

export const NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION =
  "nqa-novel-id-autolink-audit-v1" as const;

export type NqaNovelIdAutolinkAuditEvent = {
  auditVersion: typeof NQA_NOVEL_ID_AUTOLINK_AUDIT_VERSION;
  eventId: string;
  kind:
    | "PREVIEW_CREATED"
    | "CONFIRMATION_ACCEPTED"
    | "BACKFILL_COMMITTED"
    | "BACKFILL_REJECTED";
  spreadsheetId: string;
  sheetName: string;
  row: number;
  previewFingerprint: string | null;
  novelId: number | null;
  authorizationId: string | null;
  authorizerId: string | null;
  authorizationFingerprint: string | null;
  previewStatus: string | null;
  writeReceipt: NqaNovelIdBackfillWriteReceipt | null;
  reason: string | null;
  createdAt: string;
  eventFingerprint: string;
};

export interface NqaNovelIdAutolinkAuditStore {
  append(
    event: Omit<NqaNovelIdAutolinkAuditEvent, "eventFingerprint">
  ): Promise<NqaNovelIdAutolinkAuditEvent>;
  list(): Promise<NqaNovelIdAutolinkAuditEvent[]>;
}

export function verifyNqaNovelIdAutolinkAuditEvent(
  input: NqaNovelIdAutolinkAuditEvent
): NqaNovelIdAutolinkAuditEvent {
  const { eventFingerprint, ...withoutFingerprint } = input;
  const expected = hashCanonicalJson({
    scope: "nqa:novel-id-autolink-audit:v1",
    ...withoutFingerprint,
  });
  if (eventFingerprint !== expected) {
    throw new Error("NQA novel-id autolink audit fingerprint mismatch.");
  }
  return input;
}

function materializeEvent(
  event: Omit<NqaNovelIdAutolinkAuditEvent, "eventFingerprint">
): NqaNovelIdAutolinkAuditEvent {
  return {
    ...event,
    eventFingerprint: hashCanonicalJson({
      scope: "nqa:novel-id-autolink-audit:v1",
      ...event,
    }),
  };
}

export class InMemoryNqaNovelIdAutolinkAuditStore implements NqaNovelIdAutolinkAuditStore {
  readonly records: NqaNovelIdAutolinkAuditEvent[] = [];

  async append(
    event: Omit<NqaNovelIdAutolinkAuditEvent, "eventFingerprint">
  ): Promise<NqaNovelIdAutolinkAuditEvent> {
    const materialized = materializeEvent(event);
    this.records.push(structuredClone(materialized));
    return structuredClone(materialized);
  }

  async list(): Promise<NqaNovelIdAutolinkAuditEvent[]> {
    return structuredClone(this.records);
  }
}

export class JsonFileNqaNovelIdAutolinkAuditStore implements NqaNovelIdAutolinkAuditStore {
  constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) {
      throw new Error("NQA novel-id autolink audit rootDir is required.");
    }
  }

  async append(
    event: Omit<NqaNovelIdAutolinkAuditEvent, "eventFingerprint">
  ): Promise<NqaNovelIdAutolinkAuditEvent> {
    const materialized = materializeEvent(event);
    await fs.mkdir(this.rootDir, { recursive: true });
    const safeTimestamp = materialized.createdAt.replace(/[^0-9A-Za-z]+/g, "-");
    const fileName =
      safeTimestamp +
      "-" +
      materialized.eventId.replace(/[^0-9A-Za-z_-]+/g, "-") +
      "-" +
      materialized.eventFingerprint +
      ".json";
    await fs.writeFile(
      path.join(this.rootDir, fileName),
      JSON.stringify(materialized, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" }
    );
    return materialized;
  }

  async list(): Promise<NqaNovelIdAutolinkAuditEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const events: NqaNovelIdAutolinkAuditEvent[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const parsed = JSON.parse(
        await fs.readFile(path.join(this.rootDir, name), "utf8")
      ) as NqaNovelIdAutolinkAuditEvent;
      events.push(verifyNqaNovelIdAutolinkAuditEvent(parsed));
    }
    return events;
  }
}
