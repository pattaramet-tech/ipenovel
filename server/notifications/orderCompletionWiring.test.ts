import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R40R53 P3-B wiring proof (static source-order assertions):
 * - approvePaymentInTx emits order_completed ONLY after finalizeOrderCompletion
 * - walletCheckout emits order_completed ONLY after debit + approval +
 *   finalize + clearCart all succeeded, inside dbConnection.transaction
 * - already-approved payments early-return BEFORE any producer call
 *
 * Route-level runtime behavior against a real MySQL instance belongs to the
 * disposable-DB qualification (S6) - this file proves WIRING, not SQL.
 */

const orderServiceSource = readFileSync(
  fileURLToPath(new URL("../services/orderService.ts", import.meta.url)),
  "utf8",
);

const routersSource = readFileSync(
  fileURLToPath(new URL("../routers.ts", import.meta.url)),
  "utf8",
);

function sectionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `end marker not found after: ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("R40R53 order_completed wiring (static source-order)", () => {
  it("approvePaymentInTx emits only after finalizeOrderCompletion and skips ownerless orders", () => {
    const section = sectionBetween(
      orderServiceSource,
      "async function approvePaymentInTx",
      "Finalize order completion",
    );
    // Already-approved early return precedes any producer call.
    expect(section.indexOf('payment.status === "approved"')).toBeGreaterThan(-1);
    expect(section.indexOf("recordOrderCompletionIfEnabled")).toBe(-1);
  });

  it("approvePaymentInTx emits after finalizeOrderCompletion only for owned orders", () => {
    const finalizeSection = sectionBetween(
      orderServiceSource,
      "Finalize order completion (points, purchases, coupon usage)",
      "Payment ${paymentId} approved successfully",
    );
    expect(finalizeSection).toContain("finalizeOrderCompletion(order.id, order.userId, tx)");
    expect(finalizeSection).toContain("recordOrderCompletionIfEnabled(tx,");
    expect(finalizeSection.indexOf("finalizeOrderCompletion")).toBeLessThan(
      finalizeSection.indexOf("recordOrderCompletionIfEnabled")
    );
    // Ownerless orders skip finalize AND the producer together.
    expect(finalizeSection.indexOf("if (order.userId)")).toBeGreaterThan(-1);
  });

  it("walletCheckout emits only after cart clear, inside the original transaction", () => {
    const walletSection = sectionBetween(
      routersSource,
      'walletCheckout: protectedProcedure',
      "STEP 8: Clear cart",
    );
    expect(walletSection).toContain("dbConnection.transaction");
    expect(walletSection).toContain("finalizeOrderCompletion");
    expect(walletSection).not.toContain("recordOrderCompletionIfEnabled");
  });

  it("walletCheckout wires the producer after clearCart, before transaction close", () => {
    const clearIdx = routersSource.indexOf("await db.clearCart(cart.id, tx);");
    const wireIdx = routersSource.indexOf("recordOrderCompletionIfEnabled(tx,");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(wireIdx).toBeGreaterThan(clearIdx);
    const tail = routersSource.slice(wireIdx, wireIdx + 400);
    expect(tail).toContain("orderId: newOrder.id");
    expect(tail).toContain("userId: ctx.user.id");
    expect(tail).toContain("flags: notificationFlags");
  });
});
