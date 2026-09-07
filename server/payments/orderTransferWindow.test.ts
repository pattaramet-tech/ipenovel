import { describe, expect, it } from "vitest";
import { orderTransferWindowReason } from "./orderTransferWindow";
describe("three minute transfer to order window", () => {
 const transfer = "2026-09-07T22:00:00+07:00";
 it.each([0,1,179000,180000])("accepts elapsed %i ms", ms => {
  expect(orderTransferWindowReason(new Date(Date.parse(transfer)+ms),transfer)).toBeNull();
 });
 it.each([180001,181000,86400000])("rejects elapsed %i ms", ms => {
  expect(orderTransferWindowReason(new Date(Date.parse(transfer)+ms),transfer)).toBe("ORDER_CREATED_AFTER_TRANSFER_WINDOW");
 });
 it("rejects creation before transfer",()=>expect(orderTransferWindowReason("2026-09-07T21:59:59+07:00",transfer)).toBe("ORDER_CREATED_BEFORE_TRANSFER"));
 it("compares UTC and Bangkok as the same instant",()=>expect(orderTransferWindowReason("2026-09-07T15:03:00Z",transfer)).toBeNull());
 it("handles midnight",()=>expect(orderTransferWindowReason("2026-09-08T00:02:00+07:00","2026-09-07T23:59:00+07:00")).toBeNull());
 it.each([null,undefined,"",0,"invalid","2026-09-07T22:00:00",new Date(NaN)])("fails closed for invalid timestamp %s",value=>{
  expect(orderTransferWindowReason(value,transfer)).toBe("ORDER_TRANSFER_TIME_INVALID");
  expect(orderTransferWindowReason(transfer,value)).toBe("ORDER_TRANSFER_TIME_INVALID");
 });
});
