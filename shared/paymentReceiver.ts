import { z } from "zod";

export function validReceiver(accountType: string, accountNumber: string): boolean {
  if (!/^[0-9]{5}$/.test(accountType)) return false;
  return accountType === "03000"
    ? /^[A-Za-z0-9]{6,32}$/.test(accountNumber)
    : /^[0-9]{6,20}$/.test(accountNumber);
}
export const receiverUpdateSchema = z.object({
  accountType: z.string().trim().max(5),
  accountNumber: z.string().trim().max(32),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(300),
}).strict().refine(v => validReceiver(v.accountType, v.accountNumber), {
  message: "ประเภทบัญชีหรือรหัสผู้รับไม่ถูกต้อง (KSHOP ใช้รหัสร้าน ตัวอักษรและตัวเลข)",
});
export type ReceiverConfig = {
  accountType: string; accountNumber: string; revision: number;
  updatedAt: string | null; updatedBy: number | null;
};
export const defaultReceiverConfig: ReceiverConfig = {
  accountType: "", accountNumber: "", revision: 0, updatedAt: null, updatedBy: null,
};
