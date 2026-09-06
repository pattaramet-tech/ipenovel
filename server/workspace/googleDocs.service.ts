import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  workspaceAuditEvents,
  workspaceDocumentBindings,
  workspaceDocuments,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceGoogleConsentAttempts,
  workspaceMembers,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  buildDocsAuthorizationUrl,
  createDocsConsentAttempt,
  hasRequiredDocsScopes,
  observeDocsSnapshot,
  revokeDocsConnection,
  rotateRefreshCredential,
  verifyConsentState,
  type StoredGoogleCredential,
  type WorkspaceDocsAdapter,
  type WorkspaceTokenCipher,
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
      | "BINDING_NOT_FOUND"
      | "CONSENT_ATTEMPT_INVALID"
      | "CONNECTION_VERSION_CONFLICT",
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

function affectedRows(result: any): number {
  return Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0);
}

function isDuplicateEntry(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    if (
      ("code" in current &&
        (current as { code?: string }).code === "ER_DUP_ENTRY") ||
      ("errno" in current && (current as { errno?: number }).errno === 1062)
    ) {
      return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  return false;
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

export async function createGoogleConsentAttempt(input: {
  userId: number;
  authorizationEndpoint: string;
  clientId: string;
  fixedRedirectUri: string;
  cipher: WorkspaceTokenCipher;
  now?: Date;
  ttlMs?: number;
}) {
  const db = await database();
  const attempt = createDocsConsentAttempt();
  const encryptedVerifier = input.cipher.encrypt(attempt.verifier);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 10 * 60_000));
  await db.insert(workspaceGoogleConsentAttempts).values({
    userId: input.userId,
    stateHash: attempt.stateHash,
    encryptedCodeVerifier: encryptedVerifier.encryptedRefreshToken,
    keyVersion: encryptedVerifier.keyVersion,
    fixedRedirectUri: input.fixedRedirectUri,
    scope: attempt.scope,
    expiresAt,
  });
  return {
    authorizationUrl: buildDocsAuthorizationUrl({
      authorizationEndpoint: input.authorizationEndpoint,
      clientId: input.clientId,
      fixedRedirectUri: input.fixedRedirectUri,
      attempt,
    }),
    expiresAt,
  };
}

export async function consumeGoogleConsentAttempt(input: {
  userId: number;
  state: string;
  cipher: WorkspaceTokenCipher;
  now?: Date;
}) {
  const db = await database();
  const stateHash = createHash("sha256").update(input.state).digest("hex");
  const now = input.now ?? new Date();
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(workspaceGoogleConsentAttempts)
      .where(
        and(
          eq(workspaceGoogleConsentAttempts.userId, input.userId),
          eq(workspaceGoogleConsentAttempts.stateHash, stateHash),
          isNull(workspaceGoogleConsentAttempts.consumedAt),
          gt(workspaceGoogleConsentAttempts.expiresAt, now)
        )
      )
      .limit(1);
    const attempt = rows[0];
    if (!attempt || !verifyConsentState(attempt.stateHash, input.state)) {
      throw new WorkspaceDocsServiceError(
        "CONSENT_ATTEMPT_INVALID",
        "The Google consent attempt is invalid, expired, or already consumed."
      );
    }
    const updateResult = await tx
      .update(workspaceGoogleConsentAttempts)
      .set({ consumedAt: now })
      .where(
        and(
          eq(workspaceGoogleConsentAttempts.id, attempt.id),
          isNull(workspaceGoogleConsentAttempts.consumedAt),
          gt(workspaceGoogleConsentAttempts.expiresAt, now)
        )
      );
    if (affectedRows(updateResult) !== 1) {
      throw new WorkspaceDocsServiceError(
        "CONSENT_ATTEMPT_INVALID",
        "The Google consent attempt is invalid, expired, or already consumed."
      );
    }
    return {
      codeVerifier: input.cipher.decrypt({
        encryptedRefreshToken: attempt.encryptedCodeVerifier,
        keyVersion: attempt.keyVersion,
      }),
      fixedRedirectUri: attempt.fixedRedirectUri,
      scope: attempt.scope,
    };
  });
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

export async function rotateGoogleConnectionCredential(input: {
  actorUserId: number;
  connectionId: number;
  expectedVersion: number;
  returnedRefreshToken?: string | null;
  cipher: WorkspaceTokenCipher;
}) {
  const db = await database();
  const connection = await requireOwnedConnection(
    db,
    input.connectionId,
    input.actorUserId
  );
  if (!connection.encryptedRefreshToken) {
    throw new WorkspaceDocsServiceError(
      "CONNECTION_NOT_FOUND",
      "The Google connection has no active refresh credential."
    );
  }
  const credential = rotateRefreshCredential({
    current: {
      encryptedRefreshToken: connection.encryptedRefreshToken,
      keyVersion: connection.keyVersion,
    },
    returnedRefreshToken: input.returnedRefreshToken,
    cipher: input.cipher,
  });
  const result = await db
    .update(workspaceGoogleConnections)
    .set({
      encryptedRefreshToken: credential.encryptedRefreshToken,
      keyVersion: credential.keyVersion,
      version: input.expectedVersion + 1,
    })
    .where(
      and(
        eq(workspaceGoogleConnections.id, input.connectionId),
        eq(workspaceGoogleConnections.userId, input.actorUserId),
        eq(workspaceGoogleConnections.version, input.expectedVersion),
        eq(workspaceGoogleConnections.status, "active")
      )
    );
  if (affectedRows(result) !== 1) {
    throw new WorkspaceDocsServiceError(
      "CONNECTION_VERSION_CONFLICT",
      "The Google connection changed while rotating its credential."
    );
  }
  return { credential, version: input.expectedVersion + 1 };
}

export async function revokeGoogleConnection(input: {
  actorUserId: number;
  workspaceId: number;
  connectionId: number;
  correlationId: string;
  cipher: WorkspaceTokenCipher;
  adapter: WorkspaceDocsAdapter;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const connection = await requireOwnedConnection(
    db,
    input.connectionId,
    input.actorUserId
  );
  if (!connection.encryptedRefreshToken) {
    throw new WorkspaceDocsServiceError(
      "CONNECTION_NOT_FOUND",
      "The Google connection has no refresh credential."
    );
  }
  const revoked = await revokeDocsConnection({
    credential: {
      encryptedRefreshToken: connection.encryptedRefreshToken,
      keyVersion: connection.keyVersion,
    },
    cipher: input.cipher,
    adapter: input.adapter,
  });
  return db.transaction(async (tx: any) => {
    const updateResult = await tx
      .update(workspaceGoogleConnections)
      .set({
        status: revoked.status,
        encryptedRefreshToken: revoked.encryptedRefreshToken,
        revokedAt: revoked.revokedAt,
        version: connection.version + 1,
      })
      .where(
        and(
          eq(workspaceGoogleConnections.id, connection.id),
          eq(workspaceGoogleConnections.userId, input.actorUserId),
          eq(workspaceGoogleConnections.version, connection.version)
        )
      );
    if (affectedRows(updateResult) !== 1) {
      throw new WorkspaceDocsServiceError(
        "CONNECTION_VERSION_CONFLICT",
        "The Google connection changed while it was being revoked."
      );
    }
    await tx.insert(workspaceAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "workspace.docs.connection_revoked",
      entityType: "workspaceGoogleConnection",
      entityId: String(connection.id),
      correlationId: input.correlationId,
      metadataJson: JSON.stringify({
        providerRevocationSucceeded: revoked.providerRevocationSucceeded,
      }),
    });
    return {
      status: revoked.status,
      providerRevocationSucceeded: revoked.providerRevocationSucceeded,
    };
  });
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
    let documentId = existingDocuments[0]?.id;
    if (!documentId) {
      await tx
        .insert(workspaceDocuments)
        .values({
          connectionId: input.connectionId,
          providerFileId: input.providerFileId,
          mimeType: input.mimeType,
          titleCache: input.title,
          status: "active",
        })
        .onDuplicateKeyUpdate({
          set: {
            mimeType: input.mimeType,
            titleCache: input.title,
            status: "active",
          },
        });
      const persistedDocuments = await tx
        .select()
        .from(workspaceDocuments)
        .where(
          and(
            eq(workspaceDocuments.connectionId, input.connectionId),
            eq(workspaceDocuments.providerFileId, input.providerFileId)
          )
        )
        .limit(1);
      documentId = persistedDocuments[0]?.id;
      if (!documentId) {
        throw new WorkspaceDocsServiceError(
          "DATABASE_UNAVAILABLE",
          "Workspace document was not persisted."
        );
      }
    }
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
    let bindingId = existingBindings[0]?.id;
    let bindingCreated = false;
    if (!bindingId) {
      try {
        bindingId = insertId(
          await tx.insert(workspaceDocumentBindings).values({
            workspaceNovelId: input.workspaceNovelId,
            documentId,
            role: input.role,
            sequence: input.sequence,
            status: "active",
          })
        );
        bindingCreated = true;
      } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        const persistedBindings = await tx
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
        bindingId = persistedBindings[0]?.id;
        if (!bindingId) throw error;
      }
    }
    if (bindingCreated) {
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
    return { documentId, bindingId, created: bindingCreated };
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
    let snapshotId = existing[0]?.id;
    let created = false;
    if (!snapshotId) {
      const insertResult = await tx
        .insert(workspaceDocumentSnapshots)
        .values({
          documentId: row.document.id,
          providerRevisionId: fingerprint.revision,
          normalizedSha256: fingerprint.contentHash,
          normalizationVersion: fingerprint.normalizationVersion,
          byteLength: fingerprint.byteLength,
        })
        .onDuplicateKeyUpdate({
          set: {
            id: sql`LAST_INSERT_ID(${workspaceDocumentSnapshots.id})`,
          },
        });
      snapshotId = insertId(insertResult);
      created = affectedRows(insertResult) === 1;
    }
    await tx
      .update(workspaceDocuments)
      .set({
        mimeType: fingerprint.mimeType,
        titleCache: fingerprint.title,
        lastObservedAt: new Date(),
        version: sql`${workspaceDocuments.version} + 1`,
      })
      .where(eq(workspaceDocuments.id, row.document.id));
    await tx
      .update(workspaceGoogleConnections)
      .set({
        lastUsedAt: new Date(),
        version: sql`${workspaceGoogleConnections.version} + 1`,
      })
      .where(eq(workspaceGoogleConnections.id, row.connection.id));
    await tx.insert(workspaceAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: created
        ? "workspace.docs.snapshot_created"
        : "workspace.docs.snapshot_reused",
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
    return { snapshotId, created, fingerprint };
  });
}
