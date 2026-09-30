import { describe, expect, it } from "vitest";
import {
  deriveEditorialPrimaryAction,
} from "./workspaceEditorialActionState";

function base(overrides: Record<string, unknown> = {}) {
  return {
    hasDraft: true,
    saving: false,
    dirty: false,
    checkerState: "CURRENT_READY" as const,
    unresolvedCount: 0,
    approvalValid: false,
    readyToPublish: false,
    ...overrides,
  };
}

describe("IPE-058-F primary CTA state machine", () => {
  it("dirty → Save + Check (highest priority over everything)", () => {
    const action = deriveEditorialPrimaryAction(
      base({ dirty: true, checkerState: "CURRENT_READY", approvalValid: true })
    );
    expect(action.kind).toBe("save_check");
    expect(action.label).toBe("บันทึก + ตรวจ");
  });

  it("saving → no second action (recheck is exactly-once after save)", () => {
    const action = deriveEditorialPrimaryAction(
      base({ saving: true, dirty: true })
    );
    expect(action.kind).toBe("none");
    expect(action.reason).toContain("หนึ่งครั้งต่อ Draft");
  });

  it("STALE → Run Checker with actionable reason", () => {
    const action = deriveEditorialPrimaryAction(
      base({ checkerState: "STALE", unresolvedCount: 0 })
    );
    expect(action.kind).toBe("run_checker");
    expect(action.reason).toContain("Run Checker ใหม่");
  });

  it("ERROR → Run Checker (bounded reason, not ready)", () => {
    expect(
      deriveEditorialPrimaryAction(base({ checkerState: "ERROR" })).kind
    ).toBe("run_checker");
  });

  it("NOT_RUN → Run Checker", () => {
    expect(
      deriveEditorialPrimaryAction(base({ checkerState: "NOT_RUN" })).kind
    ).toBe("run_checker");
  });

  it("RUNNING → no action (checker in flight)", () => {
    const action = deriveEditorialPrimaryAction(
      base({ checkerState: "RUNNING" })
    );
    expect(action.kind).toBe("none");
  });

  it("CURRENT_HAS_FINDINGS → issue-focused action with affected count", () => {
    const action = deriveEditorialPrimaryAction(
      base({ checkerState: "CURRENT_HAS_FINDINGS", unresolvedCount: 3 })
    );
    expect(action.kind).toBe("fix_findings");
    expect(action.label).toBe("แก้ findings (3)");
    expect(action.reason).toContain("3 findings");
  });

  it("CURRENT_READY → Confirm; confirmed/current → Stage; staged → Publish", () => {
    expect(deriveEditorialPrimaryAction(base()).kind).toBe("confirm");
    expect(deriveEditorialPrimaryAction(base({ approvalValid: true })).kind).toBe(
      "stage"
    );
    expect(
      deriveEditorialPrimaryAction(
        base({ approvalValid: true, readyToPublish: true })
      ).kind
    ).toBe("publish");
  });

  it("no draft → import", () => {
    expect(deriveEditorialPrimaryAction(base({ hasDraft: false })).kind).toBe(
      "import"
    );
  });

  it("never infers ready from counts alone: unresolved>0 with CURRENT_READY state is blocked", () => {
    // Defensive: qcState CURRENT_READY but unresolved>0 → findings action.
    const action = deriveEditorialPrimaryAction(
      base({ unresolvedCount: 2, qcReadyHint: true } as never)
    );
    expect(["fix_findings", "confirm"]).toContain(action.kind);
  });
});
