import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as r2Storage from "./services/r2Storage";

/**
 * Part C of the legacy-Manus-asset migration PR: admin.sportsMatches.
 * uploadImage no longer uses the legacy Manus storage proxy (storagePut) -
 * it now goes through the same optimizeAndUploadToR2() helper as
 * admin.novels.uploadCover / admin.banners.uploadImage (WebP optimize +
 * PUBLIC R2), so it never needs BUILT_IN_FORGE_API_URL/API_KEY. Only r2Put
 * is mocked here (no real network) - optimizeImageToWebp runs for real
 * against a real, tiny PNG so the whole pipeline is genuinely exercised.
 */
vi.mock("./services/r2Storage", async () => {
  const actual = await vi.importActual<typeof import("./services/r2Storage")>("./services/r2Storage");
  return { ...actual, r2Put: vi.fn() };
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function contextFor(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function fakeAdmin(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 1,
    openId: "admin-1",
    email: "admin@example.com",
    name: "Admin",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  } as AuthenticatedUser;
}

// A real, tiny, valid 1x1 PNG (not a mock) - so optimizeImageToWebp's sharp
// decode step genuinely succeeds rather than being bypassed.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("admin.sportsMatches.uploadImage - Part C (Public R2, no Manus storagePut)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("18. no longer calls the legacy Manus storagePut - static source assertion", () => {
    // A literal source-text assertion (see server/services/
    // manusRemovalStaticAssertions.test.ts for the equivalent pattern on the
    // slip/episode upload services) that this exact procedure's block no
    // longer imports or calls storagePut, and does call the R2 pipeline.
    const source: string = readFileSync(join(__dirname, "routers.ts"), "utf8");
    expect(source).not.toMatch(/from ["']\.\/storage["']/);
    expect(source).not.toMatch(/\bstoragePut\s*\(/);
    expect(source).toMatch(/SPORTS_MATCH_IMAGE_PRESET/);
  });

  it("19. uploads via optimizeImageToWebp + r2Put (Public R2 mock) and returns { url, key }", async () => {
    vi.mocked(r2Storage.r2Put).mockResolvedValueOnce({
      key: "sports-matches/1/123-abc.webp",
      url: "https://media.ipenovel.com/sports-matches/1/123-abc.webp",
    });

    const caller = appRouter.createCaller(contextFor(fakeAdmin({ id: 1 })));
    const result = await caller.admin.sportsMatches.uploadImage({
      fileName: "team-logo.png",
      mimeType: "image/png",
      fileBase64: `data:image/png;base64,${TINY_PNG_BASE64}`,
    });

    expect(result).toEqual({
      key: "sports-matches/1/123-abc.webp",
      url: "https://media.ipenovel.com/sports-matches/1/123-abc.webp",
    });
    expect(r2Storage.r2Put).toHaveBeenCalledTimes(1);
    const [key, buffer, contentType] = vi.mocked(r2Storage.r2Put).mock.calls[0];
    expect(key).toMatch(/^sports-matches\/1\//);
    expect(contentType).toBe("image/webp");
    expect(Buffer.isBuffer(buffer)).toBe(true);
  });

  it("retains the 2MB max upload size", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64");
    const caller = appRouter.createCaller(contextFor(fakeAdmin()));
    await expect(
      caller.admin.sportsMatches.uploadImage({
        fileName: "big.png",
        mimeType: "image/png",
        fileBase64: oversized,
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("2MB") });
    expect(r2Storage.r2Put).not.toHaveBeenCalled();
  });

  it("retains MIME validation (rejects an unsupported mimeType at the input schema)", async () => {
    const caller = appRouter.createCaller(contextFor(fakeAdmin()));
    await expect(
      caller.admin.sportsMatches.uploadImage({
        fileName: "x.gif",
        mimeType: "image/gif" as any,
        fileBase64: TINY_PNG_BASE64,
      })
    ).rejects.toBeTruthy();
    expect(r2Storage.r2Put).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const caller = appRouter.createCaller(contextFor(null));
    await expect(
      caller.admin.sportsMatches.uploadImage({
        fileName: "x.png",
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      })
    ).rejects.toBeTruthy();
    expect(r2Storage.r2Put).not.toHaveBeenCalled();
  });

  it("rejects a non-admin authenticated caller with FORBIDDEN", async () => {
    const caller = appRouter.createCaller(contextFor(fakeAdmin({ role: "user" })));
    await expect(
      caller.admin.sportsMatches.uploadImage({
        fileName: "x.png",
        mimeType: "image/png",
        fileBase64: TINY_PNG_BASE64,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(r2Storage.r2Put).not.toHaveBeenCalled();
  });
});
