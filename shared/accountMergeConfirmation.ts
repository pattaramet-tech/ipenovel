export function buildAccountMergeConfirmationText(
  sourceUserId: number,
  targetUserId: number
): string {
  return `SOURCE:${sourceUserId}->TARGET:${targetUserId}`;
}

export function isAccountMergeConfirmationExact(
  sourceUserId: number,
  targetUserId: number,
  confirmation: string
): boolean {
  return (
    confirmation.trim() ===
    buildAccountMergeConfirmationText(sourceUserId, targetUserId)
  );
}
