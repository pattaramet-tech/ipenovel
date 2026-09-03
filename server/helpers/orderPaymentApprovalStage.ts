import { isLockWaitTimeout } from "./databaseErrorClassifier";

export const ORDER_PAYMENT_APPROVAL_LOCK_STAGES = [
  "account_guard",
  // Retained as a recognized legacy label for old C03/C04 log/error chains;
  // 0046 no longer emits it because points do not lock users exclusively.
  "points_user_lock",
  "payment_lock",
  "slip_claim",
  "payment_update",
  "order_update",
  "order_history",
  "finalize_points_redeem",
  "finalize_purchases",
  "finalize_points_award",
  "finalize_coupon_usage",
  "legacy_resolution_audit",
] as const;

export type OrderPaymentApprovalLockStage =
  (typeof ORDER_PAYMENT_APPROVAL_LOCK_STAGES)[number];

const STAGE_SET = new Set<string>(ORDER_PAYMENT_APPROVAL_LOCK_STAGES);
const MAX_CAUSE_DEPTH = 8;

/**
 * Adds a fixed, non-sensitive stage label only when MySQL reports a lock wait
 * timeout. Every non-1205 error is rethrown untouched so established business
 * mappings continue to see their original error/message.
 */
export async function atOrderPaymentApprovalStage<T>(
  stage: OrderPaymentApprovalLockStage,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isLockWaitTimeout(error)) throw error;
    const wrapped = new Error(`ORDER_PAYMENT_APPROVAL_LOCK_STAGE:${stage}`, {
      cause: error instanceof Error ? error : undefined,
    }) as Error & { approvalStage: OrderPaymentApprovalLockStage; cause?: unknown };
    wrapped.name = "OrderPaymentApprovalStageError";
    wrapped.approvalStage = stage;
    if (!(error instanceof Error)) wrapped.cause = error;
    throw wrapped;
  }
}

/** Extracts only a known fixed label; SQL/messages/params are never inspected. */
export function getOrderPaymentApprovalLockStage(
  error: unknown
): OrderPaymentApprovalLockStage | undefined {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    if (visited.has(current)) return undefined;
    visited.add(current);

    const link = current as { approvalStage?: unknown; cause?: unknown };
    if (
      typeof link.approvalStage === "string" &&
      STAGE_SET.has(link.approvalStage)
    ) {
      return link.approvalStage as OrderPaymentApprovalLockStage;
    }
    current = link.cause;
  }

  return undefined;
}
