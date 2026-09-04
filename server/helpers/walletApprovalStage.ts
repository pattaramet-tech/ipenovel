import { isLockWaitTimeout } from "./databaseErrorClassifier";

export const WALLET_APPROVAL_LOCK_STAGES = [
  "wallet_user_guard",
  "wallet_topup_lock",
  "wallet_slip_claim",
  "wallet_topup_update",
  "wallet_balance_update",
  "wallet_transaction_insert",
  "wallet_topup_log",
  "wallet_resolution_audit",
] as const;

export type WalletApprovalLockStage =
  (typeof WALLET_APPROVAL_LOCK_STAGES)[number];

const STAGE_SET = new Set<string>(WALLET_APPROVAL_LOCK_STAGES);
const MAX_CAUSE_DEPTH = 8;

export async function atWalletApprovalStage<T>(
  stage: WalletApprovalLockStage,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isLockWaitTimeout(error)) throw error;
    const wrapped = new Error(`WALLET_APPROVAL_LOCK_STAGE:${stage}`, {
      cause: error instanceof Error ? error : undefined,
    }) as Error & { walletApprovalStage: WalletApprovalLockStage; cause?: unknown };
    wrapped.name = "WalletApprovalStageError";
    wrapped.walletApprovalStage = stage;
    if (!(error instanceof Error)) wrapped.cause = error;
    throw wrapped;
  }
}

export function getWalletApprovalLockStage(
  error: unknown
): WalletApprovalLockStage | undefined {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    if (visited.has(current)) return undefined;
    visited.add(current);

    const link = current as { walletApprovalStage?: unknown; cause?: unknown };
    if (
      typeof link.walletApprovalStage === "string" &&
      STAGE_SET.has(link.walletApprovalStage)
    ) {
      return link.walletApprovalStage as WalletApprovalLockStage;
    }
    current = link.cause;
  }

  return undefined;
}
