import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPaymentQrConfig } from "../../shared/paymentQr";
import fixture from "./fixtures/merchant-qr.synthetic.json";

const databaseMock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => databaseMock);
const generator = vi.hoisted(() => ({ generateMerchantQrPayload: vi.fn() }));
vi.mock("./merchantQr", () => generator);
import { decodePaymentQrConfig, readPaymentQrConfig, savePaymentQrConfig } from "./qrSettings";
import { paymentQrSettingsRouter } from "./qrRouter";
import { getPaymentQr } from "./qrService";

// In-memory transaction boundary: executes real service code, rolls back writes
// on a rejected audit/config transaction. No network or ambient database.
let state: { config?: string; audits: any[] };
let failAudit = false;
function memoryDatabase() {
  const tx: any = {
    select: () => ({ from: () => ({ where: () => ({
      limit: () => {
        const rows = state.config === undefined ? [] : [{ value: state.config }];
        const result: any = Promise.resolve(rows);
        result.for = () => Promise.resolve(rows);
        return result;
      },
    }) }) }),
    insert: () => ({ values: (row: any) => {
      if (row.key === "paymentQr.config") return { onDuplicateKeyUpdate: async () => {
        state.config ??= row.value;
      } };
      if (failAudit) throw Error("audit unavailable");
      state.audits.push(row);
      return Promise.resolve();
    } }),
    update: () => ({ set: (row: any) => ({ where: async () => { state.config = row.value; } }) }),
    transaction: async (fn: any) => {
      const before = structuredClone(state);
      try { return await fn(tx); } catch (error) { state = before; throw error; }
    },
  };
  return tx;
}
const ctx = (role: string | null) => ({ user: role ? { id: 7, role } : null, req: { headers: {} }, res: {} }) as any;
beforeEach(() => {
  vi.clearAllMocks(); state = { audits: [] }; failAudit = false;
  databaseMock.getDb.mockResolvedValue(memoryDatabase());
  generator.generateMerchantQrPayload.mockImplementation(() => fixture.oneBaht);
});
describe("runtime QR Settings and recovery", () => {
  it("defaults to the original QR without loading the generator", async () => {
    expect(await readPaymentQrConfig()).toEqual(defaultPaymentQrConfig);
    expect(generator.generateMerchantQrPayload).not.toHaveBeenCalled();
  });
  it("persists generated -> static -> generated and audits actor/reason atomically", async () => {
    const caller = paymentQrSettingsRouter.createCaller(ctx("admin"));
    const first = await caller.update({ mode: "generated", merchantTemplate: fixture.template, expectedRevision: 0, reason: "enable" });
    expect(first.revision).toBe(1);
    expect((await caller.get()).mode).toBe("generated");
    generator.generateMerchantQrPayload.mockImplementation(() => { throw Error("broken engine"); });
    const staticConfig = await caller.update({ mode: "static", expectedRevision: 1, reason: "outage" });
    expect(staticConfig.mode).toBe("static");
    expect((await caller.get()).revision).toBe(2);
    expect(generator.generateMerchantQrPayload).toHaveBeenCalledTimes(1);
    generator.generateMerchantQrPayload.mockImplementation(() => fixture.oneBaht);
    await caller.update({ mode: "generated", expectedRevision: 2, reason: "recovered" });
    expect((await caller.get()).mode).toBe("generated");
    expect(state.audits.map(a => JSON.parse(a.value))).toMatchObject([
      { actorId: 7, reason: "enable", from: "static", to: "generated", revision: 1 },
      { actorId: 7, reason: "outage", from: "generated", to: "static", revision: 2 },
      { actorId: 7, reason: "recovered", from: "static", to: "generated", revision: 3 },
    ]);
    expect(JSON.stringify(state.audits)).not.toContain(fixture.template);
  });
  it("recovers even with a corrupt template; generator not invoked", async () => {
    state.config = JSON.stringify({ ...defaultPaymentQrConfig, mode: "generated", merchantTemplate: "broken template" });
    generator.generateMerchantQrPayload.mockImplementation(() => { throw Error("invalid"); });
    await savePaymentQrConfig({ mode: "static", expectedRevision: 0, reason: "recover" }, 7);
    expect((await readPaymentQrConfig()).mode).toBe("static");
    expect(generator.generateMerchantQrPayload).not.toHaveBeenCalled();
  });
  it("rejects enabling generated QR when validation fails without changing current mode", async () => {
    generator.generateMerchantQrPayload.mockImplementation(() => { throw Error("private exception"); });
    await expect(savePaymentQrConfig({ mode: "generated", expectedRevision: 0, reason: "try" }, 7)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await readPaymentQrConfig()).mode).toBe("static");
    expect(state.audits).toEqual([]);
  });
  it("rejects stale admin revisions instead of overwriting a recovery switch", async () => {
    await savePaymentQrConfig({ mode: "static", expectedRevision: 0, reason: "recover" }, 7);
    await expect(savePaymentQrConfig({ mode: "generated", expectedRevision: 0, reason: "stale" }, 7)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await readPaymentQrConfig()).revision).toBe(1);
  });
  it("rolls back config when the audit write fails", async () => {
    state.config = JSON.stringify(defaultPaymentQrConfig); failAudit = true;
    await expect(savePaymentQrConfig({ mode: "generated", merchantTemplate: fixture.template, expectedRevision: 0, reason: "enable" }, 7)).rejects.toThrow("audit unavailable");
    expect((await readPaymentQrConfig()).revision).toBe(0);
  });
  it("does not return save success when DB is unavailable", async () => {
    databaseMock.getDb.mockResolvedValue(undefined);
    await expect(savePaymentQrConfig({ mode: "static", expectedRevision: 0, reason: "recover" }, 7)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(readPaymentQrConfig()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it.each([null, "user"])("refuses settings read/write for %s", async role => {
    const caller = paymentQrSettingsRouter.createCaller(ctx(role));
    await expect(caller.get()).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    await expect(caller.update({ mode: "static", expectedRevision: 0, reason: "denied" })).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    expect(databaseMock.getDb).not.toHaveBeenCalled();
  });
  it.each(["http://example.com/qr.png", "https://d2xsxph8kpxj0f.cloudfront.net/qr.png", "https://user:password@example.com/qr.png"])("rejects unsafe static URL %s", async staticImageUrl => {
    await expect(savePaymentQrConfig({ mode: "static", staticImageUrl, expectedRevision: 0, reason: "test" }, 7)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("preserves a valid original image override across the emergency switch", async () => {
    await savePaymentQrConfig({ mode: "generated", merchantTemplate: fixture.template, staticImageUrl: "https://example.com/original.png", expectedRevision: 0, reason: "enable" }, 7);
    await savePaymentQrConfig({ mode: "static", expectedRevision: 1, reason: "recover" }, 7);
    expect((await readPaymentQrConfig()).staticImageUrl).toBe("https://example.com/original.png");
  });
  it("runtime endpoint sees persisted static mode immediately after a generator error", async () => {
    state.config = JSON.stringify({ ...defaultPaymentQrConfig, mode: "generated", merchantTemplate: "invalid" });
    // Missing renderer export simulates failure to load the generation engine.
    expect((await getPaymentQr(7, { kind: "wallet", amount: "1.00" })).error).toBe("GENERATOR_UNAVAILABLE");
    await savePaymentQrConfig({ mode: "static", expectedRevision: 0, reason: "outage" }, 7);
    expect(await getPaymentQr(7, { kind: "wallet", amount: "1.00" })).toMatchObject({
      mode: "static", revision: 1, amount: "1.00", imageUrl: null, error: null,
    });
  });
  it("can read malformed stored JSON as recovery defaults", () => {
    expect(decodePaymentQrConfig("{bad")).toEqual(defaultPaymentQrConfig);
  });
});
