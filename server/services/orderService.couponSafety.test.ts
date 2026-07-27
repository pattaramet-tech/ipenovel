import { describe, it, expect } from "vitest";
import { toSafeCouponClientMessage } from "./orderService";

/**
 * Pure-logic coverage (no DB) for the client-facing coupon error mapping -
 * see orderService.validateAndApplyCoupon and its callers in
 * server/routers.ts (checkout.validateCoupon, checkout.create,
 * checkout.walletCheckout).
 */
describe("toSafeCouponClientMessage", () => {
  it("maps 'Coupon not found' to the generic message", () => {
    expect(toSafeCouponClientMessage(new Error("Coupon not found"))).toBe("Coupon not found or not available");
  });

  it("maps an ownership-denial message to the SAME generic message as 'not found' (enumeration safety)", () => {
    const notFoundMsg = toSafeCouponClientMessage(new Error("Coupon not found"));
    const ownedByOtherMsg = toSafeCouponClientMessage(new Error("This coupon belongs to another user"));
    expect(ownedByOtherMsg).toBe(notFoundMsg);
  });

  it("is case-insensitive and matches the message regardless of surrounding punctuation", () => {
    expect(toSafeCouponClientMessage(new Error("THIS COUPON BELONGS TO ANOTHER USER."))).toBe(
      "Coupon not found or not available"
    );
  });

  it("does NOT rewrite reward-status messages - those are only reachable after ownership is already confirmed", () => {
    expect(toSafeCouponClientMessage(new Error("This reward coupon has already been used"))).toBe(
      "This reward coupon has already been used"
    );
    expect(toSafeCouponClientMessage(new Error("This reward coupon has expired"))).toBe(
      "This reward coupon has expired"
    );
    expect(toSafeCouponClientMessage(new Error("This reward coupon has been cancelled"))).toBe(
      "This reward coupon has been cancelled"
    );
  });

  it("does not rewrite unrelated validation messages (expired, inactive, usage limit, minimum purchase)", () => {
    expect(toSafeCouponClientMessage(new Error("Coupon has expired"))).toBe("Coupon has expired");
    expect(toSafeCouponClientMessage(new Error("Coupon is inactive"))).toBe("Coupon is inactive");
    expect(toSafeCouponClientMessage(new Error("Coupon usage limit reached"))).toBe("Coupon usage limit reached");
    expect(toSafeCouponClientMessage(new Error("Minimum purchase amount of ฿500.00 required"))).toBe(
      "Minimum purchase amount of ฿500.00 required"
    );
  });

  it("does not rewrite unrelated checkout errors (empty cart, insufficient balance)", () => {
    expect(toSafeCouponClientMessage(new Error("Your cart is empty. Please add items before checkout."))).toBe(
      "Your cart is empty. Please add items before checkout."
    );
    expect(toSafeCouponClientMessage(new Error("Insufficient wallet balance"))).toBe("Insufficient wallet balance");
  });

  it("falls back to a generic message for a non-Error, non-string value", () => {
    expect(toSafeCouponClientMessage(undefined)).toBe("Invalid coupon");
    expect(toSafeCouponClientMessage(null)).toBe("Invalid coupon");
  });
});
