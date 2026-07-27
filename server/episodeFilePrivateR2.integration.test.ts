import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestNovel, createTestEpisode, deleteFixtures } from "./test-helpers/fixtures";
import { episodes, episodePurchases } from "../drizzle/schema";

/**
 * Paid/free episode files on private R2, end to end:
 *   admin upload (files.uploadEpisodeFile) -> episodes.fileUrl stores an
 *   "r2p:episodes/..." reference, never a public URL -> an unentitled user
 *   is denied a download link -> after entitlement is granted, the SAME
 *   reference resolves to a fresh signed URL -> a free episode resolves
 *   without any purchase check, but still never returns the raw reference
 *   -> admin.episodes.detail (the editable-form endpoint) always returns the
 *   raw reference unchanged, and saving the form back through
 *   admin.episodes.update does not corrupt it into a signed URL.
 *
 * R2_PRIVATE_* dummy config comes from vitest.integration.config.ts's
 * `test.env`; real S3/presigner calls are mocked below so no network call
 * ever happens.
 */

const { sendMock, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

function makeContext(userId: number, role: "user" | "admin" = "user"): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `episode-private-r2-${userId}`,
      email: `episode-private-r2-${userId}@example.test`,
      name: "Private R2 Episode Test User",
      loginMethod: "test",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const TINY_PDF_BASE64 = Buffer.from("%PDF-1.4 fixture content").toString("base64");

describe.sequential("Episode files on private R2 (real disposable test database)", () => {
  it("upload stores r2p:episodes/..., entitlement gates the signed download URL", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue("https://signed.example/episodes/1/book.pdf?X-Amz-Signature=fake");

    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "50.00", isFree: false });
    const buyer = await createTestUser();
    const stranger = await createTestUser();
    const adminCaller = appRouter.createCaller(makeContext(999999, "admin"));

    const uploadResult = await adminCaller.files.uploadEpisodeFile({
      episodeId: episode.id,
      fileName: "book.pdf",
      fileBase64: TINY_PDF_BASE64,
      mimeType: "application/pdf",
    });

    expect(uploadResult.fileUrl).toMatch(/^r2p:episodes\//);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const testDb = getTestDb();
    const [storedEpisode] = await testDb.select().from(episodes).where(eq(episodes.id, episode.id));
    expect(storedEpisode.fileUrl).toBe(uploadResult.fileUrl);
    expect(storedEpisode.fileUrl).not.toMatch(/^https?:\/\//);

    // Unentitled user: denied, no signed URL ever generated for them.
    const strangerCaller = appRouter.createCaller(makeContext(stranger.id));
    await expect(strangerCaller.myNovels.downloadUrl({ episodeId: episode.id })).rejects.toThrow(TRPCError);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    // Grant entitlement (wallet-style direct purchase), then the exact same
    // stored reference resolves to a working signed URL.
    await testDb.insert(episodePurchases).values({
      userId: buyer.id,
      novelId: novel.id,
      episodeId: episode.id,
      pricePaid: "50.00",
    });
    const buyerCaller = appRouter.createCaller(makeContext(buyer.id));
    const { downloadUrl } = await buyerCaller.myNovels.downloadUrl({ episodeId: episode.id });

    expect(downloadUrl).toBe("https://signed.example/episodes/1/book.pdf?X-Amz-Signature=fake");
    expect(downloadUrl).not.toMatch(/^r2p:/);
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);

    // deleteFixtures() has no episodePurchases support - clean up the
    // directly-inserted entitlement row ourselves before deleting its
    // parent episode/novel/user rows.
    await testDb.delete(episodePurchases).where(eq(episodePurchases.episodeId, episode.id));
    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id], userIds: [buyer.id, stranger.id] });
  }, 30000);

  it("free episode: no purchase required, but the raw r2p: reference is still never returned to the client", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue("https://signed.example/episodes/2/free.pdf?X-Amz-Signature=fake2");

    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "0.00", isFree: true });
    const anyUser = await createTestUser();
    const adminCaller = appRouter.createCaller(makeContext(999999, "admin"));

    await adminCaller.files.uploadEpisodeFile({
      episodeId: episode.id,
      fileName: "free.pdf",
      fileBase64: TINY_PDF_BASE64,
      mimeType: "application/pdf",
    });

    const userCaller = appRouter.createCaller(makeContext(anyUser.id));
    const { downloadUrl } = await userCaller.myNovels.downloadUrl({ episodeId: episode.id });

    expect(downloadUrl).toBe("https://signed.example/episodes/2/free.pdf?X-Amz-Signature=fake2");
    expect(downloadUrl).not.toMatch(/^r2p:/);

    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id], userIds: [anyUser.id] });
  }, 30000);

  it("free episode with a legacy https:// fileUrl (pre-existing data) is returned unchanged - no regression", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset();
    getSignedUrlMock.mockReset();

    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "0.00", isFree: true });
    const LEGACY_URL = "https://media.ipenovel.com/episodes/legacy-free-episode.pdf";

    const testDb = getTestDb();
    await testDb.update(episodes).set({ fileUrl: LEGACY_URL }).where(eq(episodes.id, episode.id));

    const anyUser = await createTestUser();
    const userCaller = appRouter.createCaller(makeContext(anyUser.id));
    const { downloadUrl } = await userCaller.myNovels.downloadUrl({ episodeId: episode.id });

    expect(downloadUrl).toBe(LEGACY_URL);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id], userIds: [anyUser.id] });
  }, 30000);

  it("admin.episodes.detail returns the raw r2p: reference (never a signed URL), and an admin-edit roundtrip does not corrupt it", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue("https://signed.example/should-never-be-persisted");

    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "20.00", isFree: false });
    const adminCaller = appRouter.createCaller(makeContext(999999, "admin"));

    const uploadResult = await adminCaller.files.uploadEpisodeFile({
      episodeId: episode.id,
      fileName: "book.pdf",
      fileBase64: TINY_PDF_BASE64,
      mimeType: "application/pdf",
    });

    // The edit-form endpoint must return the raw reference, not a signed URL.
    const detailBefore = await adminCaller.admin.episodes.detail({ episodeId: episode.id });
    expect(detailBefore.fileUrl).toBe(uploadResult.fileUrl);
    expect(detailBefore.fileUrl).toMatch(/^r2p:episodes\//);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    // Simulate the admin form saving back exactly what it received (the
    // common "opened the form, didn't touch the file field, hit save" case)
    // - this must NOT turn into a signed URL being persisted to the DB.
    await adminCaller.admin.episodes.update({ episodeId: episode.id, fileUrl: detailBefore.fileUrl });

    const detailAfter = await adminCaller.admin.episodes.detail({ episodeId: episode.id });
    expect(detailAfter.fileUrl).toBe(uploadResult.fileUrl);
    expect(detailAfter.fileUrl).toMatch(/^r2p:episodes\//);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    const testDb = getTestDb();
    const [storedEpisode] = await testDb.select().from(episodes).where(eq(episodes.id, episode.id));
    expect(storedEpisode.fileUrl).toBe(uploadResult.fileUrl);
    expect(storedEpisode.fileUrl).not.toMatch(/^https?:\/\//);

    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id] });
  }, 30000);
});
