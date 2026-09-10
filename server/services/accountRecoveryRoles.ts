export const ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION = "requester-survivor-v2" as const;

export type AccountRecoveryRoleBindingFailure =
  | "INVALID_DONOR"
  | "INVALID_SURVIVOR"
  | "SAME_ACCOUNT"
  | "SURVIVOR_REQUESTER_MISMATCH";

export type AccountRecoveryRoleBinding = {
  donorAccountId: number;
  survivorAccountId: number;
  requesterUserId: number;
  valid: boolean;
  failure: AccountRecoveryRoleBindingFailure | null;
};

/**
 * Explicit semantic binding for every Account Recovery / Account Merge write.
 *
 * Survivor is the currently-authenticated account that created the recovery
 * request and already owns the real Google identity. Donor is the inaccessible
 * legacy account selected by an admin; its reconciliable data flows into the
 * Survivor. Neither role is inferred from argument order: both ids must be
 * supplied and Survivor must exactly match the persisted requesterUserId.
 */
export function bindAccountRecoveryRoles(input: {
  requesterUserId: number;
  donorAccountId: number;
  survivorAccountId: number;
}): AccountRecoveryRoleBinding {
  const { requesterUserId, donorAccountId, survivorAccountId } = input;
  let failure: AccountRecoveryRoleBindingFailure | null = null;

  if (!Number.isInteger(donorAccountId) || donorAccountId <= 0) {
    failure = "INVALID_DONOR";
  } else if (!Number.isInteger(survivorAccountId) || survivorAccountId <= 0) {
    failure = "INVALID_SURVIVOR";
  } else if (donorAccountId === survivorAccountId) {
    failure = "SAME_ACCOUNT";
  } else if (survivorAccountId !== requesterUserId) {
    failure = "SURVIVOR_REQUESTER_MISMATCH";
  }

  return {
    donorAccountId,
    survivorAccountId,
    requesterUserId,
    valid: failure === null,
    failure,
  };
}

export function accountRecoveryRoleAuditMetadata(input: {
  donorAccountId: number;
  survivorAccountId: number;
}) {
  return {
    roleSemanticsVersion: ACCOUNT_RECOVERY_ROLE_SEMANTICS_VERSION,
    donorAccountId: input.donorAccountId,
    survivorAccountId: input.survivorAccountId,
  } as const;
}
