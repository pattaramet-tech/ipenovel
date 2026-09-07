import { beforeEach, describe, expect, it, vi } from "vitest";
import { validReceiver, defaultReceiverConfig } from "../../shared/paymentReceiver";
const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => mocks);
import { readReceiverConfig, saveReceiverConfig, getReceiverCondition, RECEIVER_KEY, isReceiverSettingKey } from "./receiverSettings";
import { paymentReceiverSettingsRouter } from "./receiverRouter";
let rows: { key: string; value: string }[];
let failAudit: boolean;
function database() {
 const tx: any = {
  select: () => ({ from: () => ({ where: () => {
   const result: any = Promise.resolve([...rows]);
   result.limit = () => ({ for: async () => rows.filter(r => r.key === RECEIVER_KEY) });
   return result;
  } }) }),
  insert: () => ({ values: (row: any) => {
   if (row.key === RECEIVER_KEY) return { onDuplicateKeyUpdate: async () => { if (!rows.some(r => r.key === row.key)) rows.push(row); } };
   if (failAudit) throw Error("audit failure");
   rows.push(row); return Promise.resolve();
  } }),
  update: () => ({ set: (row: any) => ({ where: async () => {
   rows = rows.map(r => r.key === RECEIVER_KEY ? { ...r, ...row } : r);
  } }) }),
  transaction: async (fn: any) => {
   const prior = structuredClone(rows); try { return await fn(tx); } catch (e) { rows = prior; throw e; }
  },
 }; return tx;
}
const ctx = (role: string | null) => ({ user: role ? { id: 7, role } : null, req: { headers: {} }, res: {} }) as any;
const input = { accountType: "03000", accountNumber: "KB000000000001", expectedRevision: 0, reason: "Configure test merchant" };
beforeEach(() => { vi.clearAllMocks(); rows = []; failAudit = false; mocks.getDb.mockResolvedValue(database()); });
describe("provider receiver settings", () => {
 it("reads missing configuration without inventing an account", async () => {
  expect(await readReceiverConfig()).toEqual(defaultReceiverConfig);
  expect(await getReceiverCondition()).toBeUndefined();
 });
 it("saves and reads through admin router and immediately uses explicit merchant condition", async () => {
  const caller = paymentReceiverSettingsRouter.createCaller(ctx("admin"));
  await caller.update(input);
  expect(await caller.get()).toMatchObject({ accountType: "03000", accountNumber: input.accountNumber, revision: 1, updatedBy: 7 });
  expect(await getReceiverCondition()).toEqual({ accountType: "03000", accountNumber: input.accountNumber });
  const audits = rows.filter(r => r.key.includes("Audit."));
  expect(audits).toHaveLength(1);
  expect(JSON.parse(audits[0].value)).toMatchObject({ actorId: 7, reason: input.reason, revision: 1 });
  expect(audits[0].value).not.toContain(input.accountNumber);
 });
 it("supports existing two-key settings on first read and transitions to atomic settings", async () => {
  rows = [{ key: "paymentVerification.receiverAccountType", value: "01004" }, { key: "paymentVerification.receiverAccountNumber", value: "1234567890" }];
  expect(await getReceiverCondition()).toEqual({ accountType: "01004", accountNumber: "1234567890" });
  await saveReceiverConfig(input, 7);
  expect((await getReceiverCondition())?.accountNumber).toBe(input.accountNumber);
 });
 it("rejects stale save", async () => {
  await saveReceiverConfig(input, 7);
  await expect(saveReceiverConfig({ ...input, accountNumber: "KB000000000002" }, 7)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await getReceiverCondition())?.accountNumber).toBe(input.accountNumber);
 });
 it("rolls back when audit fails", async () => {
  failAudit = true;
  await expect(saveReceiverConfig(input, 7)).rejects.toThrow("audit failure");
  expect(rows).toEqual([]);
 });
 it.each([null, "user"])("rejects unauthorized %s read/write", async role => {
  const caller = paymentReceiverSettingsRouter.createCaller(ctx(role));
  await expect(caller.get()).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
  await expect(caller.update(input)).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
  expect(rows).toEqual([]);
 });
 it.each([["01004", "KB000000000001"], ["03000", "KB 123456"], ["03000", "KB/123456"], ["03000", ""], ["abc", "123456"]])("rejects invalid receiver %s %s", async (accountType, accountNumber) => {
  await expect(saveReceiverConfig({ ...input, accountType, accountNumber }, 7)).rejects.toThrow();
  expect(rows).toEqual([]);
 });
 it("keeps numeric bank validation and does not silently disable invalid stored receiver", async () => {
  expect(validReceiver("01004", "1234567890")).toBe(true);
  rows = [{ key: "paymentVerification.receiverAccountType", value: "01004" }];
  await expect(getReceiverCondition()).rejects.toThrow("INVALID_PROVIDER_RECEIVER_SETTINGS");
 });
 it("fails closed on corrupted JSON", async () => {
  rows = [{ key: RECEIVER_KEY, value: "{bad" }];
  await expect(readReceiverConfig()).rejects.toThrow("INVALID_PROVIDER_RECEIVER_SETTINGS");
 });
 it("fails on missing database", async () => {
  mocks.getDb.mockResolvedValue(undefined);
  await expect(readReceiverConfig()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  await expect(saveReceiverConfig(input, 7)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
 });
 it("protects current/legacy/audit keys without blocking unrelated policy", () => {
  for (const key of [RECEIVER_KEY, "paymentVerification.receiverAccountType", "paymentVerification.receiverAccountNumber", "paymentVerification.receiverAudit.id"])
   expect(isReceiverSettingKey(key)).toBe(true);
  expect(isReceiverSettingKey(" PaymentVerification.ReceiverConfig ")).toBe(true);
  expect(isReceiverSettingKey("PAYMENTVERIFICATION.RECEIVERAUDIT.ID")).toBe(true);
  expect(isReceiverSettingKey("provider_auto_approve")).toBe(false);
 });
});
