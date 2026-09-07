import { describe, expect, it } from "vitest";
import * as db from "./db";
import { deleteFixtures } from "./test-helpers/fixtures";
import { getOrderNumberBusinessDate } from "./helpers/orderNumber";

describe.sequential("order number daily sequence (real disposable test database)", () => {
  it("allocates unique consecutive YYYYMMDDXXX values across concurrent orders", async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error(
        "order-number-sequence.integration.test.ts requires TEST_DATABASE_URL and a prepared disposable test database",
      );
    }

    // userId is intentionally omitted: this isolates the global sequence
    // contract from unrelated account-merge guard fixtures while still
    // exercising the real transaction/upsert/order-insert production path.
    const created = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.createOrder({
          subtotal: "1.00",
          discountAmount: "0.00",
          pointsDiscountAmount: "0.00",
          totalAmount: "1.00",
        }),
      ),
    );

    const orderIds = created.map((row) => row?.id).filter((id): id is number => Number.isInteger(id));
    expect(orderIds).toHaveLength(5);

    const orders = await Promise.all(orderIds.map((id) => db.getOrderById(id)));
    const numbers = orders.map((order) => order?.orderNumber ?? "");
    const datePrefix = getOrderNumberBusinessDate().replace(/-/g, "");

    expect(numbers.every((value) => /^\d{11}$/.test(value))).toBe(true);
    expect(numbers.every((value) => value.startsWith(datePrefix))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);

    const sequences = numbers
      .map((value) => Number(value.slice(8)))
      .sort((a, b) => a - b);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBe(sequences[index - 1] + 1);
    }

    await deleteFixtures({ orderIds });
  }, 30_000);
});
