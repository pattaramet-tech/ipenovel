// IPE-061R1 — STALE_PREVIEW UX recovery: static UI contract tests.
// Per repo convention (no jsdom/RTL), these read WorkspacePage.tsx and the
// router as text and pin the recovery flow: typed detection, single refetch,
// preview replacement, actionable toast, and the no-auto-sync guarantee.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-061R1 stale-preview recovery contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const router = source("server/workspace/router.ts");

  it("detects STALE_PREVIEW through the typed cause code, not message strings", () => {
    expect(router).toContain('cause: error instanceof WorkspaceMasterIntakeError ? { code: error.code } : undefined');
    expect(page).toContain('causeCode !== "STALE_PREVIEW"');
    // The client never sniffs the Thai/English message text.
    expect(page).not.toContain('error.message.includes("');
    expect(page).not.toContain('message.includes("Google Sheet');
  });

  it("recovers by refetching the preview once and swapping the fresh result in", () => {
    const onErrorBlock = page.slice(
      page.indexOf("IPE-061R1: stale-preview recovery"),
      page.indexOf("const createEditorialNovel")
    );
    expect(onErrorBlock).toContain("masterIntakePreviewQuery.refetch()");
    expect(onErrorBlock.match(/refetch\(\)/g) || []).toHaveLength(1);
    expect(onErrorBlock).toContain("setMasterIntakePreviewResult(response.data);");
  });

  it("shows the actionable refresh toast and never auto-syncs", () => {
    const onErrorBlock = page.slice(
      page.indexOf("IPE-061R1: stale-preview recovery"),
      page.indexOf("const createEditorialNovel")
    );
    expect(onErrorBlock).toContain("ข้อมูลเปลี่ยนหลัง Preview — อัปเดต Preview ล่าสุดให้แล้ว กรุณาตรวจสอบแล้วกด Sync อีกครั้ง");
    // No automatic re-sync: the recovery block contains no masterIntakeSync.mutate.
    expect(onErrorBlock).not.toContain("masterIntakeSync.mutate");
  });

  it("keeps non-STALE errors on the existing toast path", () => {
    const onErrorBlock = page.slice(
      page.indexOf("IPE-061R1: stale-preview recovery"),
      page.indexOf("const createEditorialNovel")
    );
    expect(onErrorBlock).toContain("toast.error(error.message);");
  });

  it("shows a clear error and stops syncing when the refresh itself fails", () => {
    const onErrorBlock = page.slice(
      page.indexOf("IPE-061R1: stale-preview recovery"),
      page.indexOf("const createEditorialNovel")
    );
    expect(onErrorBlock).toContain("อัปเดต Preview ไม่สำเร็จ");
    expect(onErrorBlock).not.toContain("masterIntakeSync.mutate");
  });

  it("server stale guard remains fail-closed (fingerprint compare before mutation)", () => {
    const service = source("server/workspace/masterIntake.service.ts");
    expect(service).toContain('preview.previewFingerprint !== input.expectedPreviewFingerprint');
    expect(service).toContain('"STALE_PREVIEW"');
    // The preview-bound ownership guard from IPE-061 remains.
    expect(service).toContain("reconcileStaleProvenanceId != null && existing");
  });
});
