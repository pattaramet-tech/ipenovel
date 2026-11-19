import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import { getTestDb, requireTestDb } from "../test-helpers/testDb";
import { uniqueTestTag } from "../test-helpers/fixtures";
import { episodes, novels, packageChapterMappings } from "../../drizzle/schema";

let testDb: ReturnType<typeof getTestDb>;
beforeAll(async () => {
  await requireTestDb();
  testDb = getTestDb();
});

function client(role: "admin" | "author" | "user" = "admin") {
  const ctx: TrpcContext = {
    user: {
      id: 900001,
      role,
      openId: "r4-test-admin",
      name: "R4 Test",
      email: "r4@example.test",
      loginMethod: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

async function createNovel(): Promise<number> {
  const tag = uniqueTestTag("r4");
  const inserted: any = await testDb.insert(novels).values({
    title: "R4 Migration Novel " + tag,
    slug: "r4-migration-" + tag,
    author: "R4 Integration",
    publicationStatus: "published",
    storyStatus: "ongoing",
  });
  return Number(inserted[0].insertId);
}

async function createPackage(novelId: number, start: number, end: number, input: {
  empty?: boolean;
  fileUrl?: string;
} = {}): Promise<number> {
  const content = input.empty
    ? null
    : Array.from({ length: end - start + 1 }, (_, i) => start + i)
      .map((n) => "บทที่ " + n + " ชื่อบท\n\nเนื้อหาบท " + n + " ทดสอบ\n\n")
      .join("");
  const inserted: any = await testDb.insert(episodes).values({
    novelId,
    episodeNumber: start + " - " + end,
    title: "R4 Package " + start,
    price: "30.00",
    saleMode: "package",
    content,
    fileUrl: input.fileUrl,
    isPublished: true,
  });
  return Number(inserted[0].insertId);
}

async function allEpisodes(novelId: number) {
  return testDb.select().from(episodes).where(eq(episodes.novelId, novelId));
}

describe("R4 legacy package migration: bounded global scan and safe batch", () => {
  it("cursor moves by last inspected id without dropping unconsumed candidates", async () => {
    const novelId = await createNovel();
    const ids = [
      await createPackage(novelId, 1, 2),
      await createPackage(novelId, 3, 4),
      await createPackage(novelId, 5, 6),
    ];
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await client().admin.episodes.packageSplitScanPage({
        novelId, cursor, limit: 1, status: "all", attentionOnly: false,
      });
      expect(page.inspected).toBeLessThanOrEqual(200);
      for (const row of page.rows) {
        expect(row.status).toBe("splittable");
        seen.push(row.packageEpisodeId);
      }
      if (!page.hasMore) break;
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor!;
    }
    expect(seen).toEqual(ids);
  });

  it("discovers every parser-supported range separator and excludes non-packages", async () => {
    const novelId = await createNovel();
    const formats = [
      { start: 51, end: 52, label: "51 - 52" },
      { start: 53, end: 54, label: "บทที่ 53–54" },
      { start: 55, end: 56, label: "ตอนที่ 55 / 56" },
      { start: 57, end: 58, label: "ตอนที่ 57 ถึง 58" },
    ];
    const ids: number[] = [];
    for (const item of formats) {
      const id = await createPackage(novelId, item.start, item.end);
      if (item.label !== item.start + " - " + item.end) {
        await testDb.update(episodes).set({ episodeNumber: item.label }).where(eq(episodes.id, id));
      }
      ids.push(id);
    }
    const notRange = await createPackage(novelId, 59, 60);
    await testDb.update(episodes).set({ episodeNumber: "ฉบับพิเศษ ไม่มีช่วง" }).where(eq(episodes.id, notRange));
    const notPackage = await createPackage(novelId, 61, 62);
    await testDb.update(episodes).set({
      episodeNumber: "บทที่ 61–62", saleMode: "chapter",
    }).where(eq(episodes.id, notPackage));

    const page = await client().admin.episodes.packageSplitScanPage({
      novelId, limit: 20, status: "all", attentionOnly: false,
    });
    expect(page.inspected).toBeLessThanOrEqual(200);
    expect(page.rows.map((row) => row.packageEpisodeId)).toEqual(ids);
    expect(page.rows.map((row) => row.episodeNumber)).toEqual(formats.map((x) => x.label));
    expect(page.rows.every((row) => row.status === "splittable")).toBe(true);

    const seen: number[] = [];
    let cursor: number | undefined;
    for (let step = 0; step < 8; step += 1) {
      const next = await client().admin.episodes.packageSplitScanPage({
        novelId, cursor, limit: 1, status: "all", attentionOnly: false,
      });
      expect(next.inspected).toBeLessThanOrEqual(200);
      seen.push(...next.rows.map((row) => row.packageEpisodeId));
      if (!next.hasMore) break;
      expect(next.nextCursor).toBeGreaterThan(cursor ?? 0);
      cursor = next.nextCursor!;
    }
    expect(seen).toEqual(ids);
    const preview = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: ids,
      pricing: { chapterPrice: "5.00" },
    });
    expect(preview.ready).toBe(4);
    expect(preview.blocked).toBe(0);
    expect(await allEpisodes(novelId)).toHaveLength(6);
  });

  it("source-required file packages are visible but never eligible for batch", async () => {
    const novelId = await createNovel();
    const packageId = await createPackage(novelId, 1, 2, {
      empty: true,
      fileUrl: "https://example.test/legacy-source.pdf",
    });
    const page = await client().admin.episodes.packageSplitScanPage({
      novelId, limit: 20, status: "source_required", attentionOnly: false,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      packageEpisodeId: packageId, status: "source_required", issueCodes: ["SOURCE_REQUIRED"],
    });
    const preview = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [packageId], pricing: { chapterPrice: "5.00" },
    });
    expect(preview).toMatchObject({ ready: 0, blocked: 1 });
    expect(preview.results[0].issues).toContain("SOURCE_REQUIRED");
    expect(await allEpisodes(novelId)).toHaveLength(1);
  });

  it("preview writes nothing; batch creates Draft chapters, preserves packages, skips on resume", async () => {
    const novelId = await createNovel();
    const a = await createPackage(novelId, 1, 2);
    const b = await createPackage(novelId, 3, 4);
    const before = await allEpisodes(novelId);
    const price = { chapterPrice: "5.00" };
    const preview = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [a, b], pricing: price,
    });
    expect(preview).toMatchObject({ ready: 2, blocked: 0, skipped: 0 });
    expect(await allEpisodes(novelId)).toHaveLength(before.length);
    const result = await client().admin.episodes.packageSplitBatchApply({
      items: preview.results.map((r) => ({ packageEpisodeId: r.packageEpisodeId, planHash: r.planHash! })),
      pricing: price,
      confirmation: "MIGRATE_PACKAGES",
    });
    expect(result).toMatchObject({ migrated: 2, skipped: 0, failed: 0 });
    const after = await allEpisodes(novelId);
    const chapters = after.filter((e) => e.saleMode === "chapter");
    expect(chapters).toHaveLength(4);
    expect(chapters.every((e) => !e.isPublished && e.publishedAt === null)).toBe(true);
    expect(chapters.find((e) => e.episodeNumber === "1")?.price).toBe("5.00");
    for (const old of before) {
      const current = after.find((row) => row.id === old.id)!;
      expect(current.content).toBe(old.content);
      expect(current.price).toBe(old.price);
      expect(current.saleMode).toBe("package");
      expect(current.fileUrl).toBe(old.fileUrl);
    }
    const mapped = await testDb.select().from(packageChapterMappings)
      .where(eq(packageChapterMappings.novelId, novelId));
    expect(mapped).toHaveLength(4);
    const resumed = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [a, b], pricing: price,
    });
    expect(resumed).toMatchObject({ ready: 0, skipped: 2 });
    expect(await allEpisodes(novelId)).toHaveLength(after.length);
  });

  it("stale plan fails only its own package, independent package still commits", async () => {
    const badNovel = await createNovel();
    const goodNovel = await createNovel();
    const bad = await createPackage(badNovel, 1, 2);
    const good = await createPackage(goodNovel, 1, 2);
    const pricing = { chapterPrice: "5.00" };
    const preview = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [bad, good], pricing,
    });
    expect(preview.ready).toBe(2);
    await testDb.update(episodes).set({
      content: "บทที่ 1 ชื่อใหม่\n\nเนื้อหาแก้ไข\n\nบทที่ 2\n\nเนื้อหาใหม่",
    }).where(eq(episodes.id, bad));
    const applied = await client().admin.episodes.packageSplitBatchApply({
      items: preview.results.map((r) => ({ packageEpisodeId: r.packageEpisodeId, planHash: r.planHash! })),
      pricing, confirmation: "MIGRATE_PACKAGES",
    });
    expect(applied).toMatchObject({ migrated: 1, failed: 1 });
    expect(applied.results.find((r) => r.packageEpisodeId === bad)?.errorCode).toBe("STALE_PLAN");
    expect((await allEpisodes(badNovel)).filter((e) => e.saleMode === "chapter")).toHaveLength(0);
    expect((await allEpisodes(goodNovel)).filter((e) => e.saleMode === "chapter")).toHaveLength(2);
  });

  it("concurrent batch applies cannot double-create the same chapters", async () => {
    const novelId = await createNovel();
    const id = await createPackage(novelId, 1, 2);
    const pricing = { chapterPrice: "5.00" };
    const p = await client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [id], pricing,
    });
    const request = {
      items: [{ packageEpisodeId: id, planHash: p.results[0].planHash! }],
      pricing, confirmation: "MIGRATE_PACKAGES" as const,
    };
    const [first, second] = await Promise.all([
      client().admin.episodes.packageSplitBatchApply(request),
      client().admin.episodes.packageSplitBatchApply(request),
    ]);
    expect(first.migrated + second.migrated).toBe(1);
    expect(first.failed + second.failed).toBe(1);
    expect((await allEpisodes(novelId)).filter((e) => e.saleMode === "chapter")).toHaveLength(2);
  });

  it("large inventory: keyset pages stay bounded and filtered scan advances without duplicates", async () => {
    const novelId = await createNovel();
    const packagesToSeed = 250;
    const chaptersToSeed = 1750;
    const rows: Array<typeof episodes.$inferInsert> = [];
    for (let i = 0; i < packagesToSeed; i += 1) {
      const start = i * 2 + 1;
      const end = start + 1;
      rows.push({
        novelId,
        episodeNumber: start + " - " + end,
        title: "R4 Bulk Pack " + i,
        saleMode: "package",
        content: "บทที่ " + start + "\nเนื้อหาตอน " + start + "\nบทที่ " + end + "\nเนื้อหาตอน " + end,
        price: "30.00",
        isPublished: true,
      });
    }
    for (let i = 0; i < chaptersToSeed; i += 1) {
      rows.push({
        novelId,
        episodeNumber: String(10000 + i),
        title: "R4 Other Chapter " + i,
        saleMode: "chapter",
        content: "เนื้อหาทดสอบ",
        price: "0.00",
        isFree: true,
      });
    }
    for (let i = 0; i < rows.length; i += 50) {
      await testDb.insert(episodes).values(rows.slice(i, i + 50));
    }

    const t0 = performance.now();
    const first = await client().admin.episodes.packageSplitScanPage({
      novelId, limit: 20, status: "all", attentionOnly: false,
    });
    const firstMs = performance.now() - t0;
    expect(first.rows).toHaveLength(20);
    expect(first.inspected).toBeLessThanOrEqual(200);
    expect(first.hasMore).toBe(true);
    const t1 = performance.now();
    const second = await client().admin.episodes.packageSplitScanPage({
      novelId, cursor: first.nextCursor!, limit: 20, status: "all", attentionOnly: false,
    });
    const secondMs = performance.now() - t1;
    expect(second.rows).toHaveLength(20);
    expect(second.inspected).toBeLessThanOrEqual(200);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.packageEpisodeId)).size).toBe(40);
    const t2 = performance.now();
    const filtered = await client().admin.episodes.packageSplitScanPage({
      novelId, limit: 20, status: "needs_attention", attentionOnly: false,
    });
    const filteredMs = performance.now() - t2;
    expect(filtered.rows).toHaveLength(0);
    expect(filtered.inspected).toBeLessThanOrEqual(200);
    expect(filtered.hasMore).toBe(true);
    expect(filtered.nextCursor).toBeGreaterThan(first.nextCursor!);

    console.info("[R4_SCAN_PERF] " + JSON.stringify({
      syntheticEpisodeRows: rows.length,
      syntheticPackages: packagesToSeed,
      firstPageMs: Math.round(firstMs),
      secondPageMs: Math.round(secondMs),
      filteredPageMs: Math.round(filteredMs),
      filteredInspected: filtered.inspected,
    }));
  }, 120_000);

  it("batch routes refuse non-admin users and invalid duplicate selections", async () => {
    await expect(client("author").admin.episodes.packageSplitScanPage({ limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client("user").admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [123], pricing: { chapterPrice: "5.00" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client().admin.episodes.packageSplitBatchPreview({
      packageEpisodeIds: [123, 123], pricing: { chapterPrice: "5.00" },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
