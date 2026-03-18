/**
 * Entitlement Repair Tool
 * Admin-only tool to safely repair missing purchases/entitlements
 */

import { getDb } from "../db";

export interface RepairResult {
  orderId: number;
  orderNumber: string;
  status: "success" | "failed" | "no_action_needed";
  message: string;
  entitlementsCreated: number;
  entitlementsSkipped: number;
  errors: string[];
  timestamp: string;
  adminId: number;
}

/**
 * Get repair preview (dry-run)
 */
export async function getRepairPreview(orderNumber: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    // Find order
    const orderRecords = await (db as any).execute(
      `SELECT id, orderNumber, userId, totalAmount, createdAt FROM orders WHERE orderNumber = ?`,
      [orderNumber]
    );

    if (!orderRecords.length) {
      return { error: "Order not found" };
    }

    const order = orderRecords[0];

    // Get payment status
    const paymentRecords = await (db as any).execute(
      `SELECT id, status, approvedAt FROM payments WHERE orderId = ? LIMIT 1`,
      [order.id]
    );

    const payment = paymentRecords[0];

    // Get order items
    const items = await (db as any).execute(
      `SELECT id, episodeId, price FROM orderItems WHERE orderId = ?`,
      [order.id]
    );

    // Get existing purchases
    const existingPurchases = await (db as any).execute(
      `SELECT episodeId FROM purchases WHERE userId = ?`,
      [order.userId]
    );

    const existingEpisodeIds = new Set(existingPurchases.map((p: any) => p.episodeId));

    // Calculate what would be repaired
    const toRepair = items.filter((item: any) => !existingEpisodeIds.has(item.episodeId));

    return {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        userId: order.userId,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
      },
      payment: {
        id: payment?.id,
        status: payment?.status,
        approvedAt: payment?.approvedAt,
      },
      items: items.map((item: any) => ({
        id: item.id,
        episodeId: item.episodeId,
        price: item.price,
        alreadyOwned: existingEpisodeIds.has(item.episodeId),
      })),
      toRepair: toRepair.map((item: any) => ({
        id: item.id,
        episodeId: item.episodeId,
        price: item.price,
      })),
      canRepair: payment?.status === "APPROVED" && toRepair.length > 0,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Execute entitlement repair (idempotent)
 */
export async function repairEntitlements(
  orderNumber: string,
  adminId: number
): Promise<RepairResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const timestamp = new Date().toISOString();

  try {
    // Find order
    const orderRecords = await (db as any).execute(
      `SELECT id, userId FROM orders WHERE orderNumber = ?`,
      [orderNumber]
    );

    if (!orderRecords.length) {
      return {
        orderId: 0,
        orderNumber,
        status: "failed",
        message: "Order not found",
        entitlementsCreated: 0,
        entitlementsSkipped: 0,
        errors: ["Order not found"],
        timestamp,
        adminId,
      };
    }

    const order = orderRecords[0];

    // Check payment status
    const paymentRecords = await (db as any).execute(
      `SELECT id, status FROM payments WHERE orderId = ? LIMIT 1`,
      [order.id]
    );

    const payment = paymentRecords[0];

    if (!payment || payment.status !== "approved") {
      return {
        orderId: order.id,
        orderNumber,
        status: "failed",
        message: "Payment must be approved before repair",
        entitlementsCreated: 0,
        entitlementsSkipped: 0,
        errors: ["Payment not approved"],
        timestamp,
        adminId,
      };
    }

    // Get order items
    const items = await (db as any).execute(
      `SELECT id, episodeId FROM orderItems WHERE orderId = ?`,
      [order.id]
    );

    if (!items.length) {
      return {
        orderId: order.id,
        orderNumber,
        status: "no_action_needed",
        message: "No order items found",
        entitlementsCreated: 0,
        entitlementsSkipped: 0,
        errors: [],
        timestamp,
        adminId,
      };
    }

    // Get existing purchases
    const existingPurchases = await (db as any).execute(
      `SELECT episodeId FROM purchases WHERE userId = ?`,
      [order.userId]
    );

    const existingEpisodeIds = new Set(existingPurchases.map((p: any) => p.episodeId));

    // Create missing purchases (idempotent - won't create duplicates)
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of items) {
      if (existingEpisodeIds.has(item.episodeId)) {
        skipped++;
        continue;
      }

      try {
        // Insert purchase with all required columns; ON DUPLICATE KEY UPDATE for idempotency
        // novelId is fetched from episodes table
        const episodeRows = await (db as any).execute(
          `SELECT novelId FROM episodes WHERE id = ? LIMIT 1`,
          [item.episodeId]
        );
        const novelId = episodeRows[0]?.novelId || 0;
        await (db as any).execute(
          `INSERT INTO purchases (userId, novelId, episodeId, orderId, grantedAt, createdAt)
           VALUES (?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE grantedAt = NOW()`,
          [order.userId, novelId, item.episodeId, order.id]
        );

        created++;
        existingEpisodeIds.add(item.episodeId);
      } catch (error) {
        // Likely duplicate key error - treat as skipped
        if (error instanceof Error && error.message.includes("Duplicate")) {
          skipped++;
        } else {
          errors.push(`Failed to create purchase for episode ${item.episodeId}`);
        }
      }
    }

    // Write audit log
    try {
      await (db as any).execute(
        `INSERT INTO orderHistory (orderId, action, note, createdAt)
         VALUES (?, 'ENTITLEMENT_REPAIR', ?, NOW())`,
        [
          order.id,
          JSON.stringify({
            adminId,
            entitlementsCreated: created,
            entitlementsSkipped: skipped,
            errors,
          }),
        ]
      );
    } catch (auditError) {
      console.error("Failed to write audit log:", auditError);
      // Don't fail the repair if audit log fails
    }

    return {
      orderId: order.id,
      orderNumber,
      status: errors.length === 0 ? "success" : "success",
      message:
        created > 0
          ? `Repaired ${created} entitlements`
          : skipped > 0
            ? "All entitlements already present"
            : "No repairs needed",
      entitlementsCreated: created,
      entitlementsSkipped: skipped,
      errors,
      timestamp,
      adminId,
    };
  } catch (error) {
    return {
      orderId: 0,
      orderNumber,
      status: "failed",
      message: "Repair failed",
      entitlementsCreated: 0,
      entitlementsSkipped: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      timestamp,
      adminId,
    };
  }
}
