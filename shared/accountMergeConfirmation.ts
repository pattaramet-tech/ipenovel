export function buildAccountMergeConfirmationText(
  donorAccountId: number,
  survivorAccountId: number
): string {
  return `DONOR:${donorAccountId}->SURVIVOR:${survivorAccountId}`;
}

export function isAccountMergeConfirmationExact(
  donorAccountId: number,
  survivorAccountId: number,
  confirmation: string
): boolean {
  return (
    confirmation.trim() ===
    buildAccountMergeConfirmationText(donorAccountId, survivorAccountId)
  );
}
