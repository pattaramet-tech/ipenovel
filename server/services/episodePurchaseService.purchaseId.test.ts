import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * Service-level regression for R40R52R1: the wallet-purchase transaction must
 * decode Drizzle/mysql2 INSERT results correctly (mysql2 resolves INSERTs as
 * [ResultSetHeader, FieldPacket[]] - reading `.insertId` off the raw array is
 * always undefined) and must reach the wishlist notification producer with the
 * authoritative purchase id and the wallet-transaction link.
 *
 * The producer module is mocked here so the assertions prove the SERVICE
 * wiring (id extraction, link, reach, rollback contract); the notification
 * write behavior itself is qualified by episodePurchaseProducer.test.ts.
 */

const recordEpisodeWalletPurchaseIfEnabled = vi.hoisted(() =>
  vi.fn(async () => ({ status: "created" as const, eventKey: "k" }))
);
vi.mock("../notifications/episodePurchaseProducer", () => ({
  recordEpisodeWalletPurchaseIfEnabled,
}));

const assertMergeAllowed = vi.hoisted(() => vi.fn(async () => {}));
// Hoisted holder so the vi.mock factory can reach the per-test fake database
// (the factory is hoisted above any module-level declaration).
const dbRef = vi.hoisted(() => ({ current: undefined as any }));
vi.mock("../db", () => ({
  assertAccountMergeClassifiedMutationAllowed: assertMergeAllowed,
  getDb: vi.fn(async () => dbRef.current),
}));

vi.mock("./readerService", () => ({
  resolveSaleMode: vi.fn(() => "chapter"),
}));

interface FakeOptions {
  /** Result shape returned for the episodePurchases INSERT. */
  purchaseInsertResult: unknown;
  /** Result shape returned for the walletTransactions INSERT. */
  walletTxInsertResult: unknown;
  /** affectedRows surfaced for the wallet debit UPDATE. */
  debitAffectedRows: number | null;
  existingPurchases?: Array<Record<string, unknown>>;
  existingGifts?: Array<Record<string, unknown>>;
}

function buildWorld(options: FakeOptions) {
  const episode = {
    id: 9, novelId: 42, episodeNumber: "EP001", title: "T",
    price: "25.00", isFree: false, isPublished: true, saleMode: "chapter",
  };
  const wallet = { userId: 7, balance: "50.00" };
  const insertedWalletTransactions: Array<Record<string, unknown>> = [];
  const insertedPurchases: Array<Record<string, unknown>> = [];

  function rowsFor(table: any): Array<Record<string, unknown>> {
    const name = getTableName(table);
    if (name === "episodes") return [episode];
    if (name === "walletAccounts") return [wallet];
    if (name === "episodePurchases") return options.existingPurchases ?? [];
    if (name === "adminGiftEntitlements") return options.existingGifts ?? [];
    return [];
  }

  function selectChain(table: any) {
    return {
      where: () => ({
        limit: () => Promise.resolve(rowsFor(table)),
      }),
      limit: () => Promise.resolve(rowsFor(table)),
    };
  }

  const fakeTx: any = {
    select: (_fields: unknown) => ({ from: (table: any) => selectChain(table) }),
    update: (table: any) => ({
      set: (_values: Record<string, unknown>) => ({
        where: () => Promise.resolve(options.debitAffectedRows === null
          ? [ {} ] // unknown shape -> service falls back to balance re-verification
          : [ { affectedRows: options.debitAffectedRows }, [] ]),
      }),
    }),
    insert: (table: any) => {
      const name = getTableName(table);
      return {
        values(values: Record<string, unknown>) {
          if (name === "walletTransactions") {
            insertedWalletTransactions.push(values);
            return options.walletTxInsertResult;
          }
          if (name === "episodePurchases") {
            insertedPurchases.push(values);
            return options.purchaseInsertResult;
          }
          throw new Error(`unexpected insert target: ${name}`);
        },
      };
    },
  };

  const fakeDb: any = {
    select: (_fields: unknown) => ({ from: (table: any) => selectChain(table) }),
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(fakeTx),
  };

  dbRef.current = fakeDb;
  return { fakeDb, insertedWalletTransactions, insertedPurchases };
}

let service: typeof import("./episodePurchaseService");

beforeAll(async () => {
  service = await import("./episodePurchaseService");
});

beforeEach(() => {
  vi.clearAllMocks();
  recordEpisodeWalletPurchaseIfEnabled.mockClear();
  recordEpisodeWalletPurchaseIfEnabled.mockImplementation(
    async () => ({ status: "created" as const, eventKey: "event-key" })
  );
});

function baseOptions(): FakeOptions {
  return {
    purchaseInsertResult: [ { insertId: 777 }, [] ],
    walletTxInsertResult: [ { insertId: 888 }, [] ],
    debitAffectedRows: 1,
  };
}

describe("wallet purchase transaction id extraction (R40R52R1)", () => {
  it("reaches the notification producer with the authoritative purchase id from an ARRAY insert result", async () => {
    const world = buildWorld(baseOptions());
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(true);
    expect(result.episodePurchaseId).toBe(777);
    expect(recordEpisodeWalletPurchaseIfEnabled).toHaveBeenCalledTimes(1);
    expect(recordEpisodeWalletPurchaseIfEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseId: 777, userId: 7, env: process.env }),
    );
    expect(world.insertedPurchases).toHaveLength(1);
  });

  it("extracts the wallet transaction id from an ARRAY insert result and links it on the purchase row", async () => {
    const world = buildWorld(baseOptions());
    await service.purchaseEpisodeWithWallet(7, 9);
    expect(world.insertedWalletTransactions).toHaveLength(1);
    expect(world.insertedPurchases[0]).toMatchObject({ walletTransactionId: 888 });
  });

  it("stays compatible with flat ResultSetHeader results", async () => {
    const world = buildWorld({
      ...baseOptions(),
      purchaseInsertResult: { insertId: 777 },
      walletTxInsertResult: { insertId: 888 },
    });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(true);
    expect(result.episodePurchaseId).toBe(777);
    expect(world.insertedPurchases[0]).toMatchObject({ walletTransactionId: 888 });
  });

  it("succeeds WITHOUT emitting when the purchase id cannot be proven (fail closed)", async () => {
    const world = buildWorld({
      ...baseOptions(),
      purchaseInsertResult: [ {}, [] ], // no insertId
    });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(true);
    expect(result.episodePurchaseId).toBeUndefined();
    expect(recordEpisodeWalletPurchaseIfEnabled).not.toHaveBeenCalled();
    // Debit + ledger still happened inside the transaction.
    expect(world.insertedWalletTransactions).toHaveLength(1);
  });
});

describe("purchase flow regression through the service", () => {
  it("does not debit or notify for an already-purchased episode", async () => {
    const world = buildWorld({
      ...baseOptions(),
      existingPurchases: [ { id: 1, userId: 7, episodeId: 9 } ],
    });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(false);
    expect(result.alreadyPurchased).toBe(true);
    expect(world.insertedWalletTransactions).toHaveLength(0);
    expect(world.insertedPurchases).toHaveLength(0);
    expect(recordEpisodeWalletPurchaseIfEnabled).not.toHaveBeenCalled();
  });

  it("does not debit or notify for a gifted episode", async () => {
    const world = buildWorld({
      ...baseOptions(),
      existingGifts: [ { id: 2, userId: 7, episodeId: 9 } ],
    });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(false);
    expect(result.alreadyPurchased).toBe(true);
    expect(world.insertedWalletTransactions).toHaveLength(0);
    expect(world.insertedPurchases).toHaveLength(0);
  });

  it("fails the purchase atomically when the entitlement insert fails (producer never reached)", async () => {
    const world = buildWorld({
      ...baseOptions(),
      purchaseInsertResult: Promise.reject(new Error("entitlement insert failed")),
    });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(false);
    expect(recordEpisodeWalletPurchaseIfEnabled).not.toHaveBeenCalled();
  });

  it("rolls the purchase back when the notification infrastructure fails mid-transaction", async () => {
    const world = buildWorld(baseOptions());
    recordEpisodeWalletPurchaseIfEnabled.mockRejectedValueOnce(new Error("notification infra down"));
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    // Money-safe: the purchase fails as a whole (no partial debit committed);
    // the buyer retries. No partial event/outbox can survive a rollback.
    expect(result.success).toBe(false);
  });

  it("does not notify when the atomic debit matches no row (insufficient balance)", async () => {
    const world = buildWorld({ ...baseOptions(), debitAffectedRows: 0 });
    const result = await service.purchaseEpisodeWithWallet(7, 9);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INSUFFICIENT_WALLET_BALANCE_ATOMIC");
    expect(recordEpisodeWalletPurchaseIfEnabled).not.toHaveBeenCalled();
  });
});
