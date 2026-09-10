import { and, eq } from "drizzle-orm";
import { episodes, workspaceAuditEvents } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
  type WorkspacePublishProvider,
  type WorkspacePublishProviderRequest,
  type WorkspacePublishProviderResult,
} from "./publishExecution.domain";

export class IpeNovelWorkspacePublishProviderError extends Error {
  constructor(readonly code: "DATABASE_UNAVAILABLE" | "TARGET_INVALID" | "TARGET_NOT_FOUND", message: string) {
    super(message);
    this.name = "IpeNovelWorkspacePublishProviderError";
  }
}

function receiptFor(request: WorkspacePublishProviderRequest) {
  if (!request.episodeId) {
    throw new IpeNovelWorkspacePublishProviderError("TARGET_INVALID", "IpeNovel publish requires an episodeId.");
  }
  return `ipenovel:${request.episodeId}:${request.requestKey}`;
}

function parseReceiptMetadata(metadataJson: string): WorkspacePublishProviderResult | undefined {
  try {
    const parsed = JSON.parse(metadataJson) as { status?: string; providerReceipt?: string };
    if (parsed.status === "published" && typeof parsed.providerReceipt === "string" && parsed.providerReceipt.trim()) {
      return { status: "published", providerReceipt: parsed.providerReceipt.trim() };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Concrete adapter for the existing IpeNovel publication boundary. It only
 * makes an already-created episode reader-visible; content, price, fileUrl and
 * legacy/ZIP state remain untouched. The target mutation and durable receipt
 * audit event commit atomically so reconcile can recover a worker crash.
 */
export function createIpeNovelWorkspacePublishProvider(): WorkspacePublishProvider {
  return {
    mode: "external",
    async reconcile(request) {
      const db = await getDb();
      if (!db) throw new IpeNovelWorkspacePublishProviderError("DATABASE_UNAVAILABLE", "IpeNovel database is unavailable.");
      const [event] = await db.select().from(workspaceAuditEvents).where(and(
        eq(workspaceAuditEvents.workspaceId, request.workspaceId),
        eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
        eq(workspaceAuditEvents.correlationId, request.requestKey)
      )).limit(1);
      return event ? parseReceiptMetadata(event.metadataJson) : undefined;
    },
    async execute(request) {
      if (request.targetType !== "novel" || !request.episodeId) {
        throw new IpeNovelWorkspacePublishProviderError("TARGET_INVALID", "IpeNovel provider accepts novel destinations with an episodeId only.");
      }
      const db = await getDb();
      if (!db) throw new IpeNovelWorkspacePublishProviderError("DATABASE_UNAVAILABLE", "IpeNovel database is unavailable.");
      const providerReceipt = receiptFor(request);
      return db.transaction(async (tx: any) => {
        const [episode] = await tx.select().from(episodes).where(eq(episodes.id, request.episodeId!)).limit(1).for("update");
        if (!episode || episode.novelId !== request.targetId) {
          throw new IpeNovelWorkspacePublishProviderError("TARGET_NOT_FOUND", "Publish episode does not belong to the destination novel.");
        }
        const [existing] = await tx.select().from(workspaceAuditEvents).where(and(
          eq(workspaceAuditEvents.workspaceId, request.workspaceId),
          eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
          eq(workspaceAuditEvents.correlationId, request.requestKey)
        )).limit(1);
        if (existing) {
          const reconciled = parseReceiptMetadata(existing.metadataJson);
          if (reconciled) return reconciled;
        }
        await tx.update(episodes).set({
          isPublished: true,
          publishedAt: episode.publishedAt ?? new Date(),
        }).where(and(eq(episodes.id, episode.id), eq(episodes.novelId, request.targetId)));
        await tx.insert(workspaceAuditEvents).values({
          workspaceId: request.workspaceId,
          actorUserId: null,
          eventType: WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
          entityType: "episode",
          entityId: String(episode.id),
          correlationId: request.requestKey,
          metadataJson: JSON.stringify({
            contract: WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT,
            status: "published",
            providerReceipt,
            publishRunId: request.publishRunId,
            destinationId: request.destinationId,
            itemKey: request.itemKey,
            episodeId: episode.id,
            sourceSha256: request.sourceSha256.toLowerCase(),
          }),
        });
        return { status: "published", providerReceipt } as const;
      });
    },
  };
}
