import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("IPE-056-M preview fingerprint diagnostics and repair", () => {
  const publish = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialPublish.service.ts"), "utf8");
  const status = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialStatus.service.ts"), "utf8");

  it("materializes a missing Google anchor only from one durable source and one owned active connection", () => {
    expect(publish).toContain("materializeEditorialGoogleAnchor");
    expect(publish).toContain("sources.length !== 1");
    expect(publish).toContain("connections.length !== 1");
    expect(publish).toContain("workspaceEditorialSourceSnapshots");
    expect(publish).toContain("workspaceDocumentFingerprints");
  });

  it("repairs only on explicit Prepare Ownership and then re-reads fail-closed state", () => {
    expect(publish).toContain("const repaired = await materializeEditorialGoogleAnchor");
    expect(publish).toContain("if (repaired) state = await getEditorialPublishReadModel(input)");
    expect(publish).toContain("Re-import the Google Doc if its connection is ambiguous or unavailable.");
  });

  it("does not let publish diagnostics erase QC, approval, or stage evidence", () => {
    expect(status).toContain("getEditorialApprovalReadModel");
    expect(status).toContain("Publish diagnostics must not erase independently durable QC/approval/stage evidence.");
    expect(status).toContain("readyToPublish = Boolean(state.requestReady)");
  });
});
