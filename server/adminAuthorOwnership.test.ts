import { afterEach, describe, expect, it, vi } from "vitest";
import { novels as novelsSchema, users as usersSchema } from "../drizzle/schema";
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

describe("IPE-063R6 upsertUser locked-state decision (P2-A)", () => {
  afterEach(() => {
    db.__setDbForTests(null);
  });

  // IPE-063R6 fake: the plain SELECT (the snapshot read) returns the
  // PRE-LOCK row (snapshotName), while every locking read
  // (SELECT ... FOR UPDATE) returns the authoritative CURRENT row
  // (lockedName/lockedAuthorName) — the exact snapshot-vs-current
  // distinction the R6 contract is built on. The execute queue is scripted
  // in canonical order: locked author-state read → barrier (users lock →
  // merge cases → donor compensations) → propagate (locked read → barrier
  // again). An unexpected extra execute fails the test.
  function upsertFakeDb(opts: {
    snapshotName: string | null;
    lockedName: string | null;
    lockedAuthorName: string | null;
    activeMergeCase?: { id: number; status: string };
  }) {
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const userSets: any[] = [];
    const novelSets: any[] = [];
    const selects: any[][] = [
      [{ id: 7, name: opts.snapshotName, authorName: opts.lockedAuthorName }],
    ];
    const barrierCaseRows = () => (opts.activeMergeCase ? [opts.activeMergeCase] : []);
    const lockedStateRow = () => [
      { id: 7, name: opts.lockedName, authorName: opts.lockedAuthorName },
    ];
    const executeQueue: any[][] = [
      lockedStateRow(),
      [{ id: 7 }],
      barrierCaseRows(),
      [],
      lockedStateRow(),
      [{ id: 7 }],
      barrierCaseRows(),
      [],
    ];
    let executeCalls = 0;
    const tx: any = {
      execute: async () => {
        const next = executeQueue.shift();
        if (!next) throw new Error("unexpected extra users-row execute call");
        executeCalls += 1;
        return next;
      },
      insert: () => ({
        values: async (vals: Record<string, unknown>) => {
          inserted.push({ table: "users", values: vals });
          return { insertId: 555 };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selects.shift() ?? [],
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === novelsSchema) novelSets.push(values);
          else userSets.push(values);
          return { where: async () => [{ affectedRows: 1 }] };
        },
      }),
    };
    const dbHandle: any = {
      transaction: async (cb: any) => cb(tx),
      select: () => tx.select(),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          onDuplicateKeyUpdate: async (o: { set: Record<string, unknown> }) => {
            tx.insert(table).values(vals);
            void o;
            return { insertId: 555 };
          },
        }),
      }),
    };
    return { dbHandle, userSets, novelSets, inserted, executeCalls: () => executeCalls };
  }

  it("C. fallback name genuinely changes - user row and byline change atomically", async () => {
    const { dbHandle, userSets, novelSets } = upsertFakeDb({ snapshotName: "Old", lockedName: "Old", lockedAuthorName: null });
    db.__setDbForTests(dbHandle);

    await db.upsertUser({ openId: "oauth-7", name: "New", email: "a@b.test", lastSignedIn: new Date() });

    expect(userSets).toHaveLength(1);
    expect(userSets[0].name).toBe("New");
    expect(novelSets).toHaveLength(1);
    expect(novelSets[0].author).toBe("New");
  });

  it("B. same LOCKED current name - no byline write and no barrier work at all", async () => {
    const { dbHandle, userSets, novelSets, executeCalls } = upsertFakeDb({ snapshotName: "Same", lockedName: "Same", lockedAuthorName: null });
    db.__setDbForTests(dbHandle);

    await db.upsertUser({ openId: "oauth-7", name: "Same", email: "a@b.test", lastSignedIn: new Date() });

    expect(userSets).toHaveLength(1);
    expect(novelSets).toHaveLength(0);
    // Only the locking author-state read ran — an unchanged name performs no
    // merge-case locking and no pen-name re-probe (routine availability).
    expect(executeCalls()).toBe(1);
  });

  it("A. no name update - routine sign-in keeps the single-statement availability path", async () => {
    const { dbHandle, novelSets, executeCalls } = upsertFakeDb({ snapshotName: "Old", lockedName: "Old", lockedAuthorName: null });
    db.__setDbForTests(dbHandle);

    await db.upsertUser({ openId: "oauth-7", lastSignedIn: new Date() });

    expect(novelSets).toHaveLength(0);
    expect(executeCalls()).toBe(0);
  });

  it("E. merge-blocked account - the whole rename/propagation fails closed", async () => {
    const { dbHandle, userSets, novelSets } = upsertFakeDb({
      snapshotName: "Old",
      lockedName: "Old",
      lockedAuthorName: null,
      activeMergeCase: { id: 3, status: "in_progress" },
    });
    db.__setDbForTests(dbHandle);

    await expect(
      db.upsertUser({ openId: "oauth-7", name: "New", email: "a@b.test", lastSignedIn: new Date() })
    ).rejects.toThrow(/merge case 3 is in_progress/i);
    expect(userSets).toHaveLength(0);
    expect(novelSets).toHaveLength(0);
  });

  it("F. explicit pen name on the LOCKED row - users.name may change but the byline stays the pen name", async () => {
    const { dbHandle, userSets, novelSets } = upsertFakeDb({ snapshotName: "Old", lockedName: "Old", lockedAuthorName: "Pen" });
    db.__setDbForTests(dbHandle);

    await db.upsertUser({ openId: "oauth-7", name: "New", email: "a@b.test", lastSignedIn: new Date() });

    expect(userSets).toHaveLength(1);
    expect(userSets[0].name).toBe("New");
    expect(novelSets).toHaveLength(0);
  });

  // IPE-063R6 concurrency matrix CASE A: a concurrent rename commits between
  // the snapshot read and the lock. The pre-lock snapshot still shows
  // name "A" (equal to the OAuth candidate) but the LOCKED row shows "B" —
  // the decision must come from the locked state, so the OAuth rename to
  // "A" still propagates novels.author="A" instead of silently skipping
  // (which would leave users.name=A with novels.author=B).
  it("CASE A. concurrent rename visible only under lock - the stale snapshot name cannot decide", async () => {
    const { dbHandle, userSets, novelSets } = upsertFakeDb({ snapshotName: "A", lockedName: "B", lockedAuthorName: null });
    db.__setDbForTests(dbHandle);

    await db.upsertUser({ openId: "oauth-7", name: "A", email: "a@b.test", lastSignedIn: new Date() });

    expect(userSets[0].name).toBe("A");
    expect(novelSets).toHaveLength(1);
    expect(novelSets[0].author).toBe("A");
  });
});

describe("IPE-063R5 guarded novel delete (P2)", () => {
  afterEach(() => vi.restoreAllMocks());

  function deleteFakeDb(initial: { authorUserId: number | null } | null, current: { authorUserId: number | null } | null) {
    let deleteExecCount = 0;
    const deleted: boolean[] = [];
    const database: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (initial ? [initial] : []),
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          deleted.push(true);
          return [{ affectedRows: 1 }];
        },
      }),
      transaction: async (cb: any) => cb({
        execute: async () => {
          deleteExecCount += 1;
          return { 0: deleteExecCount % 3 === 1 ? [{ id: 7 }] : [] };
        },
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (current ? [current] : []),
            }),
          }),
        }),
        delete: () => ({
          where: async () => {
            deleted.push(true);
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };
    return { database, deleted };
  }

  it("A. owned novel with a safe owner - delete passes under the barrier", async () => {
    const fake = deleteFakeDb({ authorUserId: 7 }, { authorUserId: 7 });
    vi.spyOn(db, "getDb").mockResolvedValue(fake.database);
    vi.spyOn(db, "assertAccountMergeClassifiedMutationAllowed").mockResolvedValue(undefined);

    const result = await db.deleteNovelGuardedWithDb(fake.database, 42);

    expect(result.deleted).toBe(true);
    expect(fake.deleted.length).toBeGreaterThan(0);
  });

  it("B. merge-blocked owner - delete is denied and the novel remains", async () => {
    const fake = deleteFakeDb({ authorUserId: 7 }, { authorUserId: 7 });
    vi.spyOn(db, "getDb").mockResolvedValue(fake.database);
    // Real barrier behavior: the canonical assert sees an ACTIVE merge case
    // for the owner and throws - the whole tx rolls back so the novel and
    // every byline write remain untouched.
    let barrierExecute = 0;
    fake.database.transaction = async (cb: any) => cb({
      execute: async () => {
        barrierExecute += 1;
        return { 0: barrierExecute === 2 ? [{ id: 3, sourceUserId: 7, status: "in_progress" }] : [{ id: 7 }] };
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ authorUserId: 7 }],
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          deletedCalls.push(true);
          return [{ affectedRows: 1 }];
        },
      }),
    });
    const deletedCalls: boolean[] = [];

    await expect(db.deleteNovelGuardedWithDb(fake.database, 42)).rejects.toThrow(/merge case 3 is in_progress/i);
    expect(deletedCalls).toHaveLength(0);
  });

  it("D. NULL-owner legacy novel - delete keeps its unguarded behavior", async () => {
    const fake = deleteFakeDb({ authorUserId: null }, null);
    vi.spyOn(db, "getDb").mockResolvedValue(fake.database);
    const barrierSpy = vi.spyOn(db, "assertAccountMergeClassifiedMutationAllowed");

    const result = await db.deleteNovelGuardedWithDb(fake.database, 42);

    expect(result.deleted).toBe(true);
    expect(barrierSpy).not.toHaveBeenCalled();
  });
});
