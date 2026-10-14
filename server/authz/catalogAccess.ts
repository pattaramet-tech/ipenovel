import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { episodes, novels, users } from "../../drizzle/schema";
import * as db from "../db";

export const ACCOUNT_ROLES = ["user", "author", "admin"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export class CatalogAccessError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "CatalogAccessError";
  }
}

export function decideCatalogNovelAccess(
  actor: { id: number; role: string } | null | undefined,
  novel: { authorUserId: number | null } | null | undefined
): "allow" | "forbidden" | "not_found" {
  if (!actor || (actor.role !== "admin" && actor.role !== "author")) return "forbidden";
  if (actor.role === "admin") return "allow";
  if (!novel || novel.authorUserId !== actor.id) return "not_found";
  return "allow";
}

export function rethrowCatalogAccess(error: unknown): never {
  if (error instanceof CatalogAccessError) {
    throw new TRPCError({ code: error.code, message: error.message });
  }
  throw error;
}

async function requireDatabase() {
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");
  return database;
}

async function readActor(actorUserId: number) {
  const database = await requireDatabase();
  const [actor] = await database
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  return actor ?? null;
}

async function readNovelOwner(novelId: number) {
  const database = await requireDatabase();
  const [novel] = await database
    .select({ id: novels.id, authorUserId: novels.authorUserId })
    .from(novels)
    .where(eq(novels.id, novelId))
    .limit(1);
  return novel ?? null;
}

function assertDecision(
  actor: { id: number; role: string } | null,
  novel: { authorUserId: number | null } | null
) {
  const decision = decideCatalogNovelAccess(actor, novel);
  if (decision === "forbidden") {
    throw new CatalogAccessError("FORBIDDEN", "Catalog access is no longer valid");
  }
  if (decision === "not_found") {
    throw new CatalogAccessError("NOT_FOUND", "Novel not found");
  }
}

/** Current-role read for catalog queries. Writes use the locking helper. */
export async function assertCatalogNovelVisible(actorUserId: number, novelId: number) {
  const actor = await readActor(actorUserId);
  if (!actor || actor.role !== "admin") {
    const novel = await readNovelOwner(novelId);
    assertDecision(actor, novel);
    return;
  }
  assertDecision(actor, null);
}

export async function assertCatalogNovelsVisible(actorUserId: number, novelIds: number[]) {
  const uniqueIds = Array.from(new Set(novelIds));
  for (const novelId of uniqueIds) {
    await assertCatalogNovelVisible(actorUserId, novelId);
  }
}

type NovelLockRow = { id: number; authorUserId: number | null };

/**
 * Locks the actor and the novel, then runs the write on that same transaction.
 * A role downgrade or an ownership change that landed before this lock is the
 * decision that counts, not the role on the caller's session.
 */
export async function withCatalogNovelWrite<T>(
  actorUserId: number,
  novelId: number,
  fn: (tx: any, novel: NovelLockRow) => Promise<T>
): Promise<T> {
  const database = await requireDatabase();
  return database.transaction(async (tx: any) => {
    const actor = await db.lockUserRowForUpdate(actorUserId, tx);
    const [novel] = await tx
      .select({ id: novels.id, authorUserId: novels.authorUserId })
      .from(novels)
      .where(eq(novels.id, novelId))
      .limit(1)
      .for("update");
    assertDecision(actor ?? null, novel ?? null);
    return fn(tx, novel);
  });
}

export async function withCatalogEpisodeWrite<T>(
  actorUserId: number,
  episodeId: number,
  fn: (tx: any, episode: { id: number; novelId: number }) => Promise<T>
): Promise<T> {
  const database = await requireDatabase();
  const [preview] = await database
    .select({ id: episodes.id, novelId: episodes.novelId })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!preview) throw new CatalogAccessError("NOT_FOUND", "Episode not found");

  return withCatalogNovelWrite(actorUserId, preview.novelId, async (tx) => {
    const [current] = await tx
      .select({ id: episodes.id, novelId: episodes.novelId })
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1)
      .for("update");
    if (!current || current.novelId !== preview.novelId) {
      throw new CatalogAccessError("NOT_FOUND", "Episode not found");
    }
    return fn(tx, current);
  });
}
