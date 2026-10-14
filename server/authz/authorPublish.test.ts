import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../routers";
import * as db from "../db";
import type { TrpcContext } from "../_core/context";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
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

function fakeUser(role: "user" | "author" | "admin", id = 7): AuthenticatedUser {
  return {
    id,
    openId: `open-${id}`,
    email: `${id}@example.test`,
    name: "Writer",
    loginMethod: "test",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

function mockLockedNovel(authorUserId: number | null, role: "user" | "author" | "admin", actorId = 7) {
  vi.spyOn(db, "getCompletedAccountMergeForSource").mockResolvedValue(undefined as any);
  vi.spyOn(db, "getDb").mockResolvedValue({
    transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({
                for: async () => [{ id: 5, authorUserId }],
              }),
            }),
          }),
        }),
      }),
  } as any);
  vi.spyOn(db, "lockUserRowForUpdate").mockResolvedValue({
    id: actorId,
    name: "Writer",
    role,
    openId: `open-${actorId}`,
  });
}

describe("author publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes the author's own novel without an approval call", async () => {
    mockLockedNovel(7, "author");
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));

    const result = await caller.admin.novels.publish({ novelId: 5 });

    expect(result).toEqual({ success: true });
    expect(updateSpy.mock.calls[0]?.[1]).toEqual({ publicationStatus: "published" });
  });

  it("does not publish another author's novel", async () => {
    mockLockedNovel(8, "author");
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));

    await expect(caller.admin.novels.publish({ novelId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does not publish a legacy novel with no owner", async () => {
    mockLockedNovel(null, "author");
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));

    await expect(caller.admin.novels.publish({ novelId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses a reader and still lets an admin publish a legacy novel", async () => {
    const reader = appRouter.createCaller(contextFor(fakeUser("user")));
    await expect(reader.admin.novels.publish({ novelId: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    mockLockedNovel(null, "admin", 1);
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const admin = appRouter.createCaller(contextFor(fakeUser("admin", 1)));
    const result = await admin.admin.novels.publish({ novelId: 5 });

    expect(result).toEqual({ success: true });
    expect(updateSpy.mock.calls[0]?.[1]).toEqual({ publicationStatus: "published" });
  });

  it("refuses the write when the locked role is no longer author", async () => {
    mockLockedNovel(7, "user");
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));

    await expect(caller.admin.novels.publish({ novelId: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

function mockEpisodeLock(options: {
  authorUserId: number | null;
  role: "user" | "author" | "admin";
  episode: { id: number; novelId: number } | null;
  actorId?: number;
}) {
  const actorId = options.actorId ?? 7;
  vi.spyOn(db, "getCompletedAccountMergeForSource").mockResolvedValue(undefined as any);
  let lockedReads = 0;
  const limitResult = () => ({
    for: async () => {
      lockedReads += 1;
      if (lockedReads === 1) return [{ id: options.episode?.novelId ?? 5, authorUserId: options.authorUserId }];
      return options.episode ? [options.episode] : [];
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(options.episode ? [options.episode] : []).then(resolve, reject),
  });
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => limitResult(),
      }),
    }),
  });
  vi.spyOn(db, "getDb").mockResolvedValue({
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn({ select }),
    select,
  } as any);
  vi.spyOn(db, "lockUserRowForUpdate").mockResolvedValue({
    id: actorId,
    name: "Writer",
    role: options.role,
    openId: `open-${actorId}`,
  });
}

describe("author episode publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes the author's own episode without an approval call", async () => {
    mockEpisodeLock({ authorUserId: 7, role: "author", episode: { id: 9, novelId: 5 } });
    const updateSpy = vi.spyOn(db, "updateEpisode").mockResolvedValue(undefined as any);
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));

    const result = await caller.admin.episodes.update({ episodeId: 9, isPublished: true });

    expect(result).toEqual({ success: true });
    expect(updateSpy.mock.calls[0]?.[1]).toMatchObject({ isPublished: true });
  });

  it("returns the same not-found result for a missing episode and another author's episode", async () => {
    const caller = appRouter.createCaller(contextFor(fakeUser("author")));
    const updateSpy = vi.spyOn(db, "updateEpisode").mockResolvedValue(undefined as any);

    mockEpisodeLock({ authorUserId: 7, role: "author", episode: null });
    await expect(caller.admin.episodes.update({ episodeId: 9, isPublished: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Episode not found",
    });

    vi.restoreAllMocks();
    mockEpisodeLock({ authorUserId: 8, role: "author", episode: { id: 9, novelId: 5 } });
    const updateSpyForeign = vi.spyOn(db, "updateEpisode").mockResolvedValue(undefined as any);
    await expect(caller.admin.episodes.update({ episodeId: 9, isPublished: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Episode not found",
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(updateSpyForeign).not.toHaveBeenCalled();
  });
});
