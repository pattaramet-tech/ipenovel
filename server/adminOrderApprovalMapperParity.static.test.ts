import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapOrderPaymentApprovalError,
  ORDER_PAYMENT_BUSY_MESSAGE,
} from "./helpers/adminPaymentApprovalError";

const routersCode = fs.readFileSync(
  path.resolve(process.cwd(), "server/routers.ts"),
  "utf8"
);

function windowAround(needle: string, before = 500, after = 900): string {
  const index = routersCode.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return routersCode.slice(Math.max(0, index - before), index + after);
}

function indexOfMatch(pattern: RegExp): number {
  const match = pattern.exec(routersCode);
  expect(match).not.toBeNull();
  return match!.index;
}

describe("IPE-020-C02 manual order approval mapper parity", () => {
  it("both active manual approval endpoints use the shared post-service mapper", () => {
    const paymentsApprove = windowAround(
      "await orderService.approvePayment(input.paymentId"
    );
    const ordersCall = indexOfMatch(
      /await orderService\.approvePayment\(\s*payment\.id/
    );
    const ordersApprove = routersCode.slice(ordersCall - 500, ordersCall + 900);

    expect(paymentsApprove).toContain("throw mapOrderPaymentApprovalError(error)");
    expect(ordersApprove).toContain("throw mapOrderPaymentApprovalError(error)");
  });

  it("admin.orders.approve keeps its deliberate pre-service checks", () => {
    const serviceCall = indexOfMatch(
      /await orderService\.approvePayment\(\s*payment\.id/
    );
    const routeStart = routersCode.lastIndexOf("approve: adminProcedure", serviceCall);
    const routeBeforeService = routersCode.slice(routeStart, serviceCall);

    expect(routeBeforeService).toContain('code: "NOT_FOUND"');
    expect(routeBeforeService).toContain('message: "Order is not pending"');
    expect(routeBeforeService).toContain(
      'message: "No payment record found for this order"'
    );
  });

  it("the shared mapper gives either endpoint the fixed retryable 1205 contract", () => {
    const timeout = Object.assign(new Error("driver detail"), {
      errno: 1205,
      code: "ER_LOCK_WAIT_TIMEOUT",
      sqlState: "HY000",
    });

    for (const endpoint of ["admin.payments.approve", "admin.orders.approve"]) {
      const mapped = mapOrderPaymentApprovalError(timeout);
      expect(mapped, endpoint).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: ORDER_PAYMENT_BUSY_MESSAGE,
        cause: timeout,
      });
    }
  });
});
