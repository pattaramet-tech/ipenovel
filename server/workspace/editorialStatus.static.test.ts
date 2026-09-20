import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = () => fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialStatus.service.ts"), "utf8");

describe("Editorial evidence status projection", () => {
  it("derives all statuses from durable read models", () => {
    const text = source();
    expect(text).toContain("approvalState.qc?.ready");
    expect(text).toContain("approvalState.approvalStatus?.valid");
    expect(text).toContain("approvalState.stageStatus?.valid");
    expect(text).toContain("state.requestReady");
    expect(text).toContain("Publish diagnostics must not erase independently durable QC/approval/stage evidence.");
  });

  it("isolates broken rows and bounds concurrent evidence reads", () => {
    const text = source();
    expect(text).toContain("offset += 20");
    expect(text).toContain("available: false");
    expect(text).toContain("error instanceof Error ? error.message : String(error)");
    expect(text).toContain("results.push(...batch)");
  });

  it("requires complete durable publish evidence", () => {
    const text = source();
    expect(text).toContain('state.publishRun?.status === "published"');
    expect(text).toContain('item.status === "published"');
    expect(text).toContain("Boolean(item.providerReceipt)");
    expect(text).toContain('item.status === "delivered"');
    expect(text).toContain("episode.isPublished === true");
    expect(text).toContain('state.kanbanColumnKey === "published"');
  });
});
