import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("M28.1 durable read auth and private inference bridge", () => {
  it("removes ephemeral Sheets read token ENV usage from admin read paths", () => {
    const runtime = source("server/nqa/admin/runtime.ts");
    const writeback = source("server/nqa/admin/writeback.ts");

    expect(runtime).not.toContain("NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN");
    expect(writeback).not.toContain("NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN");
    expect(runtime).toContain("refreshWorkspaceGoogleNqaReadAccessToken");
    expect(writeback).toContain("refreshWorkspaceGoogleNqaReadAccessToken");
  });

  it("requires the durable workspace Google connection to include Sheets readonly", () => {
    const domain = source("server/workspace/googleDocs.domain.ts");
    const durableRead = source("server/workspace/googleNqaRead.ts");

    expect(domain).toContain("https://www.googleapis.com/auth/spreadsheets.readonly");
    expect(domain).toContain("WORKSPACE_NQA_READ_SCOPES");
    expect(durableRead).toContain("hasRequiredNqaReadScopes");
    expect(durableRead).toContain("encryptedRefreshToken");
    expect(durableRead).toContain("grant_type");
    expect(durableRead).toContain('"refresh_token"');
  });

  it("keeps private inference worker auth fail-closed and operations allowlisted", () => {
    const bridge = source("server/nqa/semantic/privateBridge.ts");
    const worker = source("scripts/nqa-private-inference-worker.mjs");

    expect(bridge).toContain("timingSafeEqual");
    expect(bridge).toContain("a.length >= 32");
    expect(bridge).toContain("NQA_PRIVATE_BRIDGE_UNAUTHORIZED");
    expect(bridge).toContain("NQA_PRIVATE_BRIDGE_LOOPBACK_ONLY");
    expect(worker).toContain('NQA_BRIDGE_SERVER_URL must be an HTTPS origin.');
    expect(worker).toContain("UNSUPPORTED_JOB_KIND");
  });
});
