import fs from "node:fs/promises";
import path from "node:path";

import {
  NqaShadowCheckpointSchema,
  NqaShadowRecordSchema,
  NqaShadowRunIdSchema,
  NqaShadowCaseIdSchema,
  type NqaShadowCheckpoint,
  type NqaShadowMetrics,
  type NqaShadowRecord,
} from "./contracts";

export interface NqaShadowStore {
  loadCheckpoint(runId: string): Promise<NqaShadowCheckpoint | null>;
  saveCheckpoint(checkpoint: NqaShadowCheckpoint): Promise<void>;
  getRecord(runId: string, caseId: string): Promise<NqaShadowRecord | null>;
  putRecord(record: NqaShadowRecord): Promise<void>;
  listRecords(runId: string): Promise<NqaShadowRecord[]>;
  saveMetrics(runId: string, metrics: NqaShadowMetrics): Promise<void>;
}

export class InMemoryNqaShadowStore implements NqaShadowStore {
  private readonly checkpoints = new Map<string, NqaShadowCheckpoint>();
  private readonly records = new Map<string, Map<string, NqaShadowRecord>>();
  private readonly metrics = new Map<string, NqaShadowMetrics>();

  async loadCheckpoint(runId: string): Promise<NqaShadowCheckpoint | null> {
    const value = this.checkpoints.get(runId);
    return value ? structuredClone(value) : null;
  }

  async saveCheckpoint(checkpoint: NqaShadowCheckpoint): Promise<void> {
    this.checkpoints.set(
      checkpoint.runId,
      structuredClone(NqaShadowCheckpointSchema.parse(checkpoint))
    );
  }

  async getRecord(
    runId: string,
    caseId: string
  ): Promise<NqaShadowRecord | null> {
    const value = this.records.get(runId)?.get(caseId);
    return value ? structuredClone(value) : null;
  }

  async putRecord(record: NqaShadowRecord): Promise<void> {
    const parsed = NqaShadowRecordSchema.parse(record);
    const runRecords = this.records.get(record.runId) ?? new Map();
    runRecords.set(record.caseId, structuredClone(parsed));
    this.records.set(record.runId, runRecords);
  }

  async listRecords(runId: string): Promise<NqaShadowRecord[]> {
    return Array.from(this.records.get(runId)?.values() ?? [])
      .map(value => structuredClone(value))
      .sort((left, right) => left.caseId.localeCompare(right.caseId));
  }

  async saveMetrics(runId: string, metrics: NqaShadowMetrics): Promise<void> {
    this.metrics.set(runId, structuredClone(metrics));
  }

  getMetrics(runId: string): NqaShadowMetrics | null {
    const value = this.metrics.get(runId);
    return value ? structuredClone(value) : null;
  }
}

async function atomicWriteJson(
  filePath: string,
  value: unknown
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = filePath + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, filePath);
}

export class JsonFileNqaShadowStore implements NqaShadowStore {
  constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) {
      throw new Error("Shadow store rootDir is required.");
    }
  }

  private runDir(runId: string): string {
    return path.join(this.rootDir, NqaShadowRunIdSchema.parse(runId));
  }

  private recordPath(runId: string, caseId: string): string {
    return path.join(
      this.runDir(runId),
      "records",
      NqaShadowCaseIdSchema.parse(caseId) + ".json"
    );
  }

  async loadCheckpoint(runId: string): Promise<NqaShadowCheckpoint | null> {
    const filePath = path.join(this.runDir(runId), "checkpoint.json");
    try {
      const content = await fs.readFile(filePath, "utf8");
      return NqaShadowCheckpointSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async saveCheckpoint(checkpoint: NqaShadowCheckpoint): Promise<void> {
    const parsed = NqaShadowCheckpointSchema.parse(checkpoint);
    await atomicWriteJson(
      path.join(this.runDir(parsed.runId), "checkpoint.json"),
      parsed
    );
  }

  async getRecord(
    runId: string,
    caseId: string
  ): Promise<NqaShadowRecord | null> {
    try {
      const content = await fs.readFile(this.recordPath(runId, caseId), "utf8");
      return NqaShadowRecordSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async putRecord(record: NqaShadowRecord): Promise<void> {
    const parsed = NqaShadowRecordSchema.parse(record);
    await atomicWriteJson(this.recordPath(parsed.runId, parsed.caseId), parsed);
  }

  async listRecords(runId: string): Promise<NqaShadowRecord[]> {
    const directory = path.join(this.runDir(runId), "records");
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: NqaShadowRecord[] = [];
    for (const name of entries.filter(name => name.endsWith(".json")).sort()) {
      const content = await fs.readFile(path.join(directory, name), "utf8");
      records.push(NqaShadowRecordSchema.parse(JSON.parse(content)));
    }
    return records;
  }

  async saveMetrics(runId: string, metrics: NqaShadowMetrics): Promise<void> {
    await atomicWriteJson(
      path.join(this.runDir(runId), "metrics.json"),
      metrics
    );
  }
}
