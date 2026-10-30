/** Canonical cross-client/server event identifiers and default settings. */
export const NOTIFICATION_KINDS = [
  "wallet_topup_approved",
  "wallet_topup_rejected",
  "order_completed",
  "episode_wallet_purchased",
  "novel_published",
  "wishlist_episodes_published",
  "daily_checkin_reminder",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<Record<NotificationKind, boolean>> =
  Object.freeze({
    wallet_topup_approved: true,
    wallet_topup_rejected: true,
    order_completed: true,
    episode_wallet_purchased: true,
    novel_published: false,
    wishlist_episodes_published: true,
    daily_checkin_reminder: false,
  });

export interface NotificationPreferenceDescription {
  label: string;
  description: string;
  group: "finance" | "novel" | "engagement";
}

export const NOTIFICATION_PREFERENCE_DESCRIPTIONS: Readonly<Record<NotificationKind, NotificationPreferenceDescription>> =
  Object.freeze({
    wallet_topup_approved: {label:"เติมเงินอนุมัติ",description:"เมื่อยอดเงินเข้ากระเป๋าสำเร็จ",group:"finance"},
    wallet_topup_rejected: {label:"เติมเงินไม่ผ่าน",description:"เมื่อรายการเติมเงินถูกปฏิเสธ",group:"finance"},
    order_completed: {label:"ออเดอร์สำเร็จ",description:"เมื่อชำระเงินและยืนยันรายการสั่งซื้อแล้ว",group:"finance"},
    episode_wallet_purchased: {label:"ซื้อตอนด้วย Wallet",description:"เมื่อหักเงินและได้รับสิทธิ์อ่านตอนสำเร็จ",group:"finance"},
    novel_published: {label:"นิยายเรื่องใหม่",description:"รับแจ้งนิยายใหม่ในเว็บไซต์ (ต้องเปิดเอง)",group:"novel"},
    wishlist_episodes_published: {label:"Wishlist อัปเดตตอนใหม่",description:"รับแจ้งตอนใหม่ของเรื่องที่บันทึกไว้",group:"novel"},
    daily_checkin_reminder: {label:"เตือนเช็คอิน",description:"รับการเตือนตามวันในประเทศไทย (ต้องเปิดเอง)",group:"engagement"},
  });
