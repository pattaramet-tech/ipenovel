import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { NOTIFICATION_KINDS } from "@shared/notificationKindCatalog";
import { decodeInboxCursor, encodeInboxCursor, type InboxCategoryFilter } from "./inboxCursor";
import { executeInboxBulkOperation, type InboxBulkStore } from "./bulkOperations";
import type { NotificationKind } from "./contract";

/**
 * Not mounted in appRouter before a qualified migration and session gate.
 * The adapter MUST not return private chapter text, slip URLs or account data.
 * Every query/mutation is scoped by ctx.user.id, never by an input user ID.
 */
export interface InboxView {
  id: string;
  category: "finance" | "novel" | "engagement";
  title: string;
  summary: string;
  receivedSequence: bigint;
  createdAt: Date;
  readAt: Date | null;
}
export interface InboxQuery {
  actorUserId: number;
  category: InboxCategoryFilter;
  unreadOnly: boolean;
  beforeSequence: bigint | null;
  limit: number;
}
export interface NotificationApiStore {
  listOwnInbox(input: InboxQuery): Promise<InboxView[]>;
  countOwnUnread(actorUserId: number): Promise<number>;
  /** Unknown and non-owned IDs both return false with no existence leak. */
  markOwnRead(actorUserId: number, notificationId: string): Promise<boolean>;
  getOwnPreferences(actorUserId: number): Promise<Partial<Record<NotificationKind, boolean>>>;
  setOwnPreference(actorUserId: number, kind: NotificationKind, enabled: boolean): Promise<void>;
  bulk: InboxBulkStore;
}

export type NotificationRouterDependencies = {
  store: NotificationApiStore;
  /** An application secret derived with domain separation; >=32 random bytes.
   *  May be supplied as a provider, which is resolved on first cursor use -
   *  letting a misconfigured deployment fail closed per call (the mount gate
   *  also validates) instead of failing the whole application at startup. */
  cursorSigningKey: Buffer | (() => Buffer);
  now?: () => Date;
  /** Runs first in EVERY procedure (after session auth), before cursor
   *  validation and any store access. The mount passes a
   *  NOTIFICATIONS_ENABLED check here so a disabled deployment fails
   *  closed with no notification database access and no key material
   *  use. When omitted, procedures run ungated (existing callers/tests). */
  gate?: () => void;
};

export const NOTIFICATION_CATEGORY = z.enum(["all","finance","novel","engagement"]);
const operationKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
const notificationIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const kindSchema = z.enum(NOTIFICATION_KINDS);
const PAGE_MAX = 50;

function assertCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid notification count");
  return count;
}

/**
 * Reject storage violations instead of trusting a faulty adapter to return
 * another actor's data or extra pages. Do not serialize DB identifiers other
 * than the self-scoped inbox row ID.
 */
function normalizeItems(items: InboxView[], before: bigint | null, limit: number) {
  if (items.length > limit) throw new Error("Notification page over limit");
  for (const item of items) {
    if (!/^[1-9][0-9]{0,18}$/.test(item.id) ||
      !["finance","novel","engagement"].includes(item.category) ||
      item.receivedSequence <= BigInt(0) ||
      (before !== null && item.receivedSequence >= before) ||
      typeof item.title !== "string" || typeof item.summary !== "string" ||
      item.title.length > 160 || item.summary.length > 240) {
      throw new Error("Invalid notification adapter response");
    }
  }
  for (let i = 1; i < items.length; i++) {
    if (items[i-1].receivedSequence <= items[i].receivedSequence) {
      throw new Error("Unstable notification page order");
    }
  }
  return items.map(({ receivedSequence: _sequence, ...rest }) => rest);
}

/**
 * Compose into server/routers.ts only after main schema and PAT-5 admission.
 * This router deliberately has no public procedure.
 */
export function createNotificationsRouter({store,cursorSigningKey,now=()=>new Date(),gate}: NotificationRouterDependencies) {
  const resolveCursorSigningKey = (): Buffer => {
    const key = typeof cursorSigningKey === "function" ? cursorSigningKey() : cursorSigningKey;
    if (!Buffer.isBuffer(key) || key.length < 32) {
      throw new Error("Notification cursor signing key not configured");
    }
    return key;
  };
  if (typeof cursorSigningKey !== "function" &&
    (!Buffer.isBuffer(cursorSigningKey) || cursorSigningKey.length < 32)) {
    // Static keys fail loudly at construction; providers are validated on
    // first use so a missing/invalid key fails closed per call without
    // taking down the whole application at startup.
    throw new Error("Notification cursor signing key not configured");
  }
  return router({
    list: protectedProcedure
      .input(z.object({
        category: NOTIFICATION_CATEGORY.default("all"),
        unreadOnly: z.boolean().default(false),
        cursor: z.string().max(450).optional(),
        limit: z.number().int().min(1).max(PAGE_MAX).default(20),
      }).default({category:"all",unreadOnly:false,limit:20}))
      .query(async ({ctx,input}) => {
        gate?.();
        const actorUserId = ctx.user.id;
        let cursor: ReturnType<typeof decodeInboxCursor> | null = null;
        if (input.cursor) {
          try {
            cursor = decodeInboxCursor(input.cursor,actorUserId,input.category,input.unreadOnly,resolveCursorSigningKey(),now());
          } catch {
            throw new TRPCError({code:"BAD_REQUEST",message:"Invalid or expired notification cursor"});
          }
        }
        const items = await store.listOwnInbox({
          actorUserId,category:input.category,unreadOnly:input.unreadOnly,
          beforeSequence:cursor?.beforeSequence ?? null,limit:input.limit,
        });
        const last = items[items.length-1];
        const nextCursor = items.length === input.limit && last
          ? encodeInboxCursor({
              actorUserId,category:input.category,unreadOnly:input.unreadOnly,beforeSequence:last.receivedSequence,
            },resolveCursorSigningKey(),now())
          : null;
        return { items:normalizeItems(items,cursor?.beforeSequence ?? null,input.limit),nextCursor };
      }),
    unreadCount: protectedProcedure.query(async ({ctx}) => {
      gate?.();
      return {
        count:assertCount(await store.countOwnUnread(ctx.user.id)),
      };
    }),
    markRead: protectedProcedure
      .input(z.object({id:notificationIdSchema}))
      .mutation(async ({ctx,input}) => {
        gate?.();
        const owned = await store.markOwnRead(ctx.user.id,input.id);
        if (!owned) throw new TRPCError({code:"NOT_FOUND",message:"Notification not found"});
        return {success:true as const};
      }),
    markAllRead: protectedProcedure
      .input(z.object({operationKey:operationKeySchema}))
      .mutation(async ({ctx,input}) => {
        gate?.();
        const result = await executeInboxBulkOperation(
          store.bulk,ctx.user.id,input.operationKey,"mark_all_read",now()
        );
        return {...result,cutoffSequence:result.cutoffSequence.toString()};
      }),
    deleteAll: protectedProcedure
      .input(z.object({operationKey:operationKeySchema}))
      .mutation(async ({ctx,input}) => {
        gate?.();
        const result = await executeInboxBulkOperation(
          store.bulk,ctx.user.id,input.operationKey,"delete_all",now()
        );
        return {...result,cutoffSequence:result.cutoffSequence.toString()};
      }),
    preferences: protectedProcedure.query(async ({ctx}) => {
      gate?.();
      return await store.getOwnPreferences(ctx.user.id);
    }),
    setPreference: protectedProcedure
      .input(z.object({kind:kindSchema,enabled:z.boolean()}))
      .mutation(async ({ctx,input}) => {
        gate?.();
        await store.setOwnPreference(ctx.user.id,input.kind,input.enabled);
        return {success:true as const};
      }),
  });
}
