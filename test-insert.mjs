import { drizzle } from "drizzle-orm/mysql2";
import { orders } from "./drizzle/schema.js";

const db = drizzle(process.env.DATABASE_URL);

async function test() {
  try {
    const result = await db.insert(orders).values({
      orderNumber: "TEST001",
      userId: 1,
      subtotal: "100.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "100.00",
      status: "pending",
      paymentStatus: "unpaid",
    });
    
    console.log("Insert result:", JSON.stringify(result, null, 2));
    console.log("Result keys:", Object.keys(result));
    console.log("Result.insertId:", result.insertId);
  } catch (e) {
    console.error("Error:", e.message);
  }
  process.exit(0);
}

test();
