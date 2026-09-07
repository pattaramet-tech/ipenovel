/** Orders must be created within three minutes AFTER the trusted transfer. */
export const ORDER_TRANSFER_WINDOW_MS = 3 * 60 * 1000;
function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}
export function orderTransferWindowReason(createdAt: unknown, occurredAt: unknown): string | null {
  const created = timestamp(createdAt);
  const transferred = timestamp(occurredAt);
  if (!Number.isFinite(created) || !Number.isFinite(transferred)) return "ORDER_TRANSFER_TIME_INVALID";
  const elapsed = created - transferred;
  if (elapsed < 0) return "ORDER_CREATED_BEFORE_TRANSFER";
  if (elapsed > ORDER_TRANSFER_WINDOW_MS) return "ORDER_CREATED_AFTER_TRANSFER_WINDOW";
  return null;
}
