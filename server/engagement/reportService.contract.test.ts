import { describe, expect, it } from "vitest";
import { InMemoryEngagementRepository } from "./engagementRepository.mock";
import { createReport, getMyReport, listMyReports, reviewReport } from "./reportService";
import { EngagementPolicyError } from "./policies";
import { RateLimitExceededError } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS } from "./engagementRepository";

const HOUR = APPROVED_RATE_LIMITS.report.windowMs;
const reporter = { userId: 7, role: "user" as const };
const stranger = { userId: 8, role: "user" as const };
const admin = { userId: 1, role: "admin" as const };
const target = { type: "novel" as const, id: 11 };
const input = { target, reason: "spam" as const, details: "Repeated advertisements" };

async function seedNovel(repo: InMemoryEngagementRepository, id = 11) {
  repo.novels.set(id, { isPublished: true, authorUserId: null, episodeIds: [101, 102, 103] });
  for (const ep of [101, 102, 103]) repo.episodes.set(ep, true);
}

describe("reportService", () => {
  it("R2: unknown report action is rejected with NO decision written (even for admin)", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    const { reportId } = await createReport({ repo, actor: reporter, input, now: 1_000 });
    await expect(
      reviewReport({
        repo,
        actor: admin,
        reportId,
        action: "banana" as unknown as "take_review",
        now: 2_000,
      })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    const record = await getMyReport({ repo, actor: reporter, reportId });
    expect(record.status).toBe("new"); // unchanged
    expect(await repo.reports.listDecisions(reportId)).toHaveLength(0); // no audit write
  });

  it("R1: fail-closed target visibility - unpublished novel, episode of unpublished novel and hidden comment are NOT_FOUND", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo, 11); // published, episodes 101-103
    repo.novels.set(50, { isPublished: false, authorUserId: null, episodeIds: [501] }); // unpublished + episode
    repo.episodes.set(501, true);
    const hiddenCommentId = repo.addRawComment({
      novelId: 11, parentCommentId: null, authorUserId: 7, message: "hidden",
      status: "hidden", clientRequestKey: null,
    });
    await expect(
      createReport({ repo, actor: reporter, input: { ...input, target: { type: "novel", id: 50 } }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    await expect(
      createReport({ repo, actor: reporter, input: { ...input, target: { type: "episode", id: 501 } }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    await expect(
      createReport({ repo, actor: reporter, input: { ...input, target: { type: "comment", id: hiddenCommentId } }, now: 1_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    // visible targets still work
    await expect(
      createReport({ repo, actor: reporter, input: { ...input, target: { type: "episode", id: 101 } }, now: 2_000 })
    ).resolves.toBeTruthy();
  });

  it("R1: runtime validation rejects unknown reason/target types and malformed ids before storage", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    for (const bad of [
      { ...input, reason: "not_interested" },
      { ...input, target: { type: "user", id: 1 } },
      { ...input, target: { type: "novel", id: 0 } },
      { ...input, target: { type: "novel", id: 1.5 } },
      { ...input, details: "" },
      { ...input, clientRequestKey: "short" },
    ]) {
      await expect(createReport({ repo, actor: reporter, input: bad, now: 1_000 })).rejects.toThrow();
    }
    await expect(getMyReport({ repo, actor: reporter, reportId: 0 })).rejects.toThrow();
    expect(await listMyReports({ repo, actor: reporter })).toHaveLength(0);
  });

  it("happy path: report an existing novel target", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    const out = await createReport({ repo, actor: reporter, input, now: 1_000 });
    expect(out.status).toBe("new");
    const mine = await listMyReports({ repo, actor: reporter });
    expect(mine).toHaveLength(1);
    expect(mine[0].targetType).toBe("novel");
  });

  it("missing target -> NOT_FOUND (no report against nonexistent content)", async () => {
    const repo = new InMemoryEngagementRepository();
    await expect(createReport({ repo, actor: reporter, input, now: 1_000 })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
  });

  it("approved rate limit 3/hour: three pass, the fourth blocks", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    repo.episodes.set(101, true);
    repo.episodes.set(102, true);
    await createReport({ repo, actor: reporter, input, now: 1_000 });
    await createReport({ repo, actor: reporter, input: { ...input, target: { type: "episode", id: 101 } }, now: 2_000 });
    await createReport({ repo, actor: reporter, input: { ...input, target: { type: "episode", id: 102 } }, now: 3_000 });
    try {
      await createReport({ repo, actor: reporter, input: { ...input, target: { type: "episode", id: 103 } }, now: 4_000 });
      throw new Error("should have been rate limited");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
    }
    // quota rolled back for the blocked attempt: exactly 3 consumed
    expect(repo.rateWindowCount(`report.create:u${reporter.userId}`, 0)).toBe(3);
  });

  it("idempotency: replay returns the same report; different payload CONFLICT", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    const key = "report_token_00000001";
    const first = await createReport({ repo, actor: reporter, input: { ...input, clientRequestKey: key }, now: 1_000 });
    const second = await createReport({ repo, actor: reporter, input: { ...input, clientRequestKey: key }, now: 2_000 });
    expect(second).toEqual(first);
    expect(await listMyReports({ repo, actor: reporter })).toHaveLength(1);
    await expect(
      createReport({ repo, actor: reporter, input: { ...input, details: "changed", clientRequestKey: key }, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
  });

  it("reporter isolation: another user's report is NOT_FOUND", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    const { reportId } = await createReport({ repo, actor: reporter, input, now: 1_000 });
    await expect(getMyReport({ repo, actor: stranger, reportId })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
  });

  it("admin moderation: take_review -> resolve writes append-only decisions; non-admin FORBIDDEN; invalid jumps CONFLICT", async () => {
    const repo = new InMemoryEngagementRepository();
    await seedNovel(repo);
    const { reportId } = await createReport({ repo, actor: reporter, input, now: 1_000 });

    await expect(
      reviewReport({ repo, actor: reporter, reportId, action: "take_review", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    await expect(
      reviewReport({ repo, actor: admin, reportId: 999, action: "take_review", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));

    const taken = await reviewReport({ repo, actor: admin, reportId, action: "take_review", now: 2_000 });
    expect(taken.status).toBe("in_review");
    await expect(
      reviewReport({ repo, actor: admin, reportId, action: "take_review", now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));

    const resolved = await reviewReport({
      repo, actor: admin, reportId, action: "resolve", reasonCode: "actioned", now: 3_000,
    });
    expect(resolved.status).toBe("resolved");

    const decisions = await repo.reports.listDecisions(reportId);
    expect(decisions.map((d) => [d.fromStatus, d.toStatus])).toEqual([
      ["new", "in_review"],
      ["in_review", "resolved"],
    ]);
    expect(decisions[1].reasonCode).toBe("actioned");

    // reopen -> in_review (dismiss path symmetric)
    const reopened = await reviewReport({ repo, actor: admin, reportId, action: "reopen", now: 4_000 });
    expect(reopened.status).toBe("in_review");
    const dismissed = await reviewReport({ repo, actor: admin, reportId, action: "dismiss", now: 5_000 });
    expect(dismissed.status).toBe("dismissed");
  });
});
