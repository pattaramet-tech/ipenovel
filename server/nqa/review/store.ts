import fs from "node:fs/promises";
import path from "node:path";

import {
  NqaShadowCaseIdSchema,
  NqaShadowRunIdSchema,
} from "../shadow/contracts";
import { NqaReviewActionSchema, type NqaReviewAction } from "./contracts";

export interface NqaReviewJournalStore {
  listActions(runId: string, caseId: string): Promise<NqaReviewAction[]>;
  appendAction(action: NqaReviewAction): Promise<void>;
}

function validateAppend(
  existing: readonly NqaReviewAction[],
  action: NqaReviewAction
): void {
  if (existing.some(item => item.actionId === action.actionId)) {
    throw new Error("Review actionId already exists.");
  }
  if (existing.some(item => item.actionHash === action.actionHash)) {
    throw new Error("Review action hash already exists.");
  }
  const last = existing[existing.length - 1] ?? null;
  if (action.sequence !== existing.length + 1) {
    throw new Error("Review action sequence is not append-only.");
  }
  if (action.previousActionHash !== (last?.actionHash ?? null)) {
    throw new Error("Review action previous hash does not match journal head.");
  }
}

export class InMemoryNqaReviewJournalStore implements NqaReviewJournalStore {
  private readonly actions = new Map<string, NqaReviewAction[]>();

  private key(runId: string, caseId: string): string {
    return (
      NqaShadowRunIdSchema.parse(runId) +
      "/" +
      NqaShadowCaseIdSchema.parse(caseId)
    );
  }

  async listActions(runId: string, caseId: string): Promise<NqaReviewAction[]> {
    return structuredClone(this.actions.get(this.key(runId, caseId)) ?? []);
  }

  async appendAction(action: NqaReviewAction): Promise<void> {
    const parsed = NqaReviewActionSchema.parse(action);
    const key = this.key(parsed.runId, parsed.caseId);
    const existing = this.actions.get(key) ?? [];
    validateAppend(existing, parsed);
    this.actions.set(key, [...existing, structuredClone(parsed)]);
  }
}

export class JsonFileNqaReviewJournalStore implements NqaReviewJournalStore {
  constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) {
      throw new Error("Review journal rootDir is required.");
    }
  }

  private actionsDir(runId: string, caseId: string): string {
    return path.join(
      this.rootDir,
      NqaShadowRunIdSchema.parse(runId),
      "review",
      NqaShadowCaseIdSchema.parse(caseId),
      "actions"
    );
  }

  async listActions(runId: string, caseId: string): Promise<NqaReviewAction[]> {
    const directory = this.actionsDir(runId, caseId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const actions: NqaReviewAction[] = [];
    for (const name of entries.filter(name => name.endsWith(".json")).sort()) {
      const content = await fs.readFile(path.join(directory, name), "utf8");
      actions.push(NqaReviewActionSchema.parse(JSON.parse(content)));
    }
    return actions.sort((left, right) => left.sequence - right.sequence);
  }

  async appendAction(action: NqaReviewAction): Promise<void> {
    const parsed = NqaReviewActionSchema.parse(action);
    const existing = await this.listActions(parsed.runId, parsed.caseId);
    validateAppend(existing, parsed);

    const directory = this.actionsDir(parsed.runId, parsed.caseId);
    await fs.mkdir(directory, { recursive: true });
    const fileName =
      String(parsed.sequence).padStart(6, "0") +
      "-" +
      parsed.actionHash +
      ".json";
    await fs.writeFile(
      path.join(directory, fileName),
      JSON.stringify(parsed, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" }
    );
  }
}
