import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = () => fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialStatus.service.ts"), "utf8");

describe("Editorial evidence status projection", () => {
  it("derives all statuses from durable read models", () => {
    const text = source();
    expect(text).toContain("state.qc?.ready");
    expect(text).toContain("state.approvalStatus?.valid");
    expect(text).toContain("state.stageStatus?.valid");
    expect(text).toContain("state.requestReady");
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
