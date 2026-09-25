import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  NqaBaselineFinalizationAppendResult,
  NqaBaselineFinalizationEvent,
  NqaBaselineLineageState,
} from "./contracts";
import {
  buildNqaBaselineLineageState,
  verifyNqaBaselineFinalizationEvent,
  verifyNqaBaselineLineageState,
  verifyNqaCandidateFinalizationAuthorizationWindow,
} from "./integrity";

export interface NqaBaselineLineageStore {
  readState(): Promise<NqaBaselineLineageState>;
  getEvent(transactionId: string): Promise<NqaBaselineFinalizationEvent | null>;
  listEvents(): Promise<NqaBaselineFinalizationEvent[]>;
  compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaBaselineFinalizationEvent;
  }): Promise<NqaBaselineFinalizationAppendResult>;
}

function validateTransition(input: {
  previous: NqaBaselineLineageState;
  event: NqaBaselineFinalizationEvent;
}): void {
  const previous = verifyNqaBaselineLineageState(input.previous);
  const event = verifyNqaBaselineFinalizationEvent(input.event);
  verifyNqaCandidateFinalizationAuthorizationWindow({
    authorization: event.humanAuthorization,
    committedAt: event.committedAt,
  });

  const next = event.resultingLineageState;
  if (
    event.previousLineageState.stateFingerprint !== previous.stateFingerprint ||
    next.predecessorBaselinePolicyFingerprint !==
      previous.baselinePolicyFingerprint ||
    JSON.stringify(next.predecessorBaselinePolicy) !==
      JSON.stringify(previous.baselinePolicy) ||
    next.baselinePolicyFingerprint !==
      event.humanAuthorization.candidatePolicyFingerprint ||
    event.humanAuthorization.predecessorBaselinePolicyFingerprint !==
      previous.baselinePolicyFingerprint ||
    event.humanAuthorization.completionArtifactFingerprint !==
      event.sourceCompletionGate.artifactFingerprint ||
    event.sourceCompletionGate.decision !==
      "READY_FOR_CANDIDATE_FINALIZATION_REVIEW" ||
    event.sourceCompletionGate.failureReasons.length !== 0 ||
    event.humanAuthorization.expectedExpansionRevision !==
      event.sourceExpansionState.revision ||
    event.humanAuthorization.expectedExpansionStateFingerprint !==
      event.sourceExpansionState.stateFingerprint
  ) {
    throw new Error("M20 baseline finalization journal transition is invalid.");
  }
}

function applyChain(
  initialState: NqaBaselineLineageState,
  events: readonly NqaBaselineFinalizationEvent[]
): NqaBaselineLineageState {
  let state = verifyNqaBaselineLineageState(initialState);
  for (const raw of [...events].sort(
    (left, right) =>
      left.resultingLineageState.revision - right.resultingLineageState.revision
  )) {
    const event = verifyNqaBaselineFinalizationEvent(raw);
    validateTransition({ previous: state, event });
    state = event.resultingLineageState;
  }
  return verifyNqaBaselineLineageState(state);
}

export class InMemoryNqaBaselineLineageStore implements NqaBaselineLineageStore {
  private readonly initialState: NqaBaselineLineageState;
  private readonly events: NqaBaselineFinalizationEvent[] = [];

  constructor(
    initialBaselinePolicy: NqaBaselineLineageState["baselinePolicy"]
  ) {
    this.initialState = buildNqaBaselineLineageState({
      revision: 0,
      baselinePolicy: initialBaselinePolicy,
      sourceFinalizationTransactionId: null,
      sourceCompletionArtifactFingerprint: null,
    });
  }

  async readState(): Promise<NqaBaselineLineageState> {
    return structuredClone(applyChain(this.initialState, this.events));
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaBaselineFinalizationEvent | null> {
    const event = this.events.find(
      item => item.transactionId === transactionId
    );
    return event ? structuredClone(event) : null;
  }

  async listEvents(): Promise<NqaBaselineFinalizationEvent[]> {
    applyChain(this.initialState, this.events);
    return structuredClone(this.events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaBaselineFinalizationEvent;
  }): Promise<NqaBaselineFinalizationAppendResult> {
    if (
      this.events.some(item => item.transactionId === input.event.transactionId)
    ) {
      return "EXISTS";
    }
    const state = applyChain(this.initialState, this.events);
    if (
      state.revision !== input.expectedRevision ||
      state.stateFingerprint !== input.expectedStateFingerprint
    ) {
      return "CONFLICT";
    }
    validateTransition({ previous: state, event: input.event });
    this.events.push(structuredClone(input.event));
    return "COMMITTED";
  }
}

export class JsonFileNqaBaselineLineageStore implements NqaBaselineLineageStore {
  private readonly initialPolicy: NqaBaselineLineageState["baselinePolicy"];

  constructor(
    private readonly rootDir: string,
    initialBaselinePolicy: NqaBaselineLineageState["baselinePolicy"]
  ) {
    if (!rootDir.trim()) {
      throw new Error("M20 baseline lineage rootDir is required.");
    }
    this.initialPolicy = structuredClone(initialBaselinePolicy);
  }

  private genesisPath(): string {
    return path.join(this.rootDir, "genesis.json");
  }

  private eventsDir(): string {
    return path.join(this.rootDir, "events");
  }

  private lockPath(): string {
    return path.join(this.rootDir, "transaction.lock");
  }

  private async ensureInitialized(): Promise<NqaBaselineLineageState> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const expected = buildNqaBaselineLineageState({
      revision: 0,
      baselinePolicy: this.initialPolicy,
      sourceFinalizationTransactionId: null,
      sourceCompletionArtifactFingerprint: null,
    });
    try {
      await fs.writeFile(
        this.genesisPath(),
        JSON.stringify(expected, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
      return expected;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = verifyNqaBaselineLineageState(
      JSON.parse(await fs.readFile(this.genesisPath(), "utf8"))
    );
    if (existing.stateFingerprint !== expected.stateFingerprint) {
      throw new Error(
        "M20 baseline lineage genesis does not match predecessor baseline."
      );
    }
    return existing;
  }

  private async readEventsUnlocked(): Promise<NqaBaselineFinalizationEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.eventsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: NqaBaselineFinalizationEvent[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      events.push(
        verifyNqaBaselineFinalizationEvent(
          JSON.parse(
            await fs.readFile(path.join(this.eventsDir(), name), "utf8")
          )
        )
      );
    }
    return events.sort(
      (left, right) =>
        left.resultingLineageState.revision -
        right.resultingLineageState.revision
    );
  }

  private async acquireLock(): Promise<fs.FileHandle> {
    await fs.mkdir(this.rootDir, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await fs.open(this.lockPath(), "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await sleep(10);
      }
    }
    throw new Error("Timed out acquiring M20 baseline finalization lock.");
  }

  async readState(): Promise<NqaBaselineLineageState> {
    return applyChain(
      await this.ensureInitialized(),
      await this.readEventsUnlocked()
    );
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaBaselineFinalizationEvent | null> {
    const events = await this.listEvents();
    return events.find(item => item.transactionId === transactionId) ?? null;
  }

  async listEvents(): Promise<NqaBaselineFinalizationEvent[]> {
    const initial = await this.ensureInitialized();
    const events = await this.readEventsUnlocked();
    applyChain(initial, events);
    return structuredClone(events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaBaselineFinalizationEvent;
  }): Promise<NqaBaselineFinalizationAppendResult> {
    const lock = await this.acquireLock();
    try {
      const initial = await this.ensureInitialized();
      const events = await this.readEventsUnlocked();
      if (
        events.some(item => item.transactionId === input.event.transactionId)
      ) {
        return "EXISTS";
      }
      const state = applyChain(initial, events);
      if (
        state.revision !== input.expectedRevision ||
        state.stateFingerprint !== input.expectedStateFingerprint
      ) {
        return "CONFLICT";
      }
      validateTransition({ previous: state, event: input.event });
      await fs.mkdir(this.eventsDir(), { recursive: true });
      await fs.writeFile(
        path.join(
          this.eventsDir(),
          String(input.event.resultingLineageState.revision).padStart(8, "0") +
            "-" +
            input.event.transactionId +
            "-" +
            input.event.eventFingerprint +
            ".json"
        ),
        JSON.stringify(input.event, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
      return "COMMITTED";
    } finally {
      await lock.close();
      await fs.rm(this.lockPath(), { force: true });
    }
  }
}
