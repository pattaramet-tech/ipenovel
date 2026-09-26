import { desc, eq } from "drizzle-orm";

import { workspaceGoogleConnections } from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import { hasRequiredNqaReadScopes } from "./googleDocs.domain";
import {
  workspaceGoogleDocsOAuthClientCredentials,
  workspaceGoogleDocsTokenCipher,
} from "./googleDocs.runtime";
import { rotateGoogleConnectionCredential } from "./googleDocs.service";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_TIMEOUT_MS = 15_000;

export class WorkspaceGoogleNqaReadError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "CONNECTION_NOT_FOUND"
      | "CONNECTION_RECONNECT_REQUIRED"
      | "RUNTIME_CONFIG_INVALID"
      | "GOOGLE_TOKEN_REFRESH_FAILED"
      | "GOOGLE_TOKEN_RESPONSE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceGoogleNqaReadError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceGoogleNqaReadError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}

async function requireOwnedNqaReadConnection(input: {
  actorUserId: number;
  connectionId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const [connection] = await db
    .select()
    .from(workspaceGoogleConnections)
    .where(eq(workspaceGoogleConnections.id, input.connectionId))
    .limit(1);

  if (!connection || connection.userId !== input.actorUserId) {
    throw new WorkspaceGoogleNqaReadError(
      "CONNECTION_NOT_FOUND",
      "Google read connection was not found."
    );
  }
  if (
    connection.status !== "active" ||
    !connection.encryptedRefreshToken ||
    !hasRequiredNqaReadScopes(connection.grantedScopes)
  ) {
    throw new WorkspaceGoogleNqaReadError(
      "CONNECTION_RECONNECT_REQUIRED",
      "Google connection must be reconnected with NQA read-only Sheets and Docs scopes."
    );
  }

  return connection;
}

async function refreshAccessToken(input: {
  refreshToken: string;
  fetchImpl: typeof fetch;
}) {
  let config: ReturnType<typeof workspaceGoogleDocsOAuthClientCredentials>;
  try {
    config = workspaceGoogleDocsOAuthClientCredentials();
  } catch {
    throw new WorkspaceGoogleNqaReadError(
      "RUNTIME_CONFIG_INVALID",
      "Google OAuth runtime configuration is incomplete."
    );
  }

  let response: Response;
  try {
    response = await input.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new WorkspaceGoogleNqaReadError(
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Google OAuth token refresh failed before a response was received."
    );
  }

  if (!response.ok) {
    await response.text().catch(() => "");
    throw new WorkspaceGoogleNqaReadError(
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Google OAuth token refresh failed."
    );
  }

  let token: any;
  try {
    token = await response.json();
  } catch {
    throw new WorkspaceGoogleNqaReadError(
      "GOOGLE_TOKEN_RESPONSE_INVALID",
      "Google OAuth token refresh returned invalid JSON."
    );
  }

  const accessToken =
    typeof token?.access_token === "string" ? token.access_token.trim() : "";
  const returnedRefreshToken =
    typeof token?.refresh_token === "string" ? token.refresh_token.trim() : "";
  if (!accessToken) {
    throw new WorkspaceGoogleNqaReadError(
      "GOOGLE_TOKEN_RESPONSE_INVALID",
      "Google OAuth token refresh did not return an access token."
    );
  }

  return { accessToken, returnedRefreshToken };
}

export async function listWorkspaceGoogleNqaReadConnections(
  actorUserId: number
) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const rows = await db
    .select({
      id: workspaceGoogleConnections.id,
      status: workspaceGoogleConnections.status,
      grantedScopes: workspaceGoogleConnections.grantedScopes,
      updatedAt: workspaceGoogleConnections.updatedAt,
    })
    .from(workspaceGoogleConnections)
    .where(eq(workspaceGoogleConnections.userId, actorUserId))
    .orderBy(desc(workspaceGoogleConnections.updatedAt));

  return rows.map((row: any) => ({
    id: row.id,
    status: row.status,
    nqaReadScopeReady: hasRequiredNqaReadScopes(row.grantedScopes),
    updatedAt: row.updatedAt,
  }));
}

export async function preferredWorkspaceGoogleNqaReadConnection(
  actorUserId: number
) {
  const connections = await listWorkspaceGoogleNqaReadConnections(actorUserId);
  return (
    connections.find(
      connection =>
        connection.status === "active" && connection.nqaReadScopeReady
    ) ?? null
  );
}

export async function refreshWorkspaceGoogleNqaReadAccessToken(input: {
  actorUserId: number;
  connectionId: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const connection = await requireOwnedNqaReadConnection(input);

  let cipher: ReturnType<typeof workspaceGoogleDocsTokenCipher>;
  try {
    cipher = workspaceGoogleDocsTokenCipher();
  } catch {
    throw new WorkspaceGoogleNqaReadError(
      "RUNTIME_CONFIG_INVALID",
      "Workspace Google credential encryption is not configured."
    );
  }

  let refreshToken: string;
  try {
    refreshToken = cipher.decrypt({
      encryptedRefreshToken: connection.encryptedRefreshToken!,
      keyVersion: connection.keyVersion,
    });
  } catch {
    throw new WorkspaceGoogleNqaReadError(
      "CONNECTION_RECONNECT_REQUIRED",
      "Google refresh credential could not be decrypted."
    );
  }

  const refreshed = await refreshAccessToken({
    refreshToken,
    fetchImpl: input.fetchImpl ?? fetch,
  });

  if (refreshed.returnedRefreshToken) {
    await rotateGoogleConnectionCredential({
      actorUserId: input.actorUserId,
      connectionId: input.connectionId,
      expectedVersion: connection.version,
      returnedRefreshToken: refreshed.returnedRefreshToken,
      cipher,
    });
  }

  return refreshed.accessToken;
}

export async function refreshPreferredWorkspaceGoogleNqaReadAccessToken(input: {
  actorUserId: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const connection = await preferredWorkspaceGoogleNqaReadConnection(
    input.actorUserId
  );
  if (!connection) {
    throw new WorkspaceGoogleNqaReadError(
      "CONNECTION_RECONNECT_REQUIRED",
      "No active Google connection has the NQA read-only Sheets and Docs scopes."
    );
  }

  return await refreshWorkspaceGoogleNqaReadAccessToken({
    actorUserId: input.actorUserId,
    connectionId: connection.id,
    fetchImpl: input.fetchImpl,
  });
}
