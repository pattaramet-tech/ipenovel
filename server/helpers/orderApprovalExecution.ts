import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const DEFAULT_VERIFICATION_TIMEOUT_MS = 15_000;
const SLOW_STAGE_MS = 5_000;

export class OrderApprovalVerificationTimeoutError extends Error {
  readonly code = "ORDER_PAYMENT_VERIFICATION_TIMEOUT";

  constructor() {
    super("Payment slip verification timed out. Nothing was approved. Please ask an administrator to check the verification logs before retrying.");
    this.name = "OrderApprovalVerificationTimeoutError";
  }
}

export type OrderApprovalVerificationBudget = {
  throwIfExpired(): void;
  remainingMs(maxMs: number): number;
};

/**
 * Cooperative verification budget, not a transaction/DB/signer hard deadline.
 * Callers check between operations and cap abortable fetches with remainingMs.
 * It never races a transaction promise or leaves financial work unawaited.
 */
export function createOrderApprovalVerificationBudget(options: {
  timeoutMs?: number;
  now?: () => number;
} = {}): OrderApprovalVerificationBudget {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  requirePositiveFinite(timeoutMs);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();

  const remaining = () => {
    const elapsed = now() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed >= timeoutMs) {
      throw new OrderApprovalVerificationTimeoutError();
    }
    return timeoutMs - Math.max(0, elapsed);
  };

  return {
    throwIfExpired() { remaining(); },
    remainingMs(maxMs) {
      requirePositiveFinite(maxMs);
      return Math.min(maxMs, remaining());
    },
  };
}

function requirePositiveFinite(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Verification timeout must be a positive finite number");
  }
}

export const ORDER_APPROVAL_EXECUTION_STAGES = [
  "account_guard",
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
  "connection_id",
  "owner_read",
  "payment_current_read",
  "current_byte_hash",
  "legacy_scan_state",
  "legacy_duplicate_scan",
  "legacy_alias_scan",
  "claim_insert",
  "verification",
] as const;

export type OrderApprovalExecutionStage = (typeof ORDER_APPROVAL_EXECUTION_STAGES)[number];
const STAGE_SET = new Set<string>(ORDER_APPROVAL_EXECUTION_STAGES);

type ExecutionContext = {
  runId: string;
  paymentId?: number;
  connectionId?: number;
};

const executions = new AsyncLocalStorage<ExecutionContext>();
type TraceEvent = "run_start" | "run_end" | "run_error" | "stage_start" | "stage_end" | "stage_error" | "stage_slow";
type TraceOutcome = "committed" | "transaction_failed" | "returned_to_caller" | "failed_to_caller";

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function elapsedMs(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed * 10) / 10) : 0;
}

/** Only these fixed fields can reach logs; errors and query values never do. */
function emit(
  context: ExecutionContext,
  event: TraceEvent,
  detail: { stage?: OrderApprovalExecutionStage; durationMs?: number; elapsedMs?: number; outcome?: TraceOutcome } = {},
): void {
  const record = {
    event,
    runId: context.runId,
    ...(context.paymentId !== undefined ? { paymentId: context.paymentId } : {}),
    ...(context.connectionId !== undefined ? { connectionId: context.connectionId } : {}),
    processPid: process.pid,
    ...detail,
  };
  // Diagnostics must not replace a payment's result if a logging sink fails.
  try {
    const line = `[OrderPaymentApprovalExecution] ${JSON.stringify(record)}`;
    if (event === "stage_slow") console.warn(line);
    else console.info(line);
  } catch { /* best-effort diagnostics only */ }
}

/**
 * ownsTransaction=true is reserved for a callback returning the actual owned
 * DB transaction promise (including commit/rollback). A rejection does not
 * prove rollback: connection acquisition, commit or rollback itself can fail.
 * Borrowed transactions
 * must pass false: returning from their callback does not prove a commit.
 */
export async function withOrderApprovalExecution<T>(
  paymentId: number,
  ownsTransaction: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const context: ExecutionContext = {
    runId: randomUUID(),
    ...(isPositiveSafeInteger(paymentId) ? { paymentId } : {}),
  };
  return executions.run(context, async () => {
    const startedAt = performance.now();
    emit(context, "run_start");
    try {
      const result = await fn();
      emit(context, "run_end", {
        outcome: ownsTransaction ? "committed" : "returned_to_caller",
        durationMs: elapsedMs(startedAt),
      });
      return result;
    } catch (error) {
      emit(context, "run_error", {
        outcome: ownsTransaction ? "transaction_failed" : "failed_to_caller",
        durationMs: elapsedMs(startedAt),
      });
      throw error;
    }
  });
}

export function setOrderApprovalConnectionId(id: unknown): void {
  const context = executions.getStore();
  if (context && isPositiveSafeInteger(id)) context.connectionId = id;
}

export async function traceOrderApprovalStage<T>(
  stage: OrderApprovalExecutionStage,
  fn: () => Promise<T>,
): Promise<T> {
  const context = executions.getStore();
  // Guard the runtime boundary as well as the TypeScript union. Never print
  // an arbitrary label or turn a diagnostic label into a business failure.
  if (!context || !STAGE_SET.has(stage)) return fn();
  const startedAt = performance.now();
  emit(context, "stage_start", { stage });
  const slowTimer = setTimeout(() => {
    emit(context, "stage_slow", { stage, elapsedMs: elapsedMs(startedAt) });
  }, SLOW_STAGE_MS);
  slowTimer.unref?.();
  try {
    const result = await fn();
    emit(context, "stage_end", { stage, durationMs: elapsedMs(startedAt) });
    return result;
  } catch (error) {
    emit(context, "stage_error", { stage, durationMs: elapsedMs(startedAt) });
    throw error;
  } finally {
    clearTimeout(slowTimer);
  }
}
