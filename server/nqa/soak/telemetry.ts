import fs from "node:fs/promises";
import path from "node:path";

import { hashCanonicalJson } from "../core";
import {
  NQA_OPERATIONAL_SAMPLE_VERSION,
  NqaOperationalSampleSchema,
  type NqaOperationalSample,
} from "./contracts";

export function buildNqaOperationalSample(input: {
  sampleId: string;
  scopeId: string;
  scopeFingerprint: string;
  row: number;
  chapter: number;
  status: "SUCCESS" | "ERROR";
  durationMs: number;
  monitoringRecordId?: string | null;
  monitoringRecordFingerprint?: string | null;
  errorCode?: string | null;
  observedAt: string;
}): NqaOperationalSample {
  if (
    input.status === "SUCCESS" &&
    (!input.monitoringRecordId || !input.monitoringRecordFingerprint)
  ) {
    throw new Error(
      "M19 successful operational samples require M18 monitoring linkage."
    );
  }
  if (
    input.status === "ERROR" &&
    (input.monitoringRecordId || input.monitoringRecordFingerprint)
  ) {
    throw new Error(
      "M19 error operational samples cannot claim M18 monitoring linkage."
    );
  }

  const withoutFingerprint = {
    sampleVersion: NQA_OPERATIONAL_SAMPLE_VERSION,
    sampleId: input.sampleId,
    scopeId: input.scopeId,
    scopeFingerprint: input.scopeFingerprint,
    row: input.row,
    chapter: input.chapter,
    status: input.status,
    durationMs: input.durationMs,
    monitoringRecordId: input.monitoringRecordId ?? null,
    monitoringRecordFingerprint: input.monitoringRecordFingerprint ?? null,
    errorCode:
      input.status === "ERROR" ? (input.errorCode ?? "EXECUTION_ERROR") : null,
    observedAt: input.observedAt,
  };

  return NqaOperationalSampleSchema.parse({
    ...withoutFingerprint,
    sampleFingerprint: hashCanonicalJson({
      scope: "nqa:operational-sample:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaOperationalSample(
  input: NqaOperationalSample
): NqaOperationalSample {
  const sample = NqaOperationalSampleSchema.parse(input);
  const { sampleFingerprint, ...withoutFingerprint } = sample;
  if (
    sampleFingerprint !==
    hashCanonicalJson({
      scope: "nqa:operational-sample:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M19 operational sample fingerprint mismatch.");
  }
  if (
    sample.status === "SUCCESS" &&
    (!sample.monitoringRecordId || !sample.monitoringRecordFingerprint)
  ) {
    throw new Error("M19 successful operational sample linkage is invalid.");
  }
  if (
    sample.status === "ERROR" &&
    (sample.monitoringRecordId || sample.monitoringRecordFingerprint)
  ) {
    throw new Error("M19 error operational sample linkage is invalid.");
  }
  return sample;
}

export interface NqaOperationalSampleStore {
  append(sample: NqaOperationalSample): Promise<void>;
  list(scopeId: string): Promise<NqaOperationalSample[]>;
}

export class InMemoryNqaOperationalSampleStore implements NqaOperationalSampleStore {
  private readonly samples: NqaOperationalSample[] = [];

  async append(sample: NqaOperationalSample): Promise<void> {
    const verified = verifyNqaOperationalSample(sample);
    if (this.samples.some(item => item.sampleId === verified.sampleId)) {
      throw new Error("M19 operational sampleId already exists.");
    }
    this.samples.push(structuredClone(verified));
  }

  async list(scopeId: string): Promise<NqaOperationalSample[]> {
    return structuredClone(
      this.samples
        .filter(sample => sample.scopeId === scopeId)
        .sort(
          (left, right) =>
            left.observedAt.localeCompare(right.observedAt) ||
            left.sampleId.localeCompare(right.sampleId)
        )
    );
  }
}

export class JsonFileNqaOperationalSampleStore implements NqaOperationalSampleStore {
  constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) throw new Error("M19 telemetry rootDir is required.");
  }

  private scopeDir(scopeId: string): string {
    return path.join(this.rootDir, scopeId);
  }

  async append(sample: NqaOperationalSample): Promise<void> {
    const verified = verifyNqaOperationalSample(sample);
    const directory = this.scopeDir(verified.scopeId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(
        directory,
        verified.sampleId + "-" + verified.sampleFingerprint + ".json"
      ),
      JSON.stringify(verified, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" }
    );
  }

  async list(scopeId: string): Promise<NqaOperationalSample[]> {
    const directory = this.scopeDir(scopeId);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const samples: NqaOperationalSample[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      samples.push(
        verifyNqaOperationalSample(
          JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))
        )
      );
    }
    return samples.sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.sampleId.localeCompare(right.sampleId)
    );
  }
}
