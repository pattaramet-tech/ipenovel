import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getTestDb } from "../test-helpers/testDb";
import { users, novels, episodes, orderItems, purchases, pointsTransactions, orders, payments, walletTopups, walletAccounts, walletTransactions, settings, paymentProviderClaims } from "../../drizzle/schema";
import { persistAndAutoApprove } from "./providerAutoApproval";
import { AUTO_APPROVE_KEY, saveAutoPolicy } from "./autoApprovalSettings";
import { createOrder, approveWalletTopup, updateOrder, updatePayment } from "../db";
import { approvePayment, rejectPayment } from "../services/orderService";
import type { PaymentProviderVerificationResult } from "../services/paymentProviderVerificationService";

import { findDuplicatePayments, duplicateConfirmationKey } from "./duplicateException";
const db = getTestDb();
const result = (ref = randomUUID()): PaymentProviderVerificationResult => ({
 provider: "slip2go", outcome: "VERIFIED", reason: "CHECKS_PASSED", httpStatus: 201,
 code: "200200", amount: "100.00", amountMatches: true, recipientCheckApplied: true,
 occurredAt: new Date(Date.now()-60000).toISOString(), checkedAt: new Date().toISOString(),
 bankTransactionReference: ref, providerReference: randomUUID(),
});
async function fixture(type: "order" | "wallet", snapshot?: PaymentProviderVerificationResult) {
 const [{id: userId}] = await db.insert(users).values({openId: randomUUID()}).$returningId();
 const common = {slipImageUrl: "https://example.com/" + randomUUID(), slipSubmittedAt: new Date(),
  extractedData: snapshot ? JSON.stringify({providerVerification:snapshot}) : null};
 if (type === "wallet") {
  const [{id}] = await db.insert(walletTopups).values({...common,userId,requestedAmount:"100.00",creditedAmount:"110.00",bonusAmount:"10.00"}).$returningId();
  return (await db.select().from(walletTopups).where(eq(walletTopups.id,id)))[0];
 }
 const created = await createOrder({userId,subtotal:"100.00",discountAmount:"0.00",pointsDiscountAmount:"0.00",totalAmount:"100.00"});
 const orderId = created!.id;
 expect((await db.select().from(orders).where(eq(orders.id,orderId)))[0].orderNumber).toMatch(/^\d{11}$/);
 const [{id}] = await db.insert(payments).values({...common,orderId,ocrConfidence:0,ocrDecision:"needs_review"}).$returningId();
 return (await db.select().from(payments).where(eq(payments.id,id)))[0];
}
beforeEach(async () => {
 await db.insert(settings).values({key:AUTO_APPROVE_KEY,value:JSON.stringify({enabled:true,revision:1})})
  .onDuplicateKeyUpdate({set:{value:JSON.stringify({enabled:true,revision:1})}});
});
describe("provider auto approval on real MariaDB", () => {
 it("requires explicit duplicate confirmation, preserves owner and approves only once", async()=>{
  const r=result(), first:any=await fixture("wallet",r), second:any=await fixture("order",r);
  await approveWalletTopup(first.id,1);
  await expect(approvePayment(second.id,"1")).rejects.toThrow("PROVIDER_TRANSACTION_ALREADY_USED");
  const duplicates=await findDuplicatePayments(db,r.bankTransactionReference!,second.id);
  expect(duplicates.some(d=>d.subjectType==="wallet" && Number(d.subjectId)===first.id)).toBe(true);
  const exception={confirmed:true,reason:"Verified separate settlement by administrator",confirmationKey:duplicateConfirmationKey(r.bankTransactionReference!,duplicates,second.id)};
  await expect(approvePayment(second.id,"1",undefined,undefined,{...exception,confirmed:false})).rejects.toThrow("REASON_REQUIRED");
  await expect(approvePayment(second.id,"1",undefined,undefined,{...exception,confirmationKey:"x".repeat(64)})).rejects.toThrow("RECONFIRM");
  await Promise.all([approvePayment(second.id,"1",undefined,undefined,exception),approvePayment(second.id,"1",undefined,undefined,exception)]);
  const [saved]=await db.select().from(payments).where(eq(payments.id,second.id));
  expect(saved.status).toBe("approved");
  expect(JSON.parse(saved.extractedData!).duplicateApprovalException.reason).toBe(exception.reason);
  expect(await db.select().from(pointsTransactions).where(eq(pointsTransactions.referenceId,second.orderId))).toHaveLength(1);
  const third:any=await fixture("order",r);
  await expect(approvePayment(third.id,"1")).rejects.toThrow("PROVIDER_TRANSACTION_ALREADY_USED");
 });

 it("credits bonus and ledger once across repeated and concurrent verification", async () => {
  const row:any=await fixture("wallet"), r=result();
  const values=await Promise.all([persistAndAutoApprove("wallet",row,r),persistAndAutoApprove("wallet",row,r)]);
  expect(values.filter(v=>v.approvalOutcome==="APPROVED")).toHaveLength(1);
  expect((await db.select().from(walletAccounts).where(eq(walletAccounts.userId,row.userId)))[0].balance).toBe("110.00");
  expect(await db.select().from(walletTransactions).where(eq(walletTransactions.referenceId,row.id))).toHaveLength(1);
  expect((await persistAndAutoApprove("wallet",row,r)).approvalOutcome).toBe("SKIPPED");
 });
 it("serializes manual and automatic wallet approval", async () => {
  const r=result(),row:any=await fixture("wallet",r);
  await Promise.allSettled([persistAndAutoApprove("wallet",row,r),approveWalletTopup(row.id,1)]);
  expect((await db.select().from(walletAccounts).where(eq(walletAccounts.userId,row.userId)))[0].balance).toBe("110.00");
  expect(await db.select().from(walletTransactions).where(eq(walletTransactions.referenceId,row.id))).toHaveLength(1);
 });
 it("prevents the same bank transaction paying an order and a wallet", async () => {
  const a:any=await fixture("order"),b:any=await fixture("wallet"),r=result();
  const results=await Promise.all([persistAndAutoApprove("order",a,r),persistAndAutoApprove("wallet",b,r)]);
  expect(results.filter(v=>v.approvalOutcome==="APPROVED")).toHaveLength(1);
  expect(results.find(v=>v.approvalOutcome==="ERROR")?.approvalReason).toBe("PROVIDER_TRANSACTION_ALREADY_USED");
 });
 it("grants purchased episodes and loyalty points exactly once", async () => {
  const row:any=await fixture("order"),r=result();
  const [{id:novelId}]=await db.insert(novels).values({title:"Synthetic IPE040",slug:randomUUID()}).$returningId();
  const [{id:episodeId}]=await db.insert(episodes).values({novelId,title:"Synthetic episode",episodeNumber:"1",price:"100.00"}).$returningId();
  await db.insert(orderItems).values({orderId:row.orderId,novelId,episodeId,unitPrice:"100.00",finalPrice:"100.00"});
  await Promise.all([persistAndAutoApprove("order",row,r),persistAndAutoApprove("order",row,r)]);
  expect(await db.select().from(purchases).where(eq(purchases.orderId,row.orderId))).toHaveLength(1);
  const points=await db.select().from(pointsTransactions).where(eq(pointsTransactions.referenceId,row.orderId));
  expect(points).toHaveLength(1);expect(Number(points[0].amount)).toBe(1);
 });
 it("keeps manual order approval idempotent against automatic approval", async () => {
  const r=result(),row:any=await fixture("order",r);
  await Promise.all([persistAndAutoApprove("order",row,r),approvePayment(row.id,"1")]);
  expect((await db.select().from(orders).where(eq(orders.id,row.orderId)))[0].status).toBe("approved");
  expect((await db.select().from(payments).where(eq(payments.id,row.id)))[0].status).toBe("approved");
 });
 it("does not regress an approved order after late upload or rejection", async () => {
  const row:any=await fixture("order");
  expect((await persistAndAutoApprove("order",row,result())).approvalOutcome).toBe("APPROVED");
  await updateOrder(row.orderId,{paymentStatus:"submitted"});
  await expect(updatePayment(row.id,{slipImageUrl:"https://example.com/replacement"})).rejects.toThrow("already approved");
  await expect(rejectPayment(row.id,"1","late rejection")).rejects.toThrow();
  expect((await db.select().from(orders).where(eq(orders.id,row.orderId)))[0].paymentStatus).toBe("approved");
  expect((await db.select().from(payments).where(eq(payments.id,row.id)))[0].status).toBe("approved");
 });
 it("rejects reuse of an approved snapshot predating the claim registry", async () => {
  const r=result(),old:any=await fixture("order",r),row:any=await fixture("wallet");
  await db.update(payments).set({status:"approved"}).where(eq(payments.id,old.id));
  expect((await persistAndAutoApprove("wallet",row,r)).approvalReason).toBe("PROVIDER_TRANSACTION_ALREADY_USED");
  expect(await db.select().from(walletAccounts).where(eq(walletAccounts.userId,row.userId))).toHaveLength(0);
 });
 it.each([180,181])("enforces real DB order time at %i seconds",async seconds=>{
  const row:any=await fixture("order"),r=result();
  r.occurredAt="2026-09-07T15:00:00.000Z";
  await db.update(orders).set({createdAt:new Date(Date.parse(r.occurredAt)+seconds*1000)}).where(eq(orders.id,row.orderId));
  const verified=await persistAndAutoApprove("order",row,r);
  expect(verified.approvalOutcome).toBe(seconds===180?"APPROVED":"SKIPPED");
  const [saved]=await db.select().from(payments).where(eq(payments.id,row.id));
  expect(saved.status).toBe(seconds===180?"approved":"pending_review");
  if(seconds===181) expect(JSON.parse(saved.extractedData!).providerVerification.approvalReason).toBe("ORDER_CREATED_AFTER_TRANSFER_WINDOW");
 });
 it("reads disabled runtime policy and performs no credit", async () => {
  await saveAutoPolicy({enabled:false,expectedRevision:1,reason:"integration disable"},1);
  const row:any=await fixture("wallet");
  expect((await persistAndAutoApprove("wallet",row,result())).approvalReason).toBe("AUTO_APPROVE_DISABLED");
  expect(await db.select().from(walletAccounts).where(eq(walletAccounts.userId,row.userId))).toHaveLength(0);
 });
 it("rolls back approval, claims and wallet credit if final ledger insert fails", async () => {
  const row:any=await fixture("wallet"),r=result();
  // Fault is scoped to this synthetic subject in the isolated test database.
  await db.execute(`CREATE TRIGGER ipe040_ledger_failure BEFORE INSERT ON walletTransactions FOR EACH ROW
   BEGIN IF NEW.referenceId = ${row.id} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IPE040 injected ledger failure'; END IF; END`);
  try {
   expect((await persistAndAutoApprove("wallet",row,r)).approvalReason).toBe("AUTO_APPROVAL_FAILED");
   expect((await db.select().from(walletTopups).where(eq(walletTopups.id,row.id)))[0].status).toBe("pending");
   expect(await db.select().from(walletAccounts).where(eq(walletAccounts.userId,row.userId))).toHaveLength(0);
   expect(await db.select().from(paymentProviderClaims).where(and(eq(paymentProviderClaims.subjectId,row.id),eq(paymentProviderClaims.subjectType,"wallet")))).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER ipe040_ledger_failure"); }
  expect((await persistAndAutoApprove("wallet",row,r)).approvalOutcome).toBe("APPROVED");
 });
});
