import { describe, expect, it } from "vitest";
import { InMemoryEngagementRepository } from "./engagementRepository.mock";
import {
  submitFeedback,
  listMyFeedback,
  getMyFeedback,
  reviewFeedback,
} from "./feedbackService";
import { EngagementPolicyError } from "./policies";
import { RateLimitExceededError } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS } from "./engagementRepository";

const MINUTE = 60_000;
const WINDOW = APPROVED_RATE_LIMITS.feedback.windowMs; // 10 minutes

const reader = { userId: 7, role: "user" as const };
const other = { userId: 8, role: "user" as const };
const admin = { userId: 1, role: "admin" as const };
const input = { category: "bug" as const, subject: "Reader issue", message: "App froze" };

describe("feedbackService", () => {
  it("happy path: submit stores a new record under the actor's identity", async () => {
    const repo = new InMemoryEngagementRepository();
    const out = await submitFeedback({ repo, actor: reader, input, now: 1_000 });
    expect(out.status).toBe("new");
    const mine = await listMyFeedback({ repo, actor: reader });
    expect(mine).toHaveLength(1);
    expect(mine[0].userId).toBe(7);
    expect(mine[0].subject).toBe("Reader issue");
  });

  it("R1: invalid runtime payloads fail loudly (Zod) before any storage access or quota", async () => {
    const repo = new InMemoryEngagementRepository();
    // TypeScript cannot protect these at runtime; the P0 contract does:
    for (const bad of [
      { ...input, message: undefined as unknown as string }, // missing text
      { ...input, message: 42 as unknown as string }, // wrong type
      { ...input, subject: "x" }, // below 3-char boundary
      { ...input, message: "a".repeat(5001) }, // oversized
      { ...input, clientRequestKey: "short" }, // bad retry-token shape
      { ...input, category: "payments" }, // unknown category
    ]) {
      await expect(submitFeedback({ repo, actor: reader, input: bad, now: 1_000 })).rejects.toThrow();
    }
    expect(await listMyFeedback({ repo, actor: reader })).toHaveLength(0);
    expect(repo.rateWindowCount(`feedback.create:u${reader.userId}`, 0)).toBe(0); // no quota consumed
    // (the deeper canonicalization guard for non-JSON payloads is covered
    // by the pure idempotency tests in idempotency.test.ts)
  });

  it("idempotency: same key+payload replays the original result without a duplicate row or quota", async () => {
    const repo = new InMemoryEngagementRepository();
    const key = "retry_token_000001";
    const first = await submitFeedback({ repo, actor: reader, input: { ...input, clientRequestKey: key }, now: 1_000 });
    const second = await submitFeedback({ repo, actor: reader, input: { ...input, clientRequestKey: key }, now: 2_000 });
    expect(second).toEqual(first); // same ticket id + status => replay, not a new row
    expect(await listMyFeedback({ repo, actor: reader })).toHaveLength(1);
    expect(repo.rateWindowCount(`feedback.create:u${reader.userId}`, 0)).toBe(1); // replay did not consume quota
  });

  it("idempotency: same key + different payload -> CONFLICT", async () => {
    const repo = new InMemoryEngagementRepository();
    const key = "retry_token_000002";
    await submitFeedback({ repo, actor: reader, input: { ...input, clientRequestKey: key }, now: 1_000 });
    await expect(
      submitFeedback({ repo, actor: reader, input: { ...input, message: "different", clientRequestKey: key }, now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
  });

  it("approved rate limit 3/10min: three pass, the fourth blocks with retryAfter, quota survives the block", async () => {
    const repo = new InMemoryEngagementRepository();
    const now = 5_000;
    await submitFeedback({ repo, actor: reader, input, now });
    await submitFeedback({ repo, actor: reader, input: { ...input, subject: "second" }, now });
    await submitFeedback({ repo, actor: reader, input: { ...input, subject: "third" }, now });
    try {
      await submitFeedback({ repo, actor: reader, input: { ...input, subject: "fourth" }, now });
      throw new Error("should have been rate limited");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(repo.rateWindowCount(`feedback.create:u${reader.userId}`, 0)).toBe(3); // block rolled back
    // a different user has an independent budget; window boundary resets
    await submitFeedback({ repo, actor: other, input, now });
    await submitFeedback({ repo, actor: reader, input: { ...input, subject: "after window" }, now: now + WINDOW + 1 });
  });

  it("failed mutation does not consume quota (transaction rollback)", async () => {
    const repo = new InMemoryEngagementRepository();
    const originalInsert = repo.feedback.insert.bind(repo);
    repo.feedback.insert = async () => {
      throw new Error("storage failure");
    };
    await expect(submitFeedback({ repo, actor: reader, input, now: 1_000 })).rejects.toThrow("storage failure");
    expect(repo.rateWindowCount(`feedback.create:u${reader.userId}`, 0)).toBe(0); // rolled back
    repo.feedback.insert = originalInsert;
    const out = await submitFeedback({ repo, actor: reader, input, now: 2_000 }); // quota intact
    expect(out.status).toBe("new");
  });

  it("owner isolation: another user's feedback is NOT_FOUND, never a leak", async () => {
    const repo = new InMemoryEngagementRepository();
    const { feedbackId } = await submitFeedback({ repo, actor: reader, input, now: 1_000 });
    await expect(getMyFeedback({ repo, actor: other, feedbackId })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
    const mine = await getMyFeedback({ repo, actor: reader, feedbackId });
    expect(mine.id).toBe(feedbackId);
  });

  it("admin review: new -> acknowledged -> closed; invalid jumps CONFLICT; non-admin FORBIDDEN", async () => {
    const repo = new InMemoryEngagementRepository();
    const { feedbackId } = await submitFeedback({ repo, actor: reader, input, now: 1_000 });

    await expect(reviewFeedback({ repo, actor: reader, feedbackId, action: "acknowledge" })).rejects.toThrowError(
      new EngagementPolicyError("FORBIDDEN")
    );
    await expect(reviewFeedback({ repo, actor: admin, feedbackId: 999, action: "acknowledge" })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );

    const ack = await reviewFeedback({ repo, actor: admin, feedbackId, action: "acknowledge" });
    expect(ack.status).toBe("acknowledged");
    await expect(reviewFeedback({ repo, actor: admin, feedbackId, action: "acknowledge" })).rejects.toThrowError(
      new EngagementPolicyError("CONFLICT")
    );
    const closed = await reviewFeedback({ repo, actor: admin, feedbackId, action: "close" });
    expect(closed.status).toBe("closed");
    await expect(reviewFeedback({ repo, actor: admin, feedbackId, action: "close" })).rejects.toThrowError(
      new EngagementPolicyError("CONFLICT")
    );
  });
});
