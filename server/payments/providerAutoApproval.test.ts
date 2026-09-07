import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), guard: vi.fn(), approveOrder: vi.fn(), approveWallet: vi.fn(), policy: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb, withAccountMergePaymentMutationGuard: mocks.guard,
 withAccountMergeWalletTopupMutationGuard: mocks.guard, approveWalletTopup: mocks.approveWallet }));
vi.mock("../services/orderService", () => ({ approvePayment: mocks.approveOrder }));
vi.mock("./autoApprovalSettings", () => ({ readAutoPolicy: mocks.policy }));
import { payments, walletTopups, orders } from "../../drizzle/schema";
import { persistAndAutoApprove } from "./providerAutoApproval";
import type { PaymentProviderVerificationResult } from "../services/paymentProviderVerificationService";
let payment: any, order: any, credits: number, queue: Promise<any>;
const good = (): PaymentProviderVerificationResult => ({provider:"slip2go",outcome:"VERIFIED",code:"200200",httpStatus:201,
 amount:"100.00",amountMatches:true,recipientCheckApplied:true,occurredAt:"2026-09-07T01:00:00Z",bankTransactionReference:"synthetic-bank"});
const initial = () => ({...payment});
beforeEach(() => {
 vi.resetAllMocks(); credits=0;queue=Promise.resolve();
 payment={id:1,orderId:2,status:"pending",slipImageUrl:"fixture",slipSubmittedAt:"timestamp",requestedAmount:"100.00"};
 order={id:2,status:"pending",totalAmount:"100.00",createdAt:new Date("2026-09-07T01:01:00Z")};
 mocks.policy.mockResolvedValue({enabled:true,revision:2});
 const tx: any = {
  select: () => ({from: (table:any) => ({where:()=>({limit:()=>({for:async()=>[table===orders?order:payment]})})})}),
  update: (table:any) => ({set:(value:any)=>({where:async()=>{Object.assign(table===orders?order:payment,value);}})}),
 };
 mocks.guard.mockImplementation((_id:any,_tx:any,fn:any)=>{
  const run=queue.then(async()=>{
   const p={...payment},o={...order},c=credits;
   try{return await fn(tx);}catch(e){payment=p;order=o;credits=c;throw e;}
  });
  queue=run.catch(()=>{});return run;
 });
 mocks.approveOrder.mockImplementation(async()=>{payment.status="approved";order.status="approved";credits++;});
 mocks.approveWallet.mockImplementation(async()=>{payment.status="approved";credits++;});
});
describe("provider approval orchestration with transactional doubles",()=>{
 it.each(["order","wallet"] as const)("approves eligible %s and persists separate audit",async type=>{
  const r=await persistAndAutoApprove(type,initial(),good());
  expect(r.approvalOutcome).toBe("APPROVED");expect(credits).toBe(1);
  expect(payment.status).toBe("approved");
  expect(JSON.parse(payment.extractedData).providerVerification).toMatchObject({outcome:"VERIFIED",approvalOutcome:"APPROVED",approvalPolicyRevision:2});
 });
 it.each([180000,181000,-1000])("uses locked order creation time at %i ms",async ms=>{
  order.createdAt=new Date(Date.parse(good().occurredAt!)+ms);
  payment.createdAt=new Date("2026-09-07T01:01:00Z");
  const r=await persistAndAutoApprove("order",initial(),good());
  expect(r.approvalOutcome).toBe(ms===180000?"APPROVED":"SKIPPED");
  expect(credits).toBe(ms===180000?1:0);
  if(ms!==180000) {
   expect(r.outcome).toBe("VERIFIED");
   expect(payment.status).toBe("pending_review");
   expect(r.approvalReason).toBe(ms<0?"ORDER_CREATED_BEFORE_TRANSFER":"ORDER_CREATED_AFTER_TRANSFER_WINDOW");
  }
 });
 it("does not apply order time policy to wallet",async()=>{
  order.createdAt=undefined;
  expect((await persistAndAutoApprove("wallet",initial(),good())).approvalOutcome).toBe("APPROVED");
 });
 it("disabled policy keeps verified result pending",async()=>{
  mocks.policy.mockResolvedValue({enabled:false,revision:3});
  expect((await persistAndAutoApprove("order",initial(),good())).approvalReason).toBe("AUTO_APPROVE_DISABLED");
  expect(credits).toBe(0);expect(payment.status).toBe("pending_review");
 });
 it("reads changed policy on next attempt without restart",async()=>{
  mocks.policy.mockResolvedValueOnce({enabled:false,revision:3}).mockResolvedValueOnce({enabled:true,revision:4});
  await persistAndAutoApprove("order",initial(),good());
  expect((await persistAndAutoApprove("order",initial(),good())).approvalOutcome).toBe("APPROVED");
 });
 it.each([
  {outcome:"ERROR"}, {outcome:"REVIEW_REQUIRED"}, {code:"200501"}, {code:"200401"},
  {amountMatches:false},{recipientCheckApplied:false},{occurredAt:undefined},{bankTransactionReference:undefined},
 ])("rejects ineligible verification %j",async patch=>{
  await persistAndAutoApprove("order",initial(),{...good(),...patch} as PaymentProviderVerificationResult);expect(credits).toBe(0);
 });
 it.each(["approved","rejected","cancelled"])("does not overwrite terminal payment %s",async status=>{
  payment.status=status;const r=await persistAndAutoApprove("order",initial(),good());
  expect(r.approvalReason).toBe("ALREADY_PROCESSED");expect(payment.extractedData).toBeUndefined();expect(credits).toBe(0);
 });
 it("rejects changed submission",async()=>{
  const old=initial();payment.slipSubmittedAt="new";
  expect((await persistAndAutoApprove("order",old,good())).approvalReason).toBe("SUBMISSION_CHANGED");expect(credits).toBe(0);
 });
 it("rechecks current order amount",async()=>{
  order.totalAmount="200.00";
  expect((await persistAndAutoApprove("order",initial(),good())).outcome).toBe("REVIEW_REQUIRED");expect(credits).toBe(0);
 });
 it("rechecks current topup amount",async()=>{
  payment.requestedAmount="200.00";await persistAndAutoApprove("wallet",initial(),good());expect(credits).toBe(0);
 });
 it("serializes repeated calls without double credit",async()=>{
  const old=initial();await Promise.all([persistAndAutoApprove("wallet",old,good()),persistAndAutoApprove("wallet",old,good())]);expect(credits).toBe(1);
 });
 it("rolls back partial approval then records safe error preserving verified verdict",async()=>{
  mocks.approveOrder.mockImplementation(async()=>{credits++;payment.status="approved";throw Error("private SQL secret");});
  const r=await persistAndAutoApprove("order",initial(),good());
  expect(credits).toBe(0);expect(payment.status).toBe("pending");expect(r).toMatchObject({outcome:"VERIFIED",approvalOutcome:"ERROR",approvalReason:"AUTO_APPROVAL_FAILED"});
  expect(payment.extractedData).not.toContain("private");
 });
 it("keeps duplicate claim reviewable",async()=>{
  mocks.approveOrder.mockRejectedValue(Error("PROVIDER_TRANSACTION_ALREADY_USED"));
  expect((await persistAndAutoApprove("order",initial(),good())).approvalReason).toBe("PROVIDER_TRANSACTION_ALREADY_USED");expect(credits).toBe(0);
 });
 it("preserves transport errors with no decoded amount",async()=>{
  const r=await persistAndAutoApprove("wallet",initial(),{provider:"slip2go",outcome:"ERROR",reason:"PROVIDER_TIMEOUT",recipientCheckApplied:false});
  expect(r.outcome).toBe("ERROR");expect(r.reason).toBe("PROVIDER_TIMEOUT");expect(credits).toBe(0);
 });
 it("fails closed when settings unavailable",async()=>{
  mocks.policy.mockRejectedValue(Error("connection password"));
  const r=await persistAndAutoApprove("wallet",initial(),good());expect(r.approvalOutcome).toBe("ERROR");expect(credits).toBe(0);
 });
});
