import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import {
  workspaceAuditEvents,
  workspaceDocumentBindings,
  workspaceDocuments,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceMembers,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  hasRequiredDocsScopes,
  observeDocsSnapshot,
  type StoredGoogleCredential,
  type WorkspaceDocsAdapter,
} from "./googleDocs.domain";

export class WorkspaceDocsServiceError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "CONNECTION_NOT_FOUND"
      | "CONNECTION_OWNERSHIP_REQUIRED"
      | "DOCS_SCOPE_REQUIRED"
      | "WORKSPACE_NOVEL_NOT_FOUND"
      | "BINDING_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceDocsServiceError";
  }
}

async function database(): Promise<any> {
  const db = await getDb();
  if (!db)
    throw new WorkspaceDocsServiceError(
      "DATABASE_UNAVAILABLE",
      "Workspace Docs is temporarily unavailable."
    );
  return db;
}

function insertId(result: any): number {
  const value = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkspaceDocsServiceError(
      "DATABASE_UNAVAILABLE",
      "Workspace Docs record was not persisted."
    );
  }
  return value;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, "active")
      )
    )
    .limit(1);
  if (!rows[0])
    throw new WorkspaceDocsServiceError(
      "MEMBERSHIP_REQUIRED",
      "Active workspace membership is required."
    );
  return rows[0];
}

async function requireOwnedConnection(
  db: any,
  connectionId: number,
  userId: number
) {
  const rows = await db
    .select()
    .from(workspaceGoogleConnections)
    .where(
      and(
        eq(workspaceGoogleConnections.id, connectionId),
        eq(workspaceGoogleConnections.userId, userId)
      )
    )
    .limit(1);
  if (!rows[0])
    throw new WorkspaceDocsServiceError(
      "CONNECTION_OWNERSHIP_REQUIRED",
      "The Google connection is not owned by this member."
    );
  return rows[0];
}

export async function saveGoogleConnection(input: {
  userId: number;
  providerSubject: string;
  credential: StoredGoogleCredential;
  grantedScopes: string;
  tokenExpiresAt?: Date | null;
}) {
  const db = await database();
  if (!hasRequiredDocsScopes(input.grantedScopes)) {
    throw new WorkspaceDocsServiceError(
      "DOCS_SCOPE_REQUIRED",
      "The incremental Google authorization is missing required read-only scopes."
    );
  }
  const existing = await db
    .select()
    .from(workspaceGoogleConnections)
    .where(
      and(
        eq(workspaceGoogleConnections.userId, input.userId),
        eq(workspaceGoogleConnections.providerSubject, input.providerSubject)
      )
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(workspaceGoogleConnections)
      .set({
        encryptedRefreshToken: input.credential.encryptedRefreshToken,
        keyVersion: input.credential.keyVersion,
        grantedScopes: input.grantedScopes,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        status: "active",
        revokedAt: null,
        version: existing[0].version + 1,
      })
      .where(eq(workspaceGoogleConnections.id, existing[0].id));
    return { connectionId: existing[0].id, created: false };
  }
  const connectionId = insertId(
    await db.insert(workspaceGoogleConnections).values({
      userId: input.userId,
      providerSubject: input.providerSubject,
      encryptedRefreshToken: input.credential.encryptedRefreshToken,
      keyVersion: input.credential.keyVersion,
      grantedScopes: input.grantedScopes,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      status: "active",
    })
  );
  return { connectionId, created: true };
}

export async function bindGoogleDocument(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  connectionId: number;
  providerFileId: string;
  mimeType: string;
  title: string;
  role: "source" | "chapter" | "glossary" | "reference";
  sequence: number;
  correlationId: string;
}) {
  const db = await database();
  const membership = await requireMembership(
    db,
    input.workspaceId,
    input.actorUserId
  );
  if (membership.role !== "owner" && membership.role !== "editor") {
    throw new WorkspaceDocsServiceError(
      "EDITOR_ROLE_REQUIRED",
      "Only workspace owners and editors can bind documents."
    );
  }
  await requireOwnedConnection(db, input.connectionId, input.actorUserId);
  const novelRows = await db
    .select()
    .from(workspaceNovels)
    .where(
      and(
        eq(workspaceNovels.id, input.workspaceNovelId),
        eq(workspaceNovels.workspaceId, input.workspaceId),
        eq(workspaceNovels.status, "active")
      )
    )
    .limit(1);
  if (!novelRows[0])
    throw new WorkspaceDocsServiceError(
      "WORKSPACE_NOVEL_NOT_FOUND",
      "Workspace novel binding not found."
    );

  return db.transaction(async (tx: any) => {
    const existingDocuments = await tx
      .select()
      .from(workspaceDocuments)
      .where(
        and(
          eq(workspaceDocuments.connectionId, input.connectionId),
          eq(workspaceDocuments.providerFileId, input.providerFileId)
        )
      )
      .limit(1);
    const documentId =
      existingDocuments[0]?.id ??
      insertId(
        await tx.insert(workspaceDocuments).values({
          connectionId: input.connectionId,
          providerFileId: input.providerFileId,
          mimeType: input.mimeType,
          titleCache: input.title,
          status: "active",
        })
      );
    const existingBindings = await tx
      .select()
      .from(workspaceDocumentBindings)
      .where(
        and(
          eq(
            workspaceDocumentBindings.workspaceNovelId,
            input.workspaceNovelId
          ),
          eq(workspaceDocumentBindings.documentId, documentId),
          eq(workspaceDocumentBindings.role, input.role)
        )
      )
      .limit(1);
    const bindingId =
      existingBindings[0]?.id ??
      insertId(
        await tx.insert(workspaceDocumentBindings).values({
          workspaceNovelId: input.workspaceNovelId,
          documentId,
          role: input.role,
          sequence: input.sequence,
          status: "active",
        })
      );
    if (!existingBindings[0]) {
      await tx.insert(workspaceAuditEvents).values({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "workspace.docs.bound",
        entityType: "workspaceDocumentBinding",
        entityId: String(bindingId),
        correlationId: input.correlationId,
        metadataJson: JSON.stringify({
          documentId,
          providerFileIdSha256: createHash("sha256")
            .update(input.providerFileId)
            .digest("hex"),
          role: input.role,
        }),
      });
    }
    return { documentId, bindingId, created: !existingBindings[0] };
  });
}

export async function observeBoundGoogleDocument(input: {
  actorUserId: number;
  workspaceId: number;
  bindingId: number;
  accessToken: string;
  correlationId: string;
  adapter: WorkspaceDocsAdapter;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const rows = await db
    .select({
      binding: workspaceDocumentBindings,
      document: workspaceDocuments,
      connection: workspaceGoogleConnections,
      novel: workspaceNovels,
    })
    .from(workspaceDocumentBindings)
    .innerJoin(
      workspaceDocuments,
      eq(workspaceDocumentBindings.documentId, workspaceDocuments.id)
    )
    .innerJoin(
      workspaceGoogleConnections,
      eq(workspaceDocuments.connectionId, workspaceGoogleConnections.id)
    )
    .innerJoin(
      workspaceNovels,
      eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id)
    )
    .where(
      and(
        eq(workspaceDocumentBindings.id, input.bindingId),
        eq(workspaceDocumentBindings.status, "active"),
        eq(workspaceNovels.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row)
    throw new WorkspaceDocsServiceError(
      "BINDING_NOT_FOUND",
      "Active document binding not found."
    );
  if (row.connection.userId !== input.actorUserId) {
    throw new WorkspaceDocsServiceError(
      "CONNECTION_OWNERSHIP_REQUIRED",
      "The bound Google connection is not owned by this member."
    );
  }

  const fingerprint = await observeDocsSnapshot(
    {
      connectionStatus: row.connection.status,
      connectionOwnerUserId: row.connection.userId,
      actorUserId: input.actorUserId,
      providerFileId: row.document.providerFileId,
      accessToken: input.accessToken,
    },
    input.adapter
  );

  return db.transaction(async (tx: any) => {
    const existing = await tx
      .select()
      .from(workspaceDocumentSnapshots)
      .where(
        and(
          eq(workspaceDocumentSnapshots.documentId, row.document.id),
          or(
            eq(
              workspaceDocumentSnapshots.providerRevisionId,
              fingerprint.revision
            ),
            and(
              eq(
                workspaceDocumentSnapshots.normalizedSha256,
                fingerprint.contentHash
              ),
              eq(
                workspaceDocumentSnapshots.normalizationVersion,
                fingerprint.normalizationVersion
              )
            )
          )
        )
      )
      .limit(1);
    const snapshotId =
      existing[0]?.id ??
      insertId(
        await tx.insert(workspaceDocumentSnapshots).values({
          documentId: row.document.id,
          providerRevisionId: fingerprint.revision,
          normalizedSha256: fingerprint.contentHash,
          normalizationVersion: fingerprint.normalizationVersion,
          byteLength: fingerprint.byteLength,
        })
      );
    await tx
      .update(workspaceDocuments)
      .set({
        mimeType: fingerprint.mimeType,
        titleCache: fingerprint.title,
        lastObservedAt: new Date(),
        version: row.document.version + 1,
      })
      .where(eq(workspaceDocuments.id, row.document.id));
    await tx
      .update(workspaceGoogleConnections)
      .set({
        lastUsedAt: new Date(),
        version: row.connection.version + 1,
      })
      .where(eq(workspaceGoogleConnections.id, row.connection.id));
    await tx.insert(workspaceAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: existing[0]
        ? "workspace.docs.snapshot_reused"
        : "workspace.docs.snapshot_created",
      entityType: "workspaceDocumentSnapshot",
      entityId: String(snapshotId),
      correlationId: input.correlationId,
      metadataJson: JSON.stringify({
        documentId: row.document.id,
        revision: fingerprint.revision,
        normalizedSha256: fingerprint.contentHash,
        normalizationVersion: fingerprint.normalizationVersion,
      }),
    });
    return { snapshotId, created: !existing[0], fingerprint };
  });
}
