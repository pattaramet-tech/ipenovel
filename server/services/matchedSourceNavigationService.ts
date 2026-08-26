/**
 * Resolves a conflict's matched historical source to something an admin can
 * actually open.
 *
 * ── The bug this exists for ───────────────────────────────────────────────
 * The panel built its own links from the matched source id:
 *
 *   /admin/orders?paymentId=123
 *   /admin/topup-logs?topupId=456
 *
 * Neither navigates to the evidence. The registered routes are
 * `/admin/orders/:orderId` and `/admin/wallet-topups/:topupId`, and the list
 * pages read only a `userId` query parameter - so both ids were ignored and
 * the admin landed on an unfiltered list while trying to compare two
 * transactions.
 *
 * The order case cannot be fixed on the client at all: a matched
 * `order_payment` id is a PAYMENT id, and the detail route is keyed by ORDER
 * id. Guessing one from the other would produce a confident link to the wrong
 * order. The lookup therefore happens here, server-side, and the client is
 * handed either a real target or none.
 */

import { payments } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export type MatchedSourceType = "order_payment" | "wallet_topup";

export interface MatchedSourceNavigation {
  /**
   * The order this payment belongs to. Undefined when the historical row
   * cannot be resolved - in which case the UI shows the source WITHOUT a
   * link, because no link is better than a wrong one.
   */
  orderId?: number;
}

export async function resolveMatchedSourceNavigation(
  sourceType: MatchedSourceType,
  sourceId: number,
  executor: any
): Promise<MatchedSourceNavigation> {
  // A wallet top-up's detail route is keyed by the top-up id itself, so
  // there is nothing to resolve.
  if (sourceType !== "order_payment") return {};

  try {
    const rows = await executor
      .select({ orderId: payments.orderId })
      .from(payments)
      .where(eq(payments.id, sourceId))
      .limit(1);

    const orderId = rows?.[0]?.orderId;
    return typeof orderId === "number" ? { orderId } : {};
  } catch {
    // Navigation is a convenience. A lookup failure must never break the
    // detail query that carries the actual financial verdict.
    return {};
  }
}
