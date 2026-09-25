import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  NqaPolicyTransactionEventSchema,
  type NqaActivationStoreAppendResult,
  type NqaPolicyRegistryState,
  type NqaPolicyTransactionEvent,
} from "./contracts";
import {
  buildNqaPolicyRegistryState,
  verifyNqaAuthorizationWindow,
  verifyNqaPolicyRegistryState,
  verifyNqaPolicyTransactionEvent,
} from "./integrity";

export interface NqaPolicyActivationStore {
  readState(): Promise<NqaPolicyRegistryState>;
  getEvent(transactionId: string): Promise<NqaPolicyTransactionEvent | null>;
  listEvents(): Promise<NqaPolicyTransactionEvent[]>;
  compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaPolicyTransactionEvent;
  }): Promise<NqaActivationStoreAppendResult>;
}

function validateEventTransition(input: {
  previousState: NqaPolicyRegistryState;
  event: NqaPolicyTransactionEvent;
}): void {
  const previous = input.previousState;
  const event = input.event;
  const authorization = event.humanAuthorization;

  verifyNqaAuthorizationWindow({
    authorization,
    committedAt: event.committedAt,
  });

  if (
    authorization.expectedRegistryRevision !== previous.revision ||
    authorization.expectedActivePolicyFingerprint !==
      previous.activePolicyFingerprint
  ) {
    throw new Error(
      "NQA policy transaction authorization does not match journal state."
    );
  }

  if (event.kind === "ACTIVATE") {
    if (
      authorization.action !== "ACTIVATE" ||
      authorization.readinessArtifactFingerprint !==
        event.sourceReadiness.artifactFingerprint ||
      authorization.targetPolicyFingerprint !==
        event.resultingState.activePolicyFingerprint ||
      event.resultingState.activePolicyFingerprint !==
        event.sourceReadiness.candidatePolicyFingerprint ||
      event.sourceMaterializedPolicyArtifactFingerprint !==
        event.sourceReadiness.materializedPolicyArtifactFingerprint
    ) {
      throw new Error("NQA activation journal transition is invalid.");
    }

    const rollbackTarget = event.resultingState.rollbackTarget;
    if (
      !rollbackTarget ||
      rollbackTarget.policyVersion !== previous.activePolicyVersion ||
      rollbackTarget.policyFingerprint !== previous.activePolicyFingerprint ||
      JSON.stringify(rollbackTarget.policy) !==
        JSON.stringify(previous.activePolicy) ||
      rollbackTarget.sourceActivationTransactionId !== event.transactionId ||
      rollbackTarget.sourceReadinessArtifactFingerprint !==
        event.sourceReadiness.artifactFingerprint
    ) {
      throw new Error(
        "NQA activation journal rollback target does not preserve previous policy."
      );
    }
    return;
  }

  const rollbackTarget = previous.rollbackTarget;
  if (
    authorization.action !== "ROLLBACK" ||
    !rollbackTarget ||
    authorization.sourceActivationTransactionId !==
      event.rolledBackActivationTransactionId ||
    rollbackTarget.sourceActivationTransactionId !==
      event.rolledBackActivationTransactionId ||
    authorization.targetPolicyFingerprint !==
      rollbackTarget.policyFingerprint ||
    event.resultingState.activePolicyFingerprint !==
      rollbackTarget.policyFingerprint ||
    JSON.stringify(event.resultingState.activePolicy) !==
      JSON.stringify(rollbackTarget.policy) ||
    event.resultingState.rollbackTarget !== null
  ) {
    throw new Error("NQA rollback journal transition is invalid.");
  }
}

function applyAndValidateChain(
  initialState: NqaPolicyRegistryState,
  events: readonly NqaPolicyTransactionEvent[]
): NqaPolicyRegistryState {
  let state = verifyNqaPolicyRegistryState(initialState);
  for (const raw of [...events].sort(
    (left, right) => left.nextRevision - right.nextRevision
  )) {
    const event = verifyNqaPolicyTransactionEvent(raw);
    if (
      event.previousRevision !== state.revision ||
      event.previousStateFingerprint !== state.stateFingerprint ||
      event.previousActivePolicyVersion !== state.activePolicyVersion ||
      event.previousActivePolicyFingerprint !== state.activePolicyFingerprint
    ) {
      throw new Error("NQA policy transaction journal chain is invalid.");
    }
    validateEventTransition({ previousState: state, event });
    state = verifyNqaPolicyRegistryState(event.resultingState);
  }
  return state;
}

export class InMemoryNqaPolicyActivationStore implements NqaPolicyActivationStore {
  private readonly initialState: NqaPolicyRegistryState;
  private readonly events: NqaPolicyTransactionEvent[] = [];

  constructor(initialPolicy: NqaAlignmentPolicy) {
    this.initialState = buildNqaPolicyRegistryState({
      revision: 0,
      activePolicy: initialPolicy,
      rollbackTarget: null,
      lastTransactionId: null,
    });
  }

  async readState(): Promise<NqaPolicyRegistryState> {
    return structuredClone(
      applyAndValidateChain(this.initialState, this.events)
    );
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaPolicyTransactionEvent | null> {
    const value = this.events.find(
      item => item.transactionId === transactionId
    );
    return value ? structuredClone(value) : null;
  }

  async listEvents(): Promise<NqaPolicyTransactionEvent[]> {
    return structuredClone(this.events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaPolicyTransactionEvent;
  }): Promise<NqaActivationStoreAppendResult> {
    const existing = this.events.find(
      item => item.transactionId === input.event.transactionId
    );
    if (existing) return "EXISTS";

    const state = applyAndValidateChain(this.initialState, this.events);
    if (
      state.revision !== input.expectedRevision ||
      state.stateFingerprint !== input.expectedStateFingerprint
    ) {
      return "CONFLICT";
    }

    const event = verifyNqaPolicyTransactionEvent(input.event);
    if (
      event.previousRevision !== state.revision ||
      event.previousStateFingerprint !== state.stateFingerprint
    ) {
      return "CONFLICT";
    }
    validateEventTransition({ previousState: state, event });
    this.events.push(structuredClone(event));
    return "COMMITTED";
  }
}

export class JsonFileNqaPolicyActivationStore implements NqaPolicyActivationStore {
  private readonly initialPolicy: NqaAlignmentPolicy;

  constructor(
    private readonly rootDir: string,
    initialPolicy: NqaAlignmentPolicy
  ) {
    if (!rootDir.trim()) {
      throw new Error("Policy activation store rootDir is required.");
    }
    this.initialPolicy = structuredClone(initialPolicy);
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

  private async ensureInitialized(): Promise<NqaPolicyRegistryState> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const expected = buildNqaPolicyRegistryState({
      revision: 0,
      activePolicy: this.initialPolicy,
      rollbackTarget: null,
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

    const content = await fs.readFile(this.genesisPath(), "utf8");
    const existing = verifyNqaPolicyRegistryState(JSON.parse(content));
    if (existing.stateFingerprint !== expected.stateFingerprint) {
      throw new Error(
        "Policy activation store genesis does not match initial policy."
      );
    }
    return existing;
  }

  private async readEventsUnlocked(): Promise<NqaPolicyTransactionEvent[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.eventsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: NqaPolicyTransactionEvent[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const content = await fs.readFile(
        path.join(this.eventsDir(), name),
        "utf8"
      );
      events.push(NqaPolicyTransactionEventSchema.parse(JSON.parse(content)));
    }
    return events.sort((left, right) => left.nextRevision - right.nextRevision);
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
      "Timed out acquiring NQA policy activation transaction lock."
    );
  }

  async readState(): Promise<NqaPolicyRegistryState> {
    const initialState = await this.ensureInitialized();
    return applyAndValidateChain(initialState, await this.readEventsUnlocked());
  }

  async getEvent(
    transactionId: string
  ): Promise<NqaPolicyTransactionEvent | null> {
    const events = await this.listEvents();
    return events.find(item => item.transactionId === transactionId) ?? null;
  }

  async listEvents(): Promise<NqaPolicyTransactionEvent[]> {
    await this.ensureInitialized();
    const events = await this.readEventsUnlocked();
    applyAndValidateChain(
      verifyNqaPolicyRegistryState(
        JSON.parse(await fs.readFile(this.genesisPath(), "utf8"))
      ),
      events
    );
    return structuredClone(events);
  }

  async compareAndAppend(input: {
    expectedRevision: number;
    expectedStateFingerprint: string;
    event: NqaPolicyTransactionEvent;
  }): Promise<NqaActivationStoreAppendResult> {
    const lock = await this.acquireLock();
    try {
      const initialState = await this.ensureInitialized();
      const events = await this.readEventsUnlocked();
      if (
        events.some(item => item.transactionId === input.event.transactionId)
      ) {
        return "EXISTS";
      }

      const state = applyAndValidateChain(initialState, events);
      if (
        state.revision !== input.expectedRevision ||
        state.stateFingerprint !== input.expectedStateFingerprint
      ) {
        return "CONFLICT";
      }

      const event = verifyNqaPolicyTransactionEvent(input.event);
      if (
        event.previousRevision !== state.revision ||
        event.previousStateFingerprint !== state.stateFingerprint
      ) {
        return "CONFLICT";
      }
      validateEventTransition({ previousState: state, event });

      await fs.mkdir(this.eventsDir(), { recursive: true });
      const fileName =
        String(event.nextRevision).padStart(8, "0") +
        "-" +
        event.transactionId +
        "-" +
        event.eventFingerprint +
        ".json";
      await fs.writeFile(
        path.join(this.eventsDir(), fileName),
        JSON.stringify(event, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
      return "COMMITTED";
    } finally {
      await lock.close();
      await fs.rm(this.lockPath(), { force: true });
    }
  }
}
