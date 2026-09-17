import { and, eq } from "drizzle-orm";
import {
  workspaceAiJobs,
  workspaceDocuments,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  createAesGcmTokenCipher,
  GOOGLE_DOC_MIME_TYPE,
  hasRequiredDocsScopes,
  type WorkspaceDocsAdapter,
  type WorkspaceTokenCipher,
} from "./googleDocs.domain";
import {
  consumeGoogleConsentAttempt,
  createGoogleConsentAttempt,
  rotateGoogleConnectionCredential,
  saveGoogleConnection,
} from "./googleDocs.service";

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about";
const GOOGLE_DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DOCS_ENDPOINT = "https://docs.googleapis.com/v1/documents";
const PREVIEW_GOOGLE_DOCS_CALLBACK_URL =
  "https://r2-preview.ipenovel.com/api/workspace/google/callback";
const GOOGLE_DOCS_TOKEN_KEY_VERSION = 1;
const MAX_GOOGLE_RESPONSE_CHARS = 5_000_000;
const MAX_GOOGLE_DOCUMENT_RESPONSE_CHARS = 20_000_000;
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
export class WorkspaceGoogleDocsRuntimeError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_CONFIG_INVALID"
      | "CONNECTION_NOT_FOUND"
      | "DOCS_SCOPE_REQUIRED"
      | "DOCS_RECONNECT_REQUIRED"
      | "GOOGLE_TOKEN_EXCHANGE_FAILED"
      | "GOOGLE_API_FAILED"
      | "GOOGLE_RESPONSE_INVALID"
      | "AI_QC_SOURCE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceGoogleDocsRuntimeError";
  }
}

function decode32ByteKey(raw: string): Buffer {
  const value = raw.trim();
  if (!value)
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY is required."
    );
  const decoded = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32)
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes."
    );
  return decoded;
}

export function createWorkspaceGoogleDocsTokenCipher(
  rawKey: string = process.env.WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY ?? ""
): WorkspaceTokenCipher {
  return createAesGcmTokenCipher(
    new Map([[GOOGLE_DOCS_TOKEN_KEY_VERSION, decode32ByteKey(rawKey)]]),
    GOOGLE_DOCS_TOKEN_KEY_VERSION
  );
}
async function readJsonResponse(
  response: Response,
  maxResponseChars = MAX_GOOGLE_RESPONSE_CHARS
): Promise<any> {
  const text = await response.text();
  if (text.length > maxResponseChars) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google response exceeded the allowed size."
    );
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google returned an invalid JSON response."
    );
  }
}

async function checkedJsonFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  failureCode: "GOOGLE_TOKEN_EXCHANGE_FAILED" | "GOOGLE_API_FAILED",
  maxResponseChars = MAX_GOOGLE_RESPONSE_CHARS
) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WorkspaceGoogleDocsRuntimeError(
      failureCode,
      "Google request failed."
    );
  }
  const data = await readJsonResponse(response, maxResponseChars);
  if (!response.ok) {
    throw new WorkspaceGoogleDocsRuntimeError(
      failureCode,
      `Google request failed with HTTP ${response.status}.`
    );
  }
  return data;
}
export function resolveWorkspaceGoogleDocsRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
) {
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Google Docs OAuth runtime configuration is incomplete."
    );
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI is invalid."
    );
  }
  if (redirect.toString() !== PREVIEW_GOOGLE_DOCS_CALLBACK_URL) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI must be the exact Preview Workspace Google callback URL."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

async function database() {
  const db = await getDb();
  if (!db)
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Workspace database is unavailable."
    );
  return db;
}

export async function beginWorkspaceGoogleDocsConsent(actorUserId: number) {
  if (process.env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Workspace Google Docs consent is Preview-only."
    );
  }
  const db = await database();
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const config = resolveWorkspaceGoogleDocsRuntimeConfig();
  return createGoogleConsentAttempt({
    userId: actorUserId,
    authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
    clientId: config.clientId,
    fixedRedirectUri: config.redirectUri,
    cipher: createWorkspaceGoogleDocsTokenCipher(),
  });
}
export async function completeWorkspaceGoogleDocsConsent(input: {
  actorUserId: number;
  code: string;
  state: string;
  fetchImpl?: typeof fetch;
}) {
  if (process.env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Workspace Google Docs consent is Preview-only."
    );
  }
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const config = resolveWorkspaceGoogleDocsRuntimeConfig();
  const cipher = createWorkspaceGoogleDocsTokenCipher();
  const attempt = await consumeGoogleConsentAttempt({
    userId: input.actorUserId,
    state: input.state,
    cipher,
  });
  const body = new URLSearchParams({
    code: input.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: attempt.fixedRedirectUri,
    code_verifier: attempt.codeVerifier,
    grant_type: "authorization_code",
  });
  const fetcher = input.fetchImpl ?? fetch;
  const token = await checkedJsonFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    fetcher,
    "GOOGLE_TOKEN_EXCHANGE_FAILED"
  );
  const accessToken =
    typeof token.access_token === "string" ? token.access_token.trim() : "";
  const refreshToken =
    typeof token.refresh_token === "string" ? token.refresh_token.trim() : "";
  const grantedScopes =
    typeof token.scope === "string" ? token.scope.trim() : attempt.scope;
  if (!accessToken || !refreshToken || !hasRequiredDocsScopes(grantedScopes)) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google consent did not return the required Workspace Docs credentials."
    );
  }
  const aboutUrl = `${GOOGLE_DRIVE_ABOUT_ENDPOINT}?fields=user(permissionId)`;
  const about = await checkedJsonFetch(
    aboutUrl,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    fetcher,
    "GOOGLE_API_FAILED"
  );
  const providerSubject =
    typeof about?.user?.permissionId === "string"
      ? about.user.permissionId.trim()
      : "";
  if (!providerSubject) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google Drive account identity was unavailable."
    );
  }
  const expiresIn = Number(token.expires_in);
  const tokenExpiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null;
  return saveGoogleConnection({
    userId: input.actorUserId,
    providerSubject,
    credential: cipher.encrypt(refreshToken),
    grantedScopes,
    tokenExpiresAt,
  });
}
export async function listWorkspaceGoogleDocsConnections(actorUserId: number) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const rows = await db
    .select({
      id: workspaceGoogleConnections.id,
      grantedScopes: workspaceGoogleConnections.grantedScopes,
      status: workspaceGoogleConnections.status,
      version: workspaceGoogleConnections.version,
      lastUsedAt: workspaceGoogleConnections.lastUsedAt,
      updatedAt: workspaceGoogleConnections.updatedAt,
    })
    .from(workspaceGoogleConnections)
    .where(eq(workspaceGoogleConnections.userId, actorUserId));
  return rows.map((row: any) => ({
    id: row.id,
    status: row.status,
    version: row.version,
    scopeReady: hasRequiredDocsScopes(row.grantedScopes),
    lastUsedAt: row.lastUsedAt,
    updatedAt: row.updatedAt,
  }));
}

async function requireRuntimeConnection(
  actorUserId: number,
  connectionId: number
) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const [connection] = await db
    .select()
    .from(workspaceGoogleConnections)
    .where(eq(workspaceGoogleConnections.id, connectionId))
    .limit(1);
  if (!connection || connection.userId !== actorUserId) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "CONNECTION_NOT_FOUND",
      "Workspace Google Docs connection was not found."
    );
  }
  if (connection.status !== "active" || !connection.encryptedRefreshToken) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "DOCS_RECONNECT_REQUIRED",
      "Workspace Google Docs connection requires reconnection."
    );
  }
  if (!hasRequiredDocsScopes(connection.grantedScopes)) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "DOCS_SCOPE_REQUIRED",
      "Workspace Google Docs connection is missing required read-only scopes."
    );
  }
  return connection;
}
export async function refreshWorkspaceGoogleDocsAccessToken(input: {
  actorUserId: number;
  connectionId: number;
  fetchImpl?: typeof fetch;
}) {
  const connection = await requireRuntimeConnection(
    input.actorUserId,
    input.connectionId
  );
  const config = resolveWorkspaceGoogleDocsRuntimeConfig();
  const cipher = createWorkspaceGoogleDocsTokenCipher();
  let refreshToken: string;
  try {
    refreshToken = cipher.decrypt({
      encryptedRefreshToken: connection.encryptedRefreshToken!,
      keyVersion: connection.keyVersion,
    });
  } catch {
    throw new WorkspaceGoogleDocsRuntimeError(
      "DOCS_RECONNECT_REQUIRED",
      "Workspace Google Docs refresh credential could not be decrypted."
    );
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const fetcher = input.fetchImpl ?? fetch;
  const token = await checkedJsonFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    fetcher,
    "GOOGLE_TOKEN_EXCHANGE_FAILED"
  );
  const accessToken =
    typeof token.access_token === "string" ? token.access_token.trim() : "";
  if (!accessToken)
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google refresh did not return an access token."
    );
  const returnedRefreshToken =
    typeof token.refresh_token === "string" ? token.refresh_token.trim() : "";
  if (returnedRefreshToken) {
    await rotateGoogleConnectionCredential({
      actorUserId: input.actorUserId,
      connectionId: input.connectionId,
      expectedVersion: connection.version,
      returnedRefreshToken,
      cipher,
    });
  }
  return accessToken;
}

export async function resolveWorkspaceGoogleDocsAiQcExecutionRuntime(input: {
  actorUserId: number;
  workspaceId: number;
  jobId: number;
  snapshotId: number;
  fetchImpl?: typeof fetch;
}) {
  if (process.env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
    throw new WorkspaceGoogleDocsRuntimeError(
      "RUNTIME_CONFIG_INVALID",
      "Workspace Google Docs AI QC runtime is Preview-only."
    );
  }
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const [row] = await db
    .select({
      jobId: workspaceAiJobs.id,
      workspaceId: workspaceAiJobs.workspaceId,
      jobSnapshotId: workspaceAiJobs.snapshotId,
      snapshotId: workspaceDocumentSnapshots.id,
      documentId: workspaceDocuments.id,
      documentStatus: workspaceDocuments.status,
      providerFileId: workspaceDocuments.providerFileId,
      providerRevisionId: workspaceDocumentSnapshots.providerRevisionId,
      connectionId: workspaceGoogleConnections.id,
      connectionUserId: workspaceGoogleConnections.userId,
      connectionStatus: workspaceGoogleConnections.status,
    })
    .from(workspaceAiJobs)
    .innerJoin(
      workspaceDocumentSnapshots,
      eq(workspaceAiJobs.snapshotId, workspaceDocumentSnapshots.id)
    )
    .innerJoin(
      workspaceDocuments,
      eq(workspaceDocumentSnapshots.documentId, workspaceDocuments.id)
    )
    .innerJoin(
      workspaceGoogleConnections,
      eq(workspaceDocuments.connectionId, workspaceGoogleConnections.id)
    )
    .where(
      and(
        eq(workspaceAiJobs.id, input.jobId),
        eq(workspaceAiJobs.workspaceId, input.workspaceId),
        eq(workspaceAiJobs.snapshotId, input.snapshotId)
      )
    )
    .limit(1);
  if (
    !row ||
    row.jobSnapshotId !== input.snapshotId ||
    row.snapshotId !== input.snapshotId ||
    row.documentStatus !== "active" ||
    row.connectionStatus !== "active" ||
    row.connectionUserId !== input.actorUserId
  ) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "AI_QC_SOURCE_INVALID",
      "The exact AI QC snapshot is not backed by an active authorized Google Docs connection."
    );
  }
  const accessToken = await refreshWorkspaceGoogleDocsAccessToken({
    actorUserId: input.actorUserId,
    connectionId: row.connectionId,
    fetchImpl: input.fetchImpl,
  });
  const baseDocsAdapter = createWorkspaceGoogleDocsRuntimeAdapter(
    input.fetchImpl ?? fetch
  );
  const docsAdapter: WorkspaceDocsAdapter = {
    ...baseDocsAdapter,
    async getMetadata(request) {
      const metadata = await baseDocsAdapter.getMetadata(request);
      if (
        metadata.providerFileId !== row.providerFileId ||
        metadata.revision !== row.providerRevisionId
      ) {
        throw new WorkspaceGoogleDocsRuntimeError(
          "AI_QC_SOURCE_INVALID",
          "Current Google document identity or revision no longer matches the exact AI QC snapshot."
        );
      }
      return metadata;
    },
  };
  return {
    accessToken,
    docsAdapter,
    connectionId: row.connectionId,
    documentId: row.documentId,
    providerFileId: row.providerFileId,
  };
}
type GoogleDriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  trashed?: boolean;
};

export async function fetchWorkspaceGoogleDriveFileMetadata(input: {
  accessToken: string;
  providerFileId: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleDriveFileMetadata> {
  const fileId = input.providerFileId.trim();
  if (!fileId || fileId.length > 255)
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "Google document ID is invalid."
    );
  const url = `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,version,trashed`;
  const data = await checkedJsonFetch(
    url,
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
    input.fetchImpl ?? fetch,
    "GOOGLE_API_FAILED"
  );
  const id = typeof data.id === "string" ? data.id.trim() : "";
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const mimeType =
    typeof data.mimeType === "string" ? data.mimeType.trim() : "";
  const version = typeof data.version === "string" ? data.version.trim() : "";
  if (
    id !== fileId ||
    !name ||
    mimeType !== GOOGLE_DOC_MIME_TYPE ||
    !/^\d+$/.test(version) ||
    data.trashed === true
  ) {
    throw new WorkspaceGoogleDocsRuntimeError(
      "GOOGLE_RESPONSE_INVALID",
      "The selected Google file is not an active Google Docs document."
    );
  }
  return { id, name, mimeType, version, trashed: false };
}

function structuralText(elements: any[] | undefined): string {
  if (!Array.isArray(elements)) return "";
  const chunks: string[] = [];
  for (const element of elements) {
    const paragraphElements = element?.paragraph?.elements;
    if (Array.isArray(paragraphElements)) {
      for (const paragraphElement of paragraphElements) {
        const content = paragraphElement?.textRun?.content;
        if (typeof content === "string") chunks.push(content);
      }
    }
    const rows = element?.table?.tableRows;
    if (Array.isArray(rows)) {
      for (const row of rows)
        for (const cell of row?.tableCells ?? [])
          chunks.push(structuralText(cell?.content));
    }
    if (element?.tableOfContents?.content)
      chunks.push(structuralText(element.tableOfContents.content));
  }
  return chunks.join("");
}
function tabsText(tabs: any[] | undefined): string {
  if (!Array.isArray(tabs)) return "";
  const chunks: string[] = [];
  for (const tab of tabs) {
    chunks.push(structuralText(tab?.documentTab?.body?.content));
    chunks.push(tabsText(tab?.childTabs));
  }
  return chunks.join("");
}

async function fetchGoogleDocument(input: {
  accessToken: string;
  providerFileId: string;
  fetchImpl: typeof fetch;
}) {
  const url = `${GOOGLE_DOCS_ENDPOINT}/${encodeURIComponent(input.providerFileId)}?includeTabsContent=true`;
  return checkedJsonFetch(
    url,
    {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
    input.fetchImpl,
    "GOOGLE_API_FAILED",
    MAX_GOOGLE_DOCUMENT_RESPONSE_CHARS
  );
}

export function createWorkspaceGoogleDocsRuntimeAdapter(
  fetchImpl: typeof fetch = fetch
): WorkspaceDocsAdapter {
  const cache = new Map<string, any>();
  const keyFor = (accessToken: string, providerFileId: string) =>
    `${accessToken}\u0000${providerFileId}`;
  return {
    async getMetadata({ accessToken, providerFileId }) {
      const metadata = await fetchWorkspaceGoogleDriveFileMetadata({
        accessToken,
        providerFileId,
        fetchImpl,
      });
      const document = await fetchGoogleDocument({
        accessToken,
        providerFileId,
        fetchImpl,
      });
      cache.set(keyFor(accessToken, providerFileId), document);
      return {
        providerFileId: metadata.id,
        revision: metadata.version,
        mimeType: metadata.mimeType,
        title: metadata.name,
      };
    },
    async getNormalizedText({ accessToken, providerFileId }) {
      const cacheKey = keyFor(accessToken, providerFileId);
      const document =
        cache.get(cacheKey) ??
        (await fetchGoogleDocument({ accessToken, providerFileId, fetchImpl }));
      cache.delete(cacheKey);
      const text =
        Array.isArray(document?.tabs) && document.tabs.length
          ? tabsText(document.tabs)
          : structuralText(document?.body?.content);
      if (!text.trim())
        throw new WorkspaceGoogleDocsRuntimeError(
          "GOOGLE_RESPONSE_INVALID",
          "Google document contained no readable text."
        );
      return text;
    },
    async revoke({ refreshToken }) {
      let response: Response;
      try {
        response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        });
      } catch {
        throw new WorkspaceGoogleDocsRuntimeError(
          "GOOGLE_API_FAILED",
          "Google credential revocation failed."
        );
      }
      if (!response.ok)
        throw new WorkspaceGoogleDocsRuntimeError(
          "GOOGLE_API_FAILED",
          `Google credential revocation failed with HTTP ${response.status}.`
        );
    },
  };
}
