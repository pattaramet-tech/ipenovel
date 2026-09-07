import React from "react";

export function ProviderVerificationPanel({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fields: [string, string][] = [
    ["approvalOutcome", "ผลอนุมัติอัตโนมัติ"], ["approvalReason", "เหตุผลการอนุมัติ"],
    ["approvalCheckedAt", "เวลาอนุมัติ/ตรวจการอนุมัติ"], ["approvalPolicyRevision", "รุ่นการตั้งค่าอนุมัติ"],
    ["provider", "ผู้ให้บริการ"], ["outcome", "ผลตรวจ"], ["reason", "เหตุผล"],
    ["httpStatus", "HTTP status"], ["code", "รหัสผลผู้ให้บริการ"],
    ["recipientCheckApplied", "ส่งเงื่อนไขตรวจผู้รับ"], ["amountMatches", "ยอดเงินตรง"],
    ["amount", "ยอดเงิน"], ["occurredAt", "เวลาโอน"], ["checkedAt", "เวลาตรวจ"],
    ["providerReference", "เลขอ้างอิงผู้ให้บริการ"], ["bankTransactionReference", "เลขอ้างอิงธุรกรรม"],
  ];
  return <section className="rounded border p-4 space-y-2">
    <h3 className="font-semibold">ผลตรวจสลิปผ่าน API</h3>
    <dl className="space-y-1">{fields.map(([key, label]) => {
      const item = v[key];
      const display = typeof item === "boolean" ? (item ? "ใช่" : "ไม่ใช่")
        : typeof item === "string" ? item.slice(0, 160) : typeof item === "number" ? String(item) : "ไม่มีข้อมูล";
      return <div key={key} className="break-words"><dt className="inline font-medium">{label}: </dt><dd className="inline">{display}</dd></div>;
    })}</dl>
    <p className="text-sm">ใช้เลขอ้างอิงและเวลาตรวจติดต่อผู้ให้บริการ ผลตรวจไม่ใช่สถานะอนุมัติรายการ</p>
  </section>;
}
