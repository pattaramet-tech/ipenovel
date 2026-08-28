import { describe, expect, it } from "vitest";
import {
  claimSlip,
  describeClaimFailure,
  type SlipClaimSourceType,
} from "./slipClaimService";
import {
  deriveStrongIdentifiersFromExtractedData,
  hasStrongIdentifier,
  hashSlipReference,
} from "./slipIdentifierService";

/**
 * Anti-replay claim tests.
 *
 * These run against an in-memory fake that reproduces the ONE property the
 * real guarantee rests on: UNIQUE indexes on referenceHash / fileHash /
 * qrPayloadHash, with MySQL's "multiple NULLs are allowed" semantics.
 *
 * No database is required, and none is contacted. The fake is deliberately
 * strict about the unique-key behavior because that - not application
 * sequencing - is what serializes concurrent claimants.
 */

/** Every 64-hex value bound into a drizzle condition tree. */
function boundHashes(cond: any): string[] {
  const found: string[] = [];
  const walk = (n: any, d = 0) => {
    // Depth 12: an and(eq, eq) (used by the paymentSlipLegacyCollisions
    // lookup) nests the bound Param deeper than the single eq() this was
    // originally sized for - a shallow limit silently found no hashes at all.
    if (!n || d > 12) return;
    if (typeof n === "string" && /^[0-9a-f]{64}$/.test(n)) found.push(n);
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    if (typeof n === "object") for (const k of Object.keys(n)) walk((n as any)[k], d + 1);
  };
  walk(cond);
  return found;
}

/**
 * The claim columns a condition actually targets. Read from `queryChunks`
 * rather than by walking the whole tree, because each condition embeds the
 * entire table object and a naive walk would report every column.
 */
function targetedColumns(cond: any): string[] {
  const known = ["referenceHash", "legacyReferenceUpperHash", "fileHash", "qrPayloadHash"];
  const names = new Set<string>();
  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    for (const chunk of node.queryChunks ?? []) {
      if (chunk && typeof chunk === "object") {
        if (typeof chunk.name === "string" && known.includes(chunk.name)) names.add(chunk.name);
        visit(chunk, depth + 1);
      }
    }
  };
  visit(cond);
  return names.size ? [...names] : known;
}

class FakeDupError extends Error {
  code = "ER_DUP_ENTRY";
  errno = 1062;
}

interface FakeRow {
  id: number;
  sourceType: SlipClaimSourceType;
  sourceId: number;
  userId: number;
  referenceHash: string | null;
  fileHash: string | null;
  qrPayloadHash: string | null;
  semanticFingerprint: string | null;
  claimedAt: Date;
}

/**
 * Minimal drizzle-shaped stub. Only the surface slipClaimService actually
 * uses is implemented; anything else would be untested scaffolding.
 */
function makeFakeTx(
  options: {
    legacyCollisions?: Array<{
      kind: "reference" | "file" | "qr";
      identifierHash: string;
      sourceType: SlipClaimSourceType;
      sourceId: number;
    }>;
  } = {}
) {
  const rows: FakeRow[] = [];
  const legacyCollisions = options.legacyCollisions ?? [];
  let nextId = 1;

  // Mirrors the three UNIQUE indexes. NULL never participates, matching
  // MySQL/MariaDB - so reference-less slips never collide with each other.
  function assertUnique(candidate: Partial<FakeRow>) {
    for (const key of ["referenceHash", "fileHash", "qrPayloadHash"] as const) {
      const value = candidate[key];
      if (value === null || value === undefined) continue;
      if (rows.some((r) => r[key] === value)) {
        throw new FakeDupError(`Duplicate entry for key 'paymentSlipClaims_${key}_unique'`);
      }
    }
  }

  const tx = {
    insert() {
      return {
        async values(v: any) {
          assertUnique(v);
          const row: FakeRow = { id: nextId++, ...v };
          rows.push(row);
          return [{ insertId: row.id }];
        },
      };
    },
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          return {
            where(cond: any) {
              // The legacy compatibility scan pages with .orderBy().limit();
              // the claim registry lookup uses .limit() directly. This fake
              // has no historical records, so the legacy scan finds none -
              // those paths are covered in
              // legacySlipCompatibilityService.test.ts.
              const emptyLegacyPage = () => Promise.resolve([]);

              // Registry lookups must FILTER, not return everything: the
              // conflict evaluator now performs a registry preflight on every
              // claim, so a fake that ignores the predicate would report any
              // unrelated existing claim as a duplicate.
              const wanted = boundHashes(cond);
              const cols = targetedColumns(cond);
              const matching = () =>
                rows.filter((r) =>
                  cols.some((c) => {
                    const v = (r as any)[c];
                    return v && wanted.includes(v);
                  })
                );

              return {
                orderBy() {
                  return { limit: emptyLegacyPage };
                },
                limit(n: number) {
                  if (name === "payments" || name === "walletTopups") {
                    return emptyLegacyPage();
                  }
                  if (name === "paymentSlipLegacyCollisions") {
                    if (wanted.length === 0) return Promise.resolve([]);
                    return Promise.resolve(
                      legacyCollisions
                        .filter((c) => wanted.includes(c.identifierHash))
                        .map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId }))
                        .slice(0, n)
                    );
                  }
                  if (wanted.length === 0) return Promise.resolve([]);
                  return Promise.resolve(matching().slice(0, n));
                },
              };
            },
          };
        },
      };
    },
    _rows: rows,
  };
  return tx;
}

const REF_A = hashSlipReference("016234222922AQR05745")!;
const REF_B = hashSlipReference("016234210331AQR07912")!;

function baseRequest(overrides: Partial<Parameters<typeof claimSlip>[0]> = {}) {
  return {
    sourceType: "order_payment" as SlipClaimSourceType,
    sourceId: 1,
    userId: 10,
    identifiers: { referenceHash: REF_A },
    semanticFingerprint: "weak-abc",
    ...overrides,
  };
}

describe("claimSlip - strong identifier claiming", () => {
  it("claims a slip that no one owns yet", async () => {
    const tx = makeFakeTx();
    const result = await claimSlip(baseRequest(), tx);
    expect(result.claimed).toBe(true);
    if (result.claimed) expect(result.claimedKinds).toContain("reference");
  });

  it("refuses a slip with NO strong identifier - replay could not be prevented", async () => {
    const tx = makeFakeTx();
    const result = await claimSlip(baseRequest({ identifiers: {} }), tx);
    expect(result.claimed).toBe(false);
    if (!result.claimed) expect(result.reason).toBe("no_strong_identifier");
  });

  it("a second claim on the same reference fails - one transaction, one value", async () => {
    const tx = makeFakeTx();
    await claimSlip(baseRequest(), tx);
    const second = await claimSlip(baseRequest({ sourceId: 2, userId: 99 }), tx);
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.reason).toBe("already_claimed");
  });

  it("blocks replay ACROSS sources - an order slip cannot fund a wallet top-up", async () => {
    const tx = makeFakeTx();
    await claimSlip(baseRequest({ sourceType: "order_payment", sourceId: 1 }), tx);
    const walletReplay = await claimSlip(
      baseRequest({ sourceType: "wallet_topup", sourceId: 77, userId: 12345 }),
      tx
    );
    expect(walletReplay.claimed).toBe(false);
  });

  it("blocks replay ACROSS users", async () => {
    const tx = makeFakeTx();
    await claimSlip(baseRequest({ userId: 10 }), tx);
    const otherUser = await claimSlip(baseRequest({ sourceId: 5, userId: 20 }), tx);
    expect(otherUser.claimed).toBe(false);
  });

  it("a different reference is unaffected", async () => {
    const tx = makeFakeTx();
    await claimSlip(baseRequest(), tx);
    const other = await claimSlip(
      baseRequest({ sourceId: 2, identifiers: { referenceHash: REF_B } }),
      tx
    );
    expect(other.claimed).toBe(true);
  });

  it("an exact file-hash duplicate is blocked even with no reference", async () => {
    const tx = makeFakeTx();
    const fileHash = "f".repeat(64);
    await claimSlip(baseRequest({ identifiers: { fileHash } }), tx);
    const replay = await claimSlip(baseRequest({ sourceId: 2, identifiers: { fileHash } }), tx);
    expect(replay.claimed).toBe(false);
  });

  it("a QR payload-hash duplicate is blocked", async () => {
    const tx = makeFakeTx();
    const qrPayloadHash = "a".repeat(64);
    await claimSlip(baseRequest({ identifiers: { qrPayloadHash } }), tx);
    const replay = await claimSlip(
      baseRequest({ sourceId: 2, identifiers: { qrPayloadHash } }),
      tx
    );
    expect(replay.claimed).toBe(false);
  });

  it("two reference-less slips do NOT collide with each other (NULLs are free)", async () => {
    const tx = makeFakeTx();
    const a = await claimSlip(baseRequest({ identifiers: { fileHash: "1".repeat(64) } }), tx);
    const b = await claimSlip(
      baseRequest({ sourceId: 2, identifiers: { fileHash: "2".repeat(64) } }),
      tx
    );
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
  });
});

// IPE-004: known historical collisions are durable and never picked a winner.
describe("claimSlip - known_collision (durable, no historical winner)", () => {
  it("refuses to claim a reference that durably matches a known historical collision", async () => {
    const tx = makeFakeTx({
      legacyCollisions: [
        { kind: "reference", identifierHash: REF_A, sourceType: "order_payment", sourceId: 5 },
      ],
    });

    const result = await claimSlip(baseRequest({ identifiers: { referenceHash: REF_A } }), tx);

    expect(result.claimed).toBe(false);
    if (!result.claimed) {
      expect(result.reason).toBe("known_collision");
      if (result.reason === "known_collision") {
        expect(result.requiresAdminResolution).toBe(false);
        expect(result.matchedSourceType).toBe("order_payment");
        expect(result.matchedSourceId).toBe(5);
      }
    }
  });

  it("refuses to claim a fileHash that durably matches a known FILE collision", async () => {
    const FILE_X = "f".repeat(64);
    const tx = makeFakeTx({
      legacyCollisions: [
        { kind: "file", identifierHash: FILE_X, sourceType: "wallet_topup", sourceId: 3 },
      ],
    });

    const result = await claimSlip(
      baseRequest({ identifiers: { fileHash: FILE_X } }),
      tx
    );

    expect(result.claimed).toBe(false);
    if (!result.claimed && result.reason === "known_collision") {
      expect(result.conflictKind).toBe("file");
    }
  });

  it("no paymentSlipClaims row is ever inserted for a known collision - no winner is picked", async () => {
    const tx: any = makeFakeTx({
      legacyCollisions: [
        { kind: "reference", identifierHash: REF_A, sourceType: "order_payment", sourceId: 5 },
      ],
    });

    await claimSlip(baseRequest({ identifiers: { referenceHash: REF_A } }), tx);
    expect(tx._rows).toHaveLength(0);
  });

  it("an unrelated reference is NOT affected by a collision recorded under a different hash", async () => {
    const tx = makeFakeTx({
      legacyCollisions: [
        { kind: "reference", identifierHash: REF_B, sourceType: "order_payment", sourceId: 5 },
      ],
    });

    const result = await claimSlip(baseRequest({ identifiers: { referenceHash: REF_A } }), tx);
    expect(result.claimed).toBe(true);
  });

  it("describeClaimFailure never claims proof and never leaks a hash for known_collision", () => {
    const msg = describeClaimFailure({
      claimed: false,
      reason: "known_collision",
      conflictKind: "reference",
      matchedSourceType: "order_payment",
      matchedSourceId: 5,
      requiresAdminResolution: false,
    });
    expect(msg).toMatch(/NOT proof/i);
    expect(msg).toMatch(/order payment #5/);
    expect(msg).not.toMatch(new RegExp(REF_A));
  });
});

describe("claimSlip - concurrency", () => {
  it("of two concurrent claims on one slip, AT MOST ONE succeeds", async () => {
    const tx = makeFakeTx();

    const [first, second] = await Promise.all([
      claimSlip(baseRequest({ sourceId: 1, userId: 10 }), tx),
      claimSlip(baseRequest({ sourceId: 2, userId: 20 }), tx),
    ]);

    const successes = [first, second].filter((r) => r.claimed).length;
    expect(successes).toBe(1);
  });

  it("many concurrent claims on one slip yield exactly one winner", async () => {
    const tx = makeFakeTx();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimSlip(baseRequest({ sourceId: i + 1, userId: i + 1 }), tx)
      )
    );

    expect(results.filter((r) => r.claimed).length).toBe(1);
    expect(results.filter((r) => !r.claimed).length).toBe(11);
  });

  it("the losers report already_claimed, never a crash", async () => {
    const tx = makeFakeTx();
    const results = await Promise.all([
      claimSlip(baseRequest({ sourceId: 1 }), tx),
      claimSlip(baseRequest({ sourceId: 2 }), tx),
      claimSlip(baseRequest({ sourceId: 3 }), tx),
    ]);
    for (const r of results.filter((x) => !x.claimed)) {
      expect(r.claimed).toBe(false);
      if (!r.claimed) expect(r.reason).toBe("already_claimed");
    }
  });
});

describe("claimSlip - infrastructure errors are not swallowed", () => {
  it("a non-duplicate error propagates so the outer transaction rolls back", async () => {
    const brokenTx = {
      // The legacy lookup runs first and must succeed, so this test isolates
      // a failure of the INSERT itself.
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return { limit: async () => [] };
                  },
                  limit: async () => [],
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          async values() {
            throw new Error("ER_LOCK_WAIT_TIMEOUT: lock wait timeout exceeded");
          },
        };
      },
    };
    await expect(claimSlip(baseRequest(), brokenTx)).rejects.toThrow(/lock wait timeout/i);
  });
});

describe("weak fingerprint is never a claim", () => {
  it("two slips sharing only a semanticFingerprint both claim successfully", async () => {
    const tx = makeFakeTx();
    const a = await claimSlip(
      baseRequest({ identifiers: { referenceHash: REF_A }, semanticFingerprint: "same-weak" }),
      tx
    );
    const b = await claimSlip(
      baseRequest({
        sourceId: 2,
        identifiers: { referenceHash: REF_B },
        semanticFingerprint: "same-weak",
      }),
      tx
    );
    // Same bank/account/amount/date, DIFFERENT reference: two legitimate
    // transfers. Both must be allowed to create value.
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
  });
});

describe("describeClaimFailure", () => {
  it("explains a missing strong identifier without leaking anything", () => {
    const msg = describeClaimFailure({ claimed: false, reason: "no_strong_identifier" });
    expect(msg).toMatch(/no strong identifier/i);
    expect(msg).toMatch(/manual review/i);
  });

  it("names the owning submission when known", () => {
    const msg = describeClaimFailure({
      claimed: false,
      reason: "already_claimed",
      conflictKind: "reference",
      existingSourceType: "wallet_topup",
      existingSourceId: 123,
    });
    expect(msg).toMatch(/wallet top-up #123/i);
  });

  it("never includes a hash, URL, or credential", () => {
    const msg = describeClaimFailure({
      claimed: false,
      reason: "already_claimed",
      conflictKind: "file",
      existingSourceType: "order_payment",
      existingSourceId: 9,
    });
    expect(msg).not.toMatch(/[0-9a-f]{32,}/);
    expect(msg).not.toMatch(/https?:/i);
  });
});

describe("deriveStrongIdentifiersFromExtractedData - server-side, never client-trusted", () => {
  it("recomputes a reference hash for a LEGACY row that stored only `reference`", () => {
    const legacy = JSON.stringify({ reference: "016234222922AQR05745", amount: 100 });
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(legacy);
    expect(identifiers.referenceHash).toBe(hashSlipReference("016234222922AQR05745"));
    expect(hasStrongIdentifier(identifiers)).toBe(true);
  });

  it("prefers referenceRaw (original casing) over the upper-cased legacy field", () => {
    const row = JSON.stringify({
      reference: "202608225APOYXELGDOO7YVWV",
      referenceRaw: "202608225ApOyxElgdOo7YVwv",
    });
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(row);
    expect(identifiers.referenceHash).toBe(hashSlipReference("202608225ApOyxElgdOo7YVwv"));
  });

  it("yields no identifier for a row with no readable reference", () => {
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(
      JSON.stringify({ amount: 100 })
    );
    expect(hasStrongIdentifier(identifiers)).toBe(false);
  });

  it("fails safe on malformed JSON instead of throwing", () => {
    expect(() => deriveStrongIdentifiersFromExtractedData("{not json")).not.toThrow();
    expect(hasStrongIdentifier(deriveStrongIdentifiersFromExtractedData("{not json").identifiers)).toBe(
      false
    );
  });

  it("fails safe on null/undefined", () => {
    expect(hasStrongIdentifier(deriveStrongIdentifiersFromExtractedData(null).identifiers)).toBe(
      false
    );
    expect(
      hasStrongIdentifier(deriveStrongIdentifiersFromExtractedData(undefined).identifiers)
    ).toBe(false);
  });
});
