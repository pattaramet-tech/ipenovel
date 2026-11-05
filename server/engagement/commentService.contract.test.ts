import { describe, expect, it } from "vitest";
import { InMemoryEngagementRepository } from "./engagementRepository.mock";
import { createComment, actOnComment, listVisibleComments } from "./commentService";
import { EngagementPolicyError } from "./policies";
import { RateLimitExceededError } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS } from "./engagementRepository";

const MINUTE = APPROVED_RATE_LIMITS.comment.windowMs;
const reader = { userId: 7, role: "user" as const };
const stranger = { userId: 8, role: "user" as const };
const admin = { userId: 1, role: "admin" as const };
const novelId = 30;

async function seedPublishedNovel(repo: InMemoryEngagementRepository) {
  repo.novels.set(novelId, { isPublished: true, authorUserId: null });
}

describe("commentService", () => {
  it("R2: unknown comment action (non-admin) is rejected with NO write or audit", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: reader, input: { novelId, message: "ok" }, now: 1_000 });
    await expect(
      actOnComment({
        repo,
        actor: reader,
        commentId: root.commentId,
        action: "banana" as unknown as "author_delete",
        now: 2_000,
      })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    const page = await listVisibleComments({ repo, novelId, limit: 10 });
    expect(page.roots[0].status).toBe("visible"); // unchanged
    expect(await repo.comments.listModerationAudit(root.commentId)).toHaveLength(0); // no audit write
  });

  it("R1: listVisibleComments is NOT_FOUND for missing/unpublished novels (no content leak)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    await createComment({ repo, actor: reader, input: { novelId, message: "public" }, now: 1_000 });
    repo.novels.set(31, { isPublished: false, authorUserId: null });
    await expect(listVisibleComments({ repo, novelId: 999, limit: 10 })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
    await expect(listVisibleComments({ repo, novelId: 31, limit: 10 })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
    // published novel still serves its page
    const page = await listVisibleComments({ repo, novelId, limit: 10 });
    expect(page.roots).toHaveLength(1);
  });

  it("R1: runtime validation rejects malformed novelId/message/key before storage", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    for (const badNovelId of [0, -1, 1.5, Number.NaN]) {
      await expect(
        createComment({ repo, actor: reader, input: { novelId: badNovelId, message: "x".repeat(5) }, now: 1_000 })
      ).rejects.toThrow();
    }
    for (const bad of [
      { message: "invisible\u0000char" },
      { message: "a".repeat(2001) },
      { novelId, message: "ok", clientRequestKey: "short" },
      { novelId, message: "ok", parentCommentId: 0 },
    ]) {
      await expect(
        createComment({ repo, actor: reader, input: { novelId, message: "ok", ...bad }, now: 1_000 })
      ).rejects.toThrow();
    }
    const page = await listVisibleComments({ repo, novelId, limit: 10 });
    expect(page.roots).toHaveLength(0); // nothing written by rejected attempts
  });

  it("happy path: root comment on a published novel is visible immediately (post-moderation V1)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const out = await createComment({ repo, actor: reader, input: { novelId, message: "Great story" }, now: 1_000 });
    expect(out.status).toBe("visible");
    const page = await listVisibleComments({ repo, novelId, limit: 10 });
    expect(page.roots.map((r) => r.id)).toEqual([out.commentId]);
    expect(page.roots[0].placeholder).toBe(false);
  });

  it("unpublished/missing novel -> NOT_FOUND", async () => {
    const repo = new InMemoryEngagementRepository();
    repo.novels.set(31, { isPublished: false, authorUserId: null });
    await expect(
      createComment({ repo, actor: reader, input: { novelId: 31, message: "x" }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    await expect(
      createComment({ repo, actor: reader, input: { novelId: 999, message: "x" }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
  });

  it("one-level reply: visible same-novel root ok; hidden parent, level-2 parent and cross-novel parent CONFLICT/NOT_FOUND", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: stranger, input: { novelId, message: "root" }, now: 1_000 });
    const reply = await createComment({
      repo, actor: reader, input: { novelId, parentCommentId: root.commentId, message: "reply" }, now: 2_000,
    });
    expect(reply.status).toBe("visible");
    // level-2 reply against the reply itself -> CONFLICT
    await expect(
      createComment({ repo, actor: reader, input: { novelId, parentCommentId: reply.commentId, message: "l2" }, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
    // cross-novel parent -> CONFLICT
    repo.novels.set(31, { isPublished: true, authorUserId: null });
    await expect(
      createComment({ repo, actor: reader, input: { novelId: 31, parentCommentId: root.commentId, message: "x" }, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
    // missing parent -> NOT_FOUND
    await expect(
      createComment({ repo, actor: reader, input: { novelId, parentCommentId: 999, message: "x" }, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));

    // after the root is hidden its replies are rejected too (parent no longer visible)
    await actOnComment({ repo, actor: admin, commentId: root.commentId, action: "moderator_hide", now: 4_000 });
    await expect(
      createComment({ repo, actor: reader, input: { novelId, parentCommentId: root.commentId, message: "late" }, now: 5_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
  });

  it("approved rate limit 5/min: five pass, the sixth blocks (roots and replies share the budget)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: reader, input: { novelId, message: "root" }, now: 1_000 });
    for (let i = 0; i < 4; i++) {
      await createComment({ repo, actor: reader, input: { novelId, parentCommentId: root.commentId, message: `r${i}` }, now: 1_000 });
    }
    try {
      await createComment({ repo, actor: reader, input: { novelId, message: "sixth" }, now: 1_000 });
      throw new Error("should have been rate limited");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
    }
    expect(repo.rateWindowCount(`comment.create:u${reader.userId}`, 0)).toBe(5);
  });

  it("author soft-delete: owner deletes own, stranger NOT_FOUND, moderation cannot restore deleted", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: reader, input: { novelId, message: "mine" }, now: 1_000 });
    await expect(
      actOnComment({ repo, actor: stranger, commentId: root.commentId, action: "author_delete", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    const deleted = await actOnComment({
      repo, actor: reader, commentId: root.commentId, action: "author_delete", now: 2_000,
    });
    expect(deleted.status).toBe("deleted");
    await expect(
      actOnComment({ repo, actor: admin, commentId: root.commentId, action: "moderator_restore", now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
    await expect(
      actOnComment({ repo, actor: admin, commentId: root.commentId, action: "moderator_hide", now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
  });

  it("moderation: hide only from visible, restore only from hidden; pending never publishable; audits append", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: reader, input: { novelId, message: "ok" }, now: 1_000 });

    await expect(
      actOnComment({ repo, actor: reader, commentId: root.commentId, action: "moderator_hide", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));

    const hidden = await actOnComment({
      repo, actor: admin, commentId: root.commentId, action: "moderator_hide", reasonCode: "spam", now: 2_000,
    });
    expect(hidden.status).toBe("hidden");
    const audits = await repo.comments.listModerationAudit(root.commentId);
    expect(audits).toEqual([expect.objectContaining({ fromStatus: "visible", toStatus: "hidden", actorUserId: 1 })]);

    const restored = await actOnComment({
      repo, actor: admin, commentId: root.commentId, action: "moderator_restore", now: 3_000,
    });
    expect(restored.status).toBe("visible");
    expect((await repo.comments.listModerationAudit(root.commentId)).length).toBe(2);

    // pending -> hide/restore both CONFLICT (never publishable); seeded raw pending row
    const pendingId = repo.addRawComment({
      novelId,
      parentCommentId: null,
      authorUserId: reader.userId,
      message: "unapproved",
      status: "pending",
      clientRequestKey: null,
    });
    await expect(
      actOnComment({ repo, actor: admin, commentId: pendingId, action: "moderator_hide", now: 4_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
    await expect(
      actOnComment({ repo, actor: admin, commentId: pendingId, action: "moderator_restore", now: 4_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
  });

  it("visibility projection through the service: placeholder stays privacy-safe (V2-style contract)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedPublishedNovel(repo);
    const root = await createComment({ repo, actor: reader, input: { novelId, message: "root" }, now: 1_000 });
    await createComment({
      repo, actor: stranger, input: { novelId, parentCommentId: root.commentId, message: "kept" }, now: 2_000,
    });
    await actOnComment({ repo, actor: admin, commentId: root.commentId, action: "moderator_hide", now: 3_000 });

    const page = await listVisibleComments({ repo, novelId, limit: 10 });
    const placeholder = page.roots.find((r) => r.id === root.commentId)!;
    expect(placeholder.placeholder).toBe(true);
    expect(JSON.stringify(placeholder)).not.toContain("root"); // hidden content never leaks
    expect(JSON.stringify(placeholder)).not.toContain(String(reader.userId)); // no author info
    // the surviving visible reply still renders under the placeholder
    expect(page.repliesByRootId[root.commentId].length).toBe(1);
    expect(page.repliesByRootId[root.commentId][0].message).toBe("kept");
  });
});
