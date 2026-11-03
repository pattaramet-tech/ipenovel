/**
 * P2R3B-A novel star rating service (PD-03/PD-06).
 *
 * Eligibility (all server-verified inside the upsert transaction):
 *  - novel published (archived/unpublished -> NOT_FOUND),
 *  - authenticated actor (type-level),
 *  - reading entitlement for at least one episode of the novel
 *    (server-verified, never a client flag),
 *  - NOT the novel's author (self-rating -> FORBIDDEN),
 *  - authorUserId = null (ownership unknown) -> FORBIDDEN, fail-closed -
 *    legacy novels stay unratable until ownership is backfilled,
 *  - suspension is NOT ENFORCED in V1 (no users.status exists): the pure
 *    policy keeps the isSuspended parameter for the future, and this
 *    service documents that it passes false today.
 *
 * One rating per user+novel: re-rating REPLACES the stars and adjusts the
 * authoritative sum/count aggregate inside the SAME transaction.
 * No points/wallet rewards exist anywhere in this flow.
 */
import {
  canRateNovel,
  ratingSummary,
  EngagementPolicyError,
  type EngagementActor,
} from "./policies";
import { runIdempotentMutation } from "./mutationPipeline";
import type {
  EngagementRepository,
  RatingAggregate,
  RatingRecord,
} from "./engagementRepository";
import { assertServerActor } from "./mutationPipeline";
import { ratingUpsertInput, positiveEntityId } from "../../shared/engagement/contracts";

export interface UpsertRatingInput {
  novelId: number;
  stars: number; // contract-validated integer 1..5
  clientRequestKey?: string;
}

export interface UpsertRatingResult {
  stars: number;
  aggregate: RatingAggregate;
}

export async function upsertRating(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  input: UpsertRatingInput;
  now: number;
}): Promise<UpsertRatingResult> {
  const { repo, actor, input, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation - stars MUST be an integer 1..5 at runtime
  const parsed = ratingUpsertInput.parse(input);
  const { result } = await runIdempotentMutation<UpsertRatingResult>({
    repo,
    actorUserId: actor.userId,
    entity: "rating",
    clientRequestKey: parsed.clientRequestKey,
    canonicalSource: parsed,
    // rating-update rate limiting is PENDING CONFIGURATION - not enforced.
    now,
    execute: async (tx) => {
      const novel = await tx.ratings.getNovelFacts(parsed.novelId);
      if (!novel || !novel.isPublished) throw new EngagementPolicyError("NOT_FOUND");

      // ownership fail-closed: unknown owner (null) never opens self-rating
      if (novel.authorUserId === null || novel.authorUserId === actor.userId) {
        throw new EngagementPolicyError("FORBIDDEN");
      }

      const canRead = await tx.ratings.userCanReadAnyEpisode(actor.userId, parsed.novelId);
      // V1 documented limitation: suspension is NOT ENFORCED (no data
      // source yet) - the pure policy keeps the parameter for the future.
      const isSuspended = false;
      if (!canRateNovel({ actor, isPublished: novel.isPublished, canRead, isSuspended })) {
        throw new EngagementPolicyError("FORBIDDEN");
      }

      const existing = await tx.ratings.getByUserAndNovel(actor.userId, parsed.novelId);
      if (existing) {
        await tx.ratings.updateStars(existing.id, parsed.stars);
        await tx.ratings.adjustAggregate(parsed.novelId, parsed.stars - existing.stars, 0);
      } else {
        await tx.ratings.insert({
          novelId: parsed.novelId,
          userId: actor.userId,
          stars: parsed.stars,
        });
        await tx.ratings.adjustAggregate(parsed.novelId, parsed.stars, 1);
      }
      const aggregate = await tx.ratings.getAggregate(parsed.novelId);
      return { stars: parsed.stars, aggregate };
    },
  });
  return result;
}

export async function getRatingSummary(deps: {
  repo: EngagementRepository;
  novelId: number;
}): Promise<{ average: number | null; count: number }> {
  const { repo, novelId } = deps;
  positiveEntityId.parse(novelId);
  return repo.withTransaction(async (tx) => {
    // R2: public aggregate only for a PUBLISHED novel - missing or
    // unpublished novels return NOT_FOUND (no aggregate leak).
    const novel = await tx.ratings.getNovelFacts(novelId);
    if (!novel || !novel.isPublished) throw new EngagementPolicyError("NOT_FOUND");
    const aggregate = await tx.ratings.getAggregate(novelId);
    // authoritative aggregate only; throws CONFLICT on inconsistent data
    return ratingSummary(aggregate.sum, aggregate.count);
  });
}

export async function getMyRating(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  novelId: number;
}): Promise<RatingRecord | null> {
  const { repo, actor, novelId } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(novelId);
  return repo.withTransaction((tx) => tx.ratings.getByUserAndNovel(actor.userId, novelId));
}
