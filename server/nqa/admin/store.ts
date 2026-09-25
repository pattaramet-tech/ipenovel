import fs from "node:fs/promises";
import path from "node:path";

import type { NqaAdminRun } from "./contracts";

const RUN_DIR_NAME = "admin-runs";
const RUN_FILE_PATTERN = /^nqa-admin-[a-f0-9-]{36}\.json$/;

export class NqaAdminRunStoreError extends Error {
  constructor(
    readonly code: "AUDIT_DIR_MISSING" | "RUN_NOT_FOUND" | "RUN_INVALID",
    message: string
  ) {
    super(message);
    this.name = "NqaAdminRunStoreError";
  }
}

export function resolveNqaAdminRunDirectory(
  env: Record<string, string | undefined> = process.env
): string {
  const root = env.NQA_AUTOLINK_AUDIT_DIR?.trim();
  if (!root) {
    throw new NqaAdminRunStoreError(
      "AUDIT_DIR_MISSING",
      "Persistent NQA audit directory is not configured."
    );
  }
  return path.join(root, RUN_DIR_NAME);
}

function runPath(root: string, runId: string): string {
  if (!/^nqa-admin-[a-f0-9-]{36}$/.test(runId)) {
    throw new NqaAdminRunStoreError("RUN_INVALID", "Invalid NQA run identity.");
  }
  return path.join(root, runId + ".json");
}

function parseRun(raw: string): NqaAdminRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NqaAdminRunStoreError(
      "RUN_INVALID",
      "NQA run artifact is invalid JSON."
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== "nqa-admin-run-v1" ||
    typeof (parsed as { runId?: unknown }).runId !== "string"
  ) {
    throw new NqaAdminRunStoreError(
      "RUN_INVALID",
      "NQA run artifact shape is invalid."
    );
  }
  return parsed as NqaAdminRun;
}

export class JsonNqaAdminRunStore {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  private async root(): Promise<string> {
    const root = resolveNqaAdminRunDirectory(this.env);
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  async save(run: NqaAdminRun): Promise<void> {
    const root = await this.root();
    await fs.writeFile(
      runPath(root, run.runId),
      JSON.stringify(run, null, 2) + "\n",
      "utf8"
    );
  }

  async get(runId: string, actorUserId: number): Promise<NqaAdminRun> {
    const root = await this.root();
    let raw: string;
    try {
      raw = await fs.readFile(runPath(root, runId), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new NqaAdminRunStoreError(
          "RUN_NOT_FOUND",
          "NQA run was not found."
        );
      }
      throw error;
    }
    const run = parseRun(raw);
    if (run.actorUserId !== actorUserId) {
      throw new NqaAdminRunStoreError(
        "RUN_NOT_FOUND",
        "NQA run was not found."
      );
    }
    return run;
  }

  async list(actorUserId: number, limit = 30): Promise<NqaAdminRun[]> {
    const root = await this.root();
    const names = await fs.readdir(root);
    const runs: NqaAdminRun[] = [];

    for (const name of names) {
      if (!RUN_FILE_PATTERN.test(name)) continue;
      try {
        const run = parseRun(await fs.readFile(path.join(root, name), "utf8"));
        if (run.actorUserId === actorUserId) runs.push(run);
      } catch {
        // A corrupt artifact is ignored in list mode but remains unreadable by get().
      }
    }

    return runs
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(100, limit)));
  }
}
