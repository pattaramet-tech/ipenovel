import { describe, expect, it, vi } from "vitest";

import type { NqaAuthenticatedPrincipal } from "../mcp/contracts";
import { createNqaNovelIdAutolinkHandlers } from "./handlers";
import type { NqaNovelIdAutolinkService } from "./service";

const principal: NqaAuthenticatedPrincipal = {
  principalId: "workspace-admin-7",
  sessionId: "session-1",
  permissions: ["READ", "REMEDIATION"],
  authenticated: true,
};

describe("NQA novel-id autolink MCP handlers", () => {
  it("maps preview to the requested row without mutation input", async () => {
    const previewRow = vi.fn(async (row: number) => ({
      status: "MATCH",
      row,
      matchedNovelId: 812,
    }));
    const confirmBackfill = vi.fn();
    const service = {
      previewRow,
      confirmBackfill,
    } as unknown as NqaNovelIdAutolinkService;
    const handlers = createNqaNovelIdAutolinkHandlers(service);

    const result = await handlers["nqa.novel_link.preview"]({
      principal,
      requestId: "preview-1",
      correlationId: "corr-1",
      capability: "nqa.novel_link.preview",
      target: { row: 1744 },
      inputFingerprint: null,
    });

    expect(previewRow).toHaveBeenCalledWith(1744);
    expect(confirmBackfill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "MATCH", matchedNovelId: 812 });
  });

  it("uses the authenticated principal as explicit confirmer and binds the supplied preview fingerprint", async () => {
    const previewRow = vi.fn();
    const confirmBackfill = vi.fn(async input => ({
      status: "BACKFILLED",
      ...input,
    }));
    const service = {
      previewRow,
      confirmBackfill,
    } as unknown as NqaNovelIdAutolinkService;
    const handlers = createNqaNovelIdAutolinkHandlers(service);

    const result = await handlers["nqa.novel_link.confirm_backfill"]({
      principal,
      requestId: "confirm-row-1744",
      correlationId: "corr-2",
      capability: "nqa.novel_link.confirm_backfill",
      target: { row: 1744, novelId: "812" },
      inputFingerprint: "a".repeat(64),
    });

    expect(confirmBackfill).toHaveBeenCalledWith({
      row: 1744,
      novelId: 812,
      previewFingerprint: "a".repeat(64),
      authorizationId: "confirm-row-1744",
      authorizerId: "workspace-admin-7",
    });
    expect(result).toMatchObject({ status: "BACKFILLED", novelId: 812 });
  });

  it("requires a preview fingerprint for confirmation", async () => {
    const service = {
      previewRow: vi.fn(),
      confirmBackfill: vi.fn(),
    } as unknown as NqaNovelIdAutolinkService;
    const handlers = createNqaNovelIdAutolinkHandlers(service);

    await expect(
      handlers["nqa.novel_link.confirm_backfill"]({
        principal,
        requestId: "confirm-row-1744",
        correlationId: "corr-3",
        capability: "nqa.novel_link.confirm_backfill",
        target: { row: 1744, novelId: "812" },
        inputFingerprint: null,
      })
    ).rejects.toThrow("requires the preview fingerprint");
  });
});
