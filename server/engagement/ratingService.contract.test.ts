import { describe, expect, it } from "vitest";
import { InMemoryEngagementRepository } from "./engagementRepository.mock";
import { upsertRating, getRatingSummary, getMyRating } from "./ratingService";
import { EngagementPolicyError } from "./policies";

const reader = { userId: 7, role: "user" as const };
const author = { userId: 9, role: "author" as const };
const novelId = 30;

async function seedPublishedNovel(repo: InMemoryEngagementRepository, authorUserId: number | null) {
  repo.novels.set(novelId, { isPublished: true, authorUserId, episodeIds: [301] });
  repo.episodes.set(301, false); // paid chapter
}

describe("ratingService", () => {
  it("R2: getRatingSummary is NOT_FOUND once a rated novel becomes unpublished (aggregate never leaks)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.episodes.set(301, true);
    await upsertRating({ repo, actor: reader, input: { novelId, stars: 4 }, now: 1_000 });
    expect(await getRatingSummary({ repo, novelId })).toEqual({ average: 4, count: 1 });

    // novel goes unpublished AFTER ratings exist
    repo.novels.set(novelId, { isPublished: false, authorUserId: 9, episodeIds: [301] });
    await expect(getRatingSummary({ repo, novelId })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
    // and the stored rating cannot be re-submitted while unpublished
    await expect(
      upsertRating({ repo, actor: reader, input: { novelId, stars: 5 }, now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
  });

  it("R1: runtime validation - stars must be integer 1-5 and novelId a positive safe integer, with no aggregate writes", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.episodes.set(301, true);
    for (const stars of [0, 6, 1.5, "5", NaN, Infinity]) {
      await expect(
        upsertRating({ repo, actor: reader, input: { novelId, stars: stars as unknown as number }, now: 1_000 })
      ).rejects.toThrow();
    }
    for (const badNovelId of [0, -1, 1.5]) {
      await expect(
        upsertRating({ repo, actor: reader, input: { novelId: badNovelId, stars: 3 }, now: 1_000 })
      ).rejects.toThrow();
    }
    expect(await getRatingSummary({ repo, novelId })).toEqual({ average: null, count: 0 }); // nothing written
  });

  it("happy path: entitled reader rates 1-5; aggregate sum/count maintained in the same transaction", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.grantPurchase(reader.userId, 301); // entitled via purchase

    const first = await upsertRating({ repo, actor: reader, input: { novelId, stars: 4 }, now: 1_000 });
    expect(first).toEqual({ stars: 4, aggregate: { sum: 4, count: 1 } });

    const second = await upsertRating({ repo, actor: reader, input: { novelId, stars: 5 }, now: 2_000 });
    expect(second).toEqual({ stars: 5, aggregate: { sum: 5, count: 1 } }); // replace, not a new vote

    const summary = await getRatingSummary({ repo, novelId });
    expect(summary).toEqual({ average: 5, count: 1 });
    const mine = await getMyRating({ repo, actor: reader, novelId });
    expect(mine?.stars).toBe(5);
  });

  it("PD-06: empty aggregate renders as no rating; averages are server-computed", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    expect(await getRatingSummary({ repo, novelId })).toEqual({ average: null, count: 0 });
  });

  it("author self-rating -> FORBIDDEN; legacy null owner -> FORBIDDEN (fail-closed)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, author.userId);
    repo.episodes.set(301, true); // even with free access, the author cannot rate own work
    await expect(
      upsertRating({ repo, actor: author, input: { novelId, stars: 5 }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));

    const legacy = new InMemoryEngagementRepository();
    await seedPublishedNovel(legacy, null); // ownership unknown -> fail-closed
    legacy.episodes.set(301, true);
    await expect(
      upsertRating({ repo: legacy, actor: reader, input: { novelId, stars: 5 }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    expect(await getRatingSummary({ repo: legacy, novelId })).toEqual({ average: null, count: 0 });
  });

  it("entitlement: free chapter allows rating; paid-without-purchase FORBIDDEN; purchase unlocks", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.episodes.set(301, true); // free episode exists
    const out = await upsertRating({ repo, actor: reader, input: { novelId, stars: 3 }, now: 1_000 });
    expect(out.aggregate).toEqual({ sum: 3, count: 1 });

    const paid = new InMemoryEngagementRepository();
    await seedPublishedNovel(paid, 9);
    paid.episodes.set(301, false); // paid only, no purchase
    await expect(
      upsertRating({ repo: paid, actor: reader, input: { novelId, stars: 4 }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    paid.grantPurchase(reader.userId, 301);
    const afterPurchase = await upsertRating({ repo: paid, actor: reader, input: { novelId, stars: 4 }, now: 2_000 });
    expect(afterPurchase.aggregate).toEqual({ sum: 4, count: 1 });
  });

  it("unpublished/archived novel -> NOT_FOUND", async () => {
    const repo = new InMemoryEngagementRepository();
    repo.novels.set(novelId, { isPublished: false, authorUserId: 9 });
    repo.episodes.set(301, true);
    await expect(
      upsertRating({ repo, actor: reader, input: { novelId, stars: 5 }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
  });

  it("idempotency: replay does not double-adjust the aggregate", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.episodes.set(301, true);
    const key = "rating_token_0000001";
    const first = await upsertRating({ repo, actor: reader, input: { novelId, stars: 5, clientRequestKey: key }, now: 1_000 });
    const second = await upsertRating({ repo, actor: reader, input: { novelId, stars: 5, clientRequestKey: key }, now: 2_000 });
    expect(second).toEqual(first);
    expect(second.aggregate).toEqual({ sum: 5, count: 1 });
    const mine = await getMyRating({ repo, actor: reader, novelId });
    expect(mine?.stars).toBe(5);
  });

  it("multiple users aggregate correctly and one-rating-per-user is enforced by replace semantics", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo, 9);
    repo.episodes.set(301, true);
    const u2 = { userId: 8, role: "user" as const };
    await upsertRating({ repo, actor: reader, input: { novelId, stars: 4 }, now: 1_000 });
    await upsertRating({ repo, actor: u2, input: { novelId, stars: 2 }, now: 2_000 });
    await upsertRating({ repo, actor: reader, input: { novelId, stars: 5 }, now: 3_000 }); // replace 4 -> 5
    const summary = await getRatingSummary({ repo, novelId });
    expect(summary).toEqual({ average: 3.5, count: 2 }); // (5+2)/2
  });
});
