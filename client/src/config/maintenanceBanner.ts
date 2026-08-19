/**
 * Single source of truth for the global maintenance/system-upgrade
 * announcement banner (client/src/components/MaintenanceAnnouncementBanner.tsx).
 * Edit ONLY this file to change the announcement's copy or dates, or to
 * turn it on/off - no other file hardcodes any of this banner's text.
 */
export type MaintenanceBannerConfig = {
  /** Master on/off switch. false hides the banner everywhere, unconditionally. */
  enabled: boolean;
  /** The bold headline shown first. */
  title: string;
  /** Rendered as one highlighted line - the maintenance window itself. */
  dateRangeLines: string[];
  /** Rendered as separate lines, in order - explanation/reassurance copy. */
  bodyLines: string[];
};

export const MAINTENANCE_BANNER_CONFIG: MaintenanceBannerConfig = {
  enabled: false,
  title: "ประกาศปิดปรับปรุงระบบ",
  dateRangeLines: ["วันพุธที่ 19 สิงหาคม เวลา 23.00 น.", "ถึง วันพฤหัสบดีที่ 20 สิงหาคม เวลา 03.00 น."],
  bodyLines: [
    "เพื่ออัปเกรดและย้ายระบบหลักของ IpeNovel",
    "เว็บไซต์และบริการบางส่วนอาจไม่สามารถใช้งานได้ชั่วคราว",
    "ข้อมูลบัญชี นิยายที่ซื้อ และยอดคงเหลือของผู้ใช้งานยังคงได้รับการดูแลตามปกติ",
  ],
};
