/**
 * IPE-058-F — Daily workflow primary action derivation.
 *
 * Pure presentation logic: ONE primary CTA per state, derived ONLY from the
 * canonical server state machine (IPE-058-E evaluator states) plus legitimate
 * client-local editor state (dirty/saving). No count/timestamp/ready guessing
 * — `ready` and `state` fields come straight from the durable read models.
 *
 * Priority order (first match wins):
 *   saving          → keep the user informed, no second action
 *   dirty           → save_check       (Save + Check; recheck is exactly-once)
 *   no draft        → import           (nothing to check yet)
 *   ERROR           → run_checker      (bounded error; rerun required)
 *   STALE           → run_checker      (content/allow-list changed after run)
 *   NOT_RUN         → run_checker
 *   RUNNING         → none             (checker in flight)
 *   CURRENT_HAS_FINDINGS → fix_findings (issue drawer focused)
 *   CURRENT_READY + !approvalValid      → confirm
 *   approvalValid + !readyToPublish     → stage (Stage plan gates still apply)
 *   readyToPublish                      → publish
 */

export type EditorialPrimaryActionKind =
  | "none"
  | "import"
  | "save_check"
  | "run_checker"
  | "fix_findings"
  | "confirm"
  | "stage"
  | "publish";

export type EditorialCheckerStateName =
  | "NOT_RUN"
  | "RUNNING"
  | "STALE"
  | "ERROR"
  | "CURRENT_HAS_FINDINGS"
  | "CURRENT_READY";

export type EditorialPrimaryAction = {
  kind: EditorialPrimaryActionKind;
  /** Thai label for the single primary CTA button. */
  label: string;
  /** Thai actionable reason — always answers "ตอนนี้ต้องทำอะไรต่อ". */
  reason: string;
};

export function deriveEditorialPrimaryAction(input: {
  hasDraft: boolean;
  saving: boolean;
  dirty: boolean;
  checkerState: EditorialCheckerStateName | null | undefined;
  unresolvedCount: number | null | undefined;
  approvalValid: boolean | null | undefined;
  readyToPublish: boolean | null | undefined;
}): EditorialPrimaryAction {
  if (input.saving) {
    return {
      kind: "none",
      label: "กำลังบันทึก…",
      reason: "กำลังบันทึก Draft revision ใหม่ และจะตรวจซ้ำหลังบันทึกสำเร็จ (หนึ่งครั้งต่อ Draft)",
    };
  }
  if (input.dirty) {
    return {
      kind: "save_check",
      label: "บันทึก + ตรวจ",
      reason: "มีการแก้ไขที่ยังไม่ได้บันทึก — บันทึกเป็น Draft revision ใหม่และตรวจซ้ำอัตโนมัติ",
    };
  }
  if (!input.hasDraft) {
    return {
      kind: "import",
      label: "นำเข้า Draft",
      reason: "ยังไม่มี Draft — นำเข้าต้นฉบับก่อนเริ่ม workflow",
    };
  }
  switch (input.checkerState) {
    case "ERROR":
      return {
        kind: "run_checker",
        label: "ตรวจ / ตรวจซ้ำ",
        reason: "การตรวจครั้งล่าสุดผิดพลาด — กดตรวจใหม่เพื่อสร้าง QC evidence",
      };
    case "STALE":
      return {
        kind: "run_checker",
        label: "ตรวจ / ตรวจซ้ำ",
        reason: "เนื้อหาถูกแก้หลังตรวจครั้งล่าสุด — Run Checker ใหม่",
      };
    case "NOT_RUN":
      return {
        kind: "run_checker",
        label: "ตรวจ / ตรวจซ้ำ",
        reason: "ยังไม่ได้ตรวจ Draft นี้ — Run Checker เพื่อสร้าง QC evidence",
      };
    case "RUNNING":
      return {
        kind: "none",
        label: "กำลังตรวจ…",
        reason: "Checker กำลังทำงาน — รอผลตรวจก่อนขั้นถัดไป",
      };
    case "CURRENT_HAS_FINDINGS":
      return {
        kind: "fix_findings",
        label: `แก้ findings (${input.unresolvedCount ?? 0})`,
        reason: `มี ${input.unresolvedCount ?? 0} findings ที่ยังไม่ resolve — แก้หรือยอมรับใน Issue drawer`,
      };
    case "CURRENT_READY":
      break;
    default:
      return {
        kind: "none",
        label: "รอข้อมูลสถานะ",
        reason: "ยังไม่ทราบสถานะ checker — รีเฟรชข้อมูลก่อน",
      };
  }
  if (!input.approvalValid) {
    return {
      kind: "confirm",
      label: "ยืนยัน Draft (Confirm)",
      reason: "QC ผ่านและ evidence ตรงกับ Draft ปัจจุบัน — Confirm เพื่อล็อก evidence",
    };
  }
  if (!input.readyToPublish) {
    return {
      kind: "stage",
      label: "Stage",
      reason: "Approval ใช้ได้กับ Draft ปัจจุบัน — Stage เพื่อเตรียม Episode (ดู Stage blockers หากยังไม่ผ่าน)",
    };
  }
  return {
    kind: "publish",
    label: "Publish",
    reason: "Stage พร้อมและผ่านทุกเงื่อนไข — Publish ได้ที่ขั้น 6",
  };
}
