// IPE-059-A - Router-level authorization tests for admin.novelExport.*.
// The service layer is mocked; these tests pin the authorization boundary
// (anonymous / non-admin / admin) and the DB-free wiring contract, the same
// split as server/admin.users.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as novelExportService from "./services/novelExport.service";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual };
});

vi.mock("./services/novelExport.service", async () => {
  const actual = await vi.importActual<typeof novelExportService>("./services/novelExport.service");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function contextFor(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function fakeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 1,
    openId: "user-1",
    email: "user@example.com",
    name: "Somchai",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
}

const PREVIEW_INPUT = { novelId: 1 };

afterEach(() => vi.restoreAllMocks());

describe("admin.novelExport - authorization", () => {
  it("anonymous caller -> UNAUTHORIZED, the export service is never invoked", async () => {
    const previewSpy = vi.spyOn(novelExportService, "buildNovelExportPreview");
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.admin.novelExport.preview(PREVIEW_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("non-admin caller -> FORBIDDEN, the export service is never invoked", async () => {
    const previewSpy = vi.spyOn(novelExportService, "buildNovelExportPreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.admin.novelExport.preview(PREVIEW_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("non-admin caller cannot download TXT or ZIP either", async () => {
    const txtSpy = vi.spyOn(novelExportService, "buildNovelTxtExport");
    const zipSpy = vi.spyOn(novelExportService, "buildNovelZipExport");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.admin.novelExport.downloadTxt({ novelId: 1, episodeId: 10 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.admin.novelExport.downloadZip(PREVIEW_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(txtSpy).not.toHaveBeenCalled();
    expect(zipSpy).not.toHaveBeenCalled();
  });

  it("admin caller reaches the export service with the validated input", async () => {
    const previewSpy = vi
      .spyOn(novelExportService, "buildNovelExportPreview")
      .mockResolvedValue({
        novelId: 1,
        novelTitle: "เรื่องทดสอบ",
        mode: "whole_novel",
        publishedEpisodeCount: 1,
        exportItemCount: 1,
        skippedItems: [],
        estimatedPlaintextBytes: 10,
        filenames: ["001.txt"],
        limits: { maxItems: 500, maxPerItemBytes: 8 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 },
      });
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));
    const result = await caller.admin.novelExport.preview(PREVIEW_INPUT);
    expect(result.exportItemCount).toBe(1);
    expect(previewSpy).toHaveBeenCalledWith(PREVIEW_INPUT);
  });

  it("admin ZIP download returns the base64 transport contract", async () => {
    vi.spyOn(novelExportService, "buildNovelZipExport").mockResolvedValue({
      filename: "เรื่องทดสอบ.zip",
      mimeType: "application/zip",
      content: Buffer.from("fake-zip"),
      manifestCsv: "episodeNumber",
      entryFilenames: ["manifest.csv"],
      itemCount: 1,
      totalPlaintextBytes: 7,
      novelTitle: "เรื่องทดสอบ",
      skippedItems: [],
    } as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));
    const result = await caller.admin.novelExport.downloadZip(PREVIEW_INPUT);
    expect(result.mimeType).toBe("application/zip");
    expect(result.contentBase64).toBe(Buffer.from("fake-zip").toString("base64"));
    expect(result.byteCount).toBe(8);
  });

  it("rejects invalid selection input before reaching the service", async () => {
    const previewSpy = vi.spyOn(novelExportService, "buildNovelExportPreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));
    await expect(caller.admin.novelExport.preview({ novelId: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.admin.novelExport.preview({ novelId: 1, episodeIds: [0] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(previewSpy).not.toHaveBeenCalled();
  });
});
