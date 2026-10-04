import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import * as db from "./db";
import { novels as novelsTable, users as usersTable } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

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
    id: 101,
    openId: "author-admin-101",
    email: "author-admin@example.test",
    name: "Author Admin",
    loginMethod: "test",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
}

function mockAuthorIdentity(userId: number, effectiveAuthorName: string) {
  return vi.spyOn(db, "resolveEffectiveAuthorName").mockResolvedValue({
    userId,
    accountName: effectiveAuthorName,
    authorName: null,
    effectiveAuthorName,
  });
}

describe("IPE-063 admin-as-author router contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("binds a newly created novel to the authenticated admin with the AUTHORITATIVE DB author name (F)", async () => {
    const createSpy = vi.spyOn(db, "createAuthorOwnedNovel").mockResolvedValue({ id: 999, author: "DarkMoon Novel", authorUserId: 77 } as any);
    // The session account name is stale — the DB says the pen name changed.
    mockAuthorIdentity(77, "DarkMoon Novel");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 77, name: "Writer Seven" })));

    await caller.admin.novels.create({
      title: "Owned Novel",
      author: "Spoofed Author",
      description: "test",
    } as any);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBe(77);
    // Client data is forwarded WITHOUT author identity fields — the byline
    // and ownership are resolved inside the guarded transaction from the
    // locked DB row (authoritative DB name beats stale session + spoof).
    expect(createSpy.mock.calls[0][1]).toEqual({
      title: "Owned Novel",
      description: "test",
      coverImageUrl: undefined,
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  it("fails closed when no usable author identity exists in the DB", async () => {
    const createSpy = vi.spyOn(db, "createNovel");
    vi.spyOn(db, "resolveEffectiveAuthorName").mockResolvedValue(null);
    const caller = appRouter.createCaller(contextFor(fakeUser({ name: "   " })));

    await expect(
      caller.admin.novels.create({ title: "No Name Novel" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("does not transfer author ownership when another admin edits a novel (H)", async () => {
    const updateSpy = vi.spyOn(db, "updateNovel").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 88, name: "Editor Eight" })));

    await caller.admin.novels.update({
      novelId: 44,
      description: "Edited by another admin",
      author: "Hijacked",
      authorUserId: 88,
    } as any);

    expect(updateSpy).toHaveBeenCalledWith(44, {
      description: "Edited by another admin",
    });
  });

  it("binds bulk-created novels to the authenticated admin with the authoritative DB name (G)", async () => {
    const bulkSpy = vi.spyOn(db, "bulkCreateNovels").mockResolvedValue({ success: [], errors: [] });
    mockAuthorIdentity(55, "Bulk Pen Name");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 55, name: "Bulk Writer" })));

    await caller.admin.bulkUpload.novels({ rows: [{ title: "Bulk Novel" }] });

    expect(bulkSpy).toHaveBeenCalledWith(
      [{ title: "Bulk Novel" }],
      { userId: 55 }
    );
  });

  it("derives Author Analysis scope only from ctx.user.id (I/J)", async () => {
    const analyticsSpy = vi.spyOn(db, "getAuthorAnalytics").mockResolvedValue({
      period: "30d",
      month: null,
      totalNovels: 0,
      totalRevenue: 0,
      totalPurchases: 0,
      currentWishlistCount: 0,
      salesChannels: {
        orderRevenue: 0,
        walletRevenue: 0,
        orderPurchases: 0,
        walletPurchases: 0,
      },
      novels: [],
    });
    mockAuthorIdentity(123, "Scoped Author");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 123, name: "Scoped Author" })));

    const result = await caller.admin.authorAnalytics.summary({ period: "30d" });

    expect(analyticsSpy).toHaveBeenCalledWith(123, "30d", undefined);
    expect(result.author).toEqual({ userId: 123, displayName: "Scoped Author" });
  });

  it("rejects regular users before Author Analysis reaches the data layer (M)", async () => {
    const analyticsSpy = vi.spyOn(db, "getAuthorAnalytics");
    const profileSpy = vi.spyOn(db, "resolveEffectiveAuthorName");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));

    await expect(caller.admin.authorAnalytics.summary({ period: "all" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.admin.authorProfile.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(analyticsSpy).not.toHaveBeenCalled();
    expect(profileSpy).not.toHaveBeenCalled();
  });
});

describe("IPE-063R1 self-scoped author profile contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("get resolves the profile from ctx.user.id only and reports the effective name", async () => {
    const identitySpy = mockAuthorIdentity(101, "DarkMoon");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 101, name: "Account Name" })));

    const result = await caller.admin.authorProfile.get();

    expect(identitySpy).toHaveBeenCalledWith(101);
    expect(result).toMatchObject({
      userId: 101,
      effectiveAuthorName: "DarkMoon",
    });
  });

  it("update propagates the trimmed pen name through the DB owner (A)", async () => {
    const updateSpy = vi
      .spyOn(db, "updateAuthorProfile")
      .mockResolvedValue({
        userId: 101,
        accountName: "Account Name",
        authorName: "DarkMoon",
        effectiveAuthorName: "DarkMoon",
        updatedNovels: 4,
      });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 101 })));

    const result = await caller.admin.authorProfile.update({ authorName: "DarkMoon" });

    expect(updateSpy).toHaveBeenCalledWith(101, "DarkMoon");
    expect(result).toMatchObject({ authorName: "DarkMoon", updatedNovels: 4 });
  });

  it("update with empty string clears the pen name (C fallback path)", async () => {
    const updateSpy = vi.spyOn(db, "updateAuthorProfile").mockResolvedValue({
      userId: 101,
      accountName: "Account Name",
      authorName: null,
      effectiveAuthorName: "Account Name",
      updatedNovels: 2,
    });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 101 })));

    await caller.admin.authorProfile.update({ authorName: "" });

    expect(updateSpy).toHaveBeenCalledWith(101, "");
  });

  it("never accepts a caller-supplied userId target (D/E)", async () => {
    const updateSpy = vi.spyOn(db, "updateAuthorProfile").mockResolvedValue({
      userId: 101,
      accountName: "Account Name",
      authorName: "Hijack Attempt",
      effectiveAuthorName: "Hijack Attempt",
      updatedNovels: 0,
    });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 101 })));

    // zod strips the unknown userId/authorUserId keys and the router reads
    // ctx.user.id — the mutation target stays the signed-in admin no matter
    // what the client sends.
    await caller.admin.authorProfile.update({
      authorName: "Hijack Attempt",
      userId: 999,
      authorUserId: 999,
    } as any);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe(101);
  });

  it("rejects anonymous callers with UNAUTHORIZED (N)", async () => {
    const caller = appRouter.createCaller(contextFor(null));

    await expect(caller.admin.authorProfile.get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.admin.authorProfile.update({ authorName: "X" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("IPE-063R1 author name propagation (db layer)", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeDb(userRow: { id: number; name: string | null } | null) {
    const calls: Array<{ table: unknown; set: Record<string, unknown>; where: string }> = [];
    const executeQueue: any[][] = [[{ id: 7 }], [], []];
    const tx: any = {
      execute: async () => ({ 0: executeQueue.shift() ?? [] }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (userRow ? [userRow] : []),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            calls.push({ table, set: values, where: "where" });
            return [{ affectedRows: 3 }];
          },
        }),
      }),
    };
    const dbHandle = {
      transaction: async (fn: (tx: any) => Promise<number>) => fn(tx),
    };
    return { calls, dbHandle };
  }

  it("A. sets users.authorName and syncs every owned novel's author in one transaction", async () => {
    const { calls, dbHandle } = fakeDb({ id: 7, name: "Account Seven" });
    const result = await db.updateAuthorProfileWithDb(dbHandle as any, 7, "  DarkMoon  ");

    expect(result).toMatchObject({
      userId: 7,
      authorName: "DarkMoon",
      effectiveAuthorName: "DarkMoon",
      updatedNovels: 3,
    });
    expect(calls.map((call) => call.table)).toEqual([
      usersTable,
      novelsTable,
    ]);
    expect(calls[0].set).toMatchObject({ authorName: "DarkMoon" });
    expect(calls[1].set).toMatchObject({ author: "DarkMoon" });
  });

  it("B/C. clearing authorName falls back to the account name and syncs owned novels", async () => {
    const { calls, dbHandle } = fakeDb({ id: 7, name: "Account Seven" });
    const result = await db.updateAuthorProfileWithDb(dbHandle as any, 7, null);

    expect(result).toMatchObject({
      authorName: null,
      effectiveAuthorName: "Account Seven",
    });
    expect(calls[0].set).toMatchObject({ authorName: null });
    expect(calls[1].set).toMatchObject({ author: "Account Seven" });
  });

  it("fails closed with 400 when neither authorName nor account name is usable", async () => {
    const { dbHandle } = fakeDb({ id: 7, name: "   " });
    await expect(db.updateAuthorProfileWithDb(dbHandle as any, 7, null)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("IPE-063R3 guarded author-owned creation (P1 + P2 serialization)", () => {
  afterEach(() => vi.restoreAllMocks());

  function guardedFakeDb(userRow: { id: number; name: string | null; authorName: string | null } | null) {
    const executeQueue: any[][] = [
      [{ id: 7 }],
      [],
      [],
    ];
    const selectQueue: any[][] = [
      [userRow ?? []].flat().length && userRow ? [userRow] : [],
      [],
      [],
    ];
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx: any = {
      execute: async () => ({ 0: executeQueue.shift() ?? [] }),
      select: () => ({
        from: () => ({
          where: () => {
            const rows = selectQueue.shift() ?? [];
            return {
              limit: async () => rows,
              then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
            };
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push({ table, values });
          return { insertId: 4242 };
        },
      }),
      update: () => ({
        set: async () => [{ affectedRows: 1 }],
      }),
    };
    const dbHandle: any = {
      transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
      execute: async () => ({ 0: executeQueue.shift() ?? [] }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selectQueue.shift() ?? [],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push({ table, values });
          return { insertId: 4242 };
        },
      }),
    };
    return { dbHandle, tx, inserted };
  }

  it("creates the novel under the account-merge barrier with the authoritative locked-row byline (P1+P2)", async () => {
    const { dbHandle, inserted } = guardedFakeDb({
      id: 7,
      name: "Account Seven",
      authorName: "DarkMoon",
    });
    const result = await db.createAuthorOwnedNovelWithDb(dbHandle, 7, { title: "Owned Novel" });

    expect(result).toMatchObject({
      id: 4242,
      author: "DarkMoon",
      authorUserId: 7,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe(novelsTable);
    expect(inserted[0].values).toMatchObject({
      author: "DarkMoon",
      authorUserId: 7,
    });
  });

  it("fails closed with BAD_REQUEST when the locked row has no usable identity", async () => {
    const { dbHandle } = guardedFakeDb({ id: 7, name: null, authorName: null });
    await expect(
      db.createAuthorOwnedNovelWithDb(dbHandle, 7, { title: "No Name Novel" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("routes admin.novels.create through the guarded author-owned creator (spoof ignored)", async () => {
    const guardedSpy = vi.spyOn(db, "createAuthorOwnedNovel").mockResolvedValue({
      id: 999,
      author: "DB Name",
      authorUserId: 77,
    } as any);
    mockAuthorIdentity(77, "DB Name");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 77, name: "Stale Session" })));

    await caller.admin.novels.create({
      title: "Owned Novel",
      author: "Spoofed Author",
    } as any);

    expect(guardedSpy).toHaveBeenCalledWith(
      77,
      expect.not.objectContaining({ author: expect.anything(), authorUserId: expect.anything() })
    );
  });

  it("bulk upload passes only the userId — per-row guarded resolution owns the byline (G)", async () => {
    const bulkSpy = vi.spyOn(db, "bulkCreateNovels").mockResolvedValue({ success: [], errors: [] });
    mockAuthorIdentity(55, "Any Pre-check Name");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 55, name: "Bulk Writer" })));

    await caller.admin.bulkUpload.novels({ rows: [{ title: "Bulk Novel" }] });

    expect(bulkSpy).toHaveBeenCalledWith([{ title: "Bulk Novel" }], { userId: 55 });
  });
});
