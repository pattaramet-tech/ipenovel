import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
describe("IPE-056-O pre-publish ownership preparation", () => {
  const editorial = read("server/workspace/editorialPublish.service.ts");
  const ownership = read("server/workspace/publishOwnershipTransition.service.ts");
  it("uses an explicit pre-publish readiness phase for editorial preparation", () => {
    expect(editorial).toContain('readinessPhase: "pre_publish"');
    expect(ownership).toContain('phase: "pre_publish" | "final" = "final"');
    expect(ownership).toContain('const readinessPhase = input.readinessPhase ?? "final"');
  });
  it("does not require terminal publish evidence during pre-publish preparation", () => {
    expect(ownership).toContain('if (phase === "final")');
    expect(ownership).toContain('blockers.push("UNRESOLVED_PUBLISH_ITEMS")');
    expect(ownership).toContain('blockers.push("PUBLISHED_ITEM_MISSING_RECEIPT")');
    expect(ownership).toContain('blockers.push("OUTBOX_BACKLOG_PRESENT")');
  });
  it("keeps the generic cutover API final-readiness by default", () => {
    expect(ownership).toContain('if (input.direction === "cutover" && readinessPhase === "final")');
    expect(ownership).toContain("getPublishCutoverReadiness");
  });
});
