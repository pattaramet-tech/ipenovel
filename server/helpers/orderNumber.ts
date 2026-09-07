import { getBangkokBusinessDate } from "../_core/timezone";

export const ORDER_NUMBER_MAX_DAILY_SEQUENCE = 999;
export const ORDER_NUMBER_INTERNAL_SETTING_PREFIX = "internal:order-number-sequence:";

export function formatOrderNumber(businessDate: string, sequence: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("Invalid order business date");
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > ORDER_NUMBER_MAX_DAILY_SEQUENCE) {
    throw new Error("Invalid order number sequence");
  }
  return `${businessDate.replace(/-/g, "")}${String(sequence).padStart(3, "0")}`;
}

export function getOrderNumberBusinessDate(at: Date = new Date()): string {
  return getBangkokBusinessDate(at);
}

export function getOrderNumberSequenceSettingKey(businessDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("Invalid order business date");
  }
  return `${ORDER_NUMBER_INTERNAL_SETTING_PREFIX}${businessDate}`;
}
