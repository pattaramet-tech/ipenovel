import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  NqaScopeExpansionAppendResult,
  NqaScopeExpansionEvent,
  NqaScopeExpansionState,
} from "./contracts";
import {
  buildNqaScopeExpansionState,
  hashNqaRolloutTargets,
  validateNqaMonotonicScopeExpansion,
  verifyNqaScopeExpansionAuthorizationWindow,
  verifyNqaScopeExpansionEvent,
  verifyNqaScopeExpansionState,
} from "./integrity";

export interface NqaScopeExpansionStore {
  readState(): Promise<NqaScopeExpansionState>;
  getEvent(transactionId: string): Promise<NqaScopeExpansionEvent | null>;
  listEvents(): Promise<NqaScopeExpansionEvent[]>;
  compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaScopeExpansionEvent;
  }): Promise<NqaScopeExpansionAppendResult>;
}

export function validateNqaScopeExpansionTransition(input: {
  previous: NqaScopeExpansionState;
  event: NqaScopeExpansionEvent;
}): void {
  const previous = verifyNqaScopeExpansionState(input.previous);
  const event = verifyNqaScopeExpansionEvent(input.event);
  verifyNqaScopeExpansionAuthorizationWindow({
    authorization: event.humanAuthorization,
    committedAt: event.committedAt,
  });
  const authorization = event.humanAuthorization;
  const sourceScope = previous.currentScope;
  const nextScope = event.resultingState.currentScope;
  const previousKeys = new Set(
    sourceScope.targets.map(target => target.row + ":" + target.chapter)
  );
  const expectedAddedTargets = nextScope.targets.filter(
    target => !previousKeys.has(target.row + ":" + target.chapter)
  );
  if (
    event.previousRevision !== previous.revision ||
    event.previousStateFingerprint !== previous.stateFingerprint ||
    event.sourceScope.scopeFingerprint !== sourceScope.scopeFingerprint ||
    authorization.sourceScopeId !== sourceScope.scopeId ||
    authorization.sourceScopeFingerprint !== sourceScope.scopeFingerprint ||
    authorization.soakArtifactFingerprint !==
      event.sourceSoakGate.artifactFingerprint ||
    authorization.expectedRegistryRevision !==
      sourceScope.expectedRegistryRevision ||
    authorization.expectedRegistryStateFingerprint !==
      sourceScope.expectedRegistryStateFingerprint ||
    authorization.sourceActivationTransactionId !==
      sourceScope.sourceActivationTransactionId ||
    authorization.candidatePolicyFingerprint !==
      sourceScope.candidatePolicyFingerprint ||
    authorization.baselinePolicyFingerprint !==
      sourceScope.baselinePolicyFingerprint ||
    authorization.proposedScopeId !== nextScope.scopeId ||
    authorization.proposedTargetsFingerprint !==
      hashNqaRolloutTargets(nextScope.targets) ||
    event.sourceSoakGate.decision !== "READY_FOR_SCOPE_EXPANSION_REVIEW" ||
    event.sourceSoakGate.scopeFingerprint !== sourceScope.scopeFingerprint ||
    event.sourceSoakGate.registryRevision !==
      sourceScope.expectedRegistryRevision ||
    event.sourceSoakGate.registryStateFingerprint !==
      sourceScope.expectedRegistryStateFingerprint ||
    JSON.stringify(event.addedTargets) !== JSON.stringify(expectedAddedTargets)
  ) {
    throw new Error("M19 scope expansion journal transition is invalid.");
  }
  validateNqaMonotonicScopeExpansion({
    previousScope: sourceScope,
    nextScope,
  });
}

function applyChain(
  initialState: NqaScopeExpansionState,
  events: readonly NqaScopeExpansionEvent[]
): NqaScopeExpansionState {
  let state = verifyNqaScopeExpansionState(initialState);
  for (const raw of [...events].sort(
    (left, right) =>
      left.resultingState.revision - right.resultingState.revision
  )) {
    const event = verifyNqaScopeExpansionEvent(raw);
    validateNqaScopeExpansionTransition({ previous: state, event });
    state = event.resultingState;
  }
  return verifyNqaScopeExpansionState(state);
}

export class InMemoryNqaScopeExpansionStore implements NqaScopeExpansionStore {
  private readonly initialState: NqaScopeExpansionState;
  private readonly events: NqaScopeExpansionEvent[] = [];

  constructor(initialScope: NqaScopeExpansionState["currentScope"]) {
    this.initialState = buildNqaScopeExpansionState({
      revision: 0,
      currentScope: initialScope,
      lastTransactionId: null,
    });
  }

  async readState(): Promise<NqaScopeExpansionState> {
    return structuredClone(applyChain(this.initialState, this.events));
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaScopeExpansionEvent | null> {
    const event = this.events.find(
      item => item.transactionId === transactionId
    );
    return event ? structuredClone(event) : null;
  }

  async listEvents(): Promise<NqaScopeExpansionEvent[]> {
    applyChain(this.initialState, this.events);
    return structuredClone(this.events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaScopeExpansionEvent;
  }): Promise<NqaScopeExpansionAppendResult> {
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
    validateNqaScopeExpansionTransition({
      previous: state,
      event: input.event,
    });
    this.events.push(structuredClone(input.event));
    return "COMMITTED";
  }
}

export class JsonFileNqaScopeExpansionStore implements NqaScopeExpansionStore {
  private readonly initialScope: NqaScopeExpansionState["currentScope"];

  constructor(
    private readonly rootDir: string,
    initialScope: NqaScopeExpansionState["currentScope"]
  ) {
    if (!rootDir.trim())
      throw new Error("M19 expansion store rootDir is required.");
    this.initialScope = structuredClone(initialScope);
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

  private async ensureInitialized(): Promise<NqaScopeExpansionState> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const expected = buildNqaScopeExpansionState({
      revision: 0,
      currentScope: this.initialScope,
      lastTransactionId: null,
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
    const existing = verifyNqaScopeExpansionState(
      JSON.parse(await fs.readFile(this.genesisPath(), "utf8"))
    );
    if (existing.stateFingerprint !== expected.stateFingerprint) {
      throw new Error(
        "M19 expansion store genesis does not match initial scope."
      );
    }
    return existing;
  }

  private async readEventsUnlocked(): Promise<NqaScopeExpansionEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.eventsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: NqaScopeExpansionEvent[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      events.push(
        verifyNqaScopeExpansionEvent(
          JSON.parse(
            await fs.readFile(path.join(this.eventsDir(), name), "utf8")
          )
        )
      );
    }
    return events.sort(
      (left, right) =>
        left.resultingState.revision - right.resultingState.revision
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
    throw new Error(
      "Timed out acquiring M19 scope expansion transaction lock."
    );
  }

  async readState(): Promise<NqaScopeExpansionState> {
    return applyChain(
      await this.ensureInitialized(),
      await this.readEventsUnlocked()
    );
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaScopeExpansionEvent | null> {
    const events = await this.listEvents();
    return events.find(item => item.transactionId === transactionId) ?? null;
  }

  async listEvents(): Promise<NqaScopeExpansionEvent[]> {
    const initial = await this.ensureInitialized();
    const events = await this.readEventsUnlocked();
    applyChain(initial, events);
    return structuredClone(events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaScopeExpansionEvent;
  }): Promise<NqaScopeExpansionAppendResult> {
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
      validateNqaScopeExpansionTransition({
        previous: state,
        event: input.event,
      });
      await fs.mkdir(this.eventsDir(), { recursive: true });
      await fs.writeFile(
        path.join(
          this.eventsDir(),
          String(input.event.resultingState.revision).padStart(8, "0") +
            "-" +
            input.event.transactionId +
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
