export const NQA_IDEMPOTENCY_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
] as const;

export type NqaIdempotencyStatus = (typeof NQA_IDEMPOTENCY_STATUSES)[number];

export type NqaIdempotencyEntry = {
  key: string;
  capability: string;
  requestFingerprint: string;
  principalId: string;
  status: NqaIdempotencyStatus;
  result: unknown | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NqaIdempotencyReservation =
  | {
      outcome: "RESERVED";
      entry: NqaIdempotencyEntry;
    }
  | {
      outcome: "EXISTS";
      entry: NqaIdempotencyEntry;
    };

export interface NqaIdempotencyStore {
  get(
    key: string
  ): Promise<NqaIdempotencyEntry | null> | NqaIdempotencyEntry | null;
  reserve(input: {
    key: string;
    capability: string;
    requestFingerprint: string;
    principalId: string;
    now: string;
  }): Promise<NqaIdempotencyReservation> | NqaIdempotencyReservation;
  complete(input: {
    key: string;
    result: unknown;
    now: string;
  }): Promise<NqaIdempotencyEntry> | NqaIdempotencyEntry;
  fail(input: {
    key: string;
    errorCode: string;
    now: string;
  }): Promise<NqaIdempotencyEntry> | NqaIdempotencyEntry;
}

function cloneEntry(entry: NqaIdempotencyEntry): NqaIdempotencyEntry {
  return {
    ...entry,
    result:
      entry.result && typeof entry.result === "object"
        ? structuredClone(entry.result)
        : entry.result,
  };
}

export class InMemoryNqaIdempotencyStore implements NqaIdempotencyStore {
  private readonly entries = new Map<string, NqaIdempotencyEntry>();

  get(key: string): NqaIdempotencyEntry | null {
    const entry = this.entries.get(key);
    return entry ? cloneEntry(entry) : null;
  }

  reserve(input: {
    key: string;
    capability: string;
    requestFingerprint: string;
    principalId: string;
    now: string;
  }): NqaIdempotencyReservation {
    const existing = this.entries.get(input.key);

    if (existing && existing.status !== "FAILED") {
      return {
        outcome: "EXISTS",
        entry: cloneEntry(existing),
      };
    }

    const next: NqaIdempotencyEntry = {
      key: input.key,
      capability: input.capability,
      requestFingerprint: input.requestFingerprint,
      principalId: input.principalId,
      status: "IN_PROGRESS",
      result: null,
      errorCode: null,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };

    this.entries.set(input.key, next);
    return {
      outcome: "RESERVED",
      entry: cloneEntry(next),
    };
  }

  complete(input: {
    key: string;
    result: unknown;
    now: string;
  }): NqaIdempotencyEntry {
    const existing = this.entries.get(input.key);
    if (!existing) {
      throw new Error(
        "Cannot complete an idempotency key that was not reserved."
      );
    }

    const next: NqaIdempotencyEntry = {
      ...existing,
      status: "COMPLETED",
      result:
        input.result && typeof input.result === "object"
          ? structuredClone(input.result)
          : input.result,
      errorCode: null,
      updatedAt: input.now,
    };
    this.entries.set(input.key, next);
    return cloneEntry(next);
  }

  fail(input: {
    key: string;
    errorCode: string;
    now: string;
  }): NqaIdempotencyEntry {
    const existing = this.entries.get(input.key);
    if (!existing) {
      throw new Error("Cannot fail an idempotency key that was not reserved.");
    }

    const next: NqaIdempotencyEntry = {
      ...existing,
      status: "FAILED",
      result: null,
      errorCode: input.errorCode,
      updatedAt: input.now,
    };
    this.entries.set(input.key, next);
    return cloneEntry(next);
  }
}
