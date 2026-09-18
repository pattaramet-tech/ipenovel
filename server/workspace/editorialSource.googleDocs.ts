import { eq } from "drizzle-orm";
import { workspaceGoogleConnections } from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  createAesGcmTokenCipher,
  GOOGLE_DOC_MIME_TYPE,
  hasRequiredDocsScopes,
} from "./googleDocs.domain";
import { rotateGoogleConnectionCredential } from "./googleDocs.service";
import type {
  EditorialSourcePayload,
  EditorialSourceTabInput,
} from "./editorialDraft.domain";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DOCS_ENDPOINT = "https://docs.googleapis.com/v1/documents";
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 20_000_000;
const TOKEN_KEY_VERSION = 1;

export class WorkspaceEditorialGoogleSourceError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "CONNECTION_NOT_FOUND"
      | "CONNECTION_RECONNECT_REQUIRED"
      | "RUNTIME_CONFIG_INVALID"
      | "GOOGLE_API_FAILED"
      | "GOOGLE_RESPONSE_INVALID"
      | "GOOGLE_DOC_ID_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialGoogleSourceError";
  }
}

function decode32ByteKey(raw: string) {
  const value = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (!value || decoded.length !== 32) {
    throw new WorkspaceEditorialGoogleSourceError(
      "RUNTIME_CONFIG_INVALID",
      "WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY must decode to 32 bytes."
    );
  }
  return decoded;
}

function tokenCipher() {
  return createAesGcmTokenCipher(
    new Map([
      [
        TOKEN_KEY_VERSION,
        decode32ByteKey(
          process.env.WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY ?? ""
        ),
      ],
    ]),
    TOKEN_KEY_VERSION
  );
}

function oauthConfig() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new WorkspaceEditorialGoogleSourceError(
      "RUNTIME_CONFIG_INVALID",
      "Google OAuth runtime configuration is incomplete."
    );
  }
  return { clientId, clientSecret };
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialGoogleSourceError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}

async function checkedJsonFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_API_FAILED",
      "Google request failed."
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Google response exceeded the allowed size."
    );
  }
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Google returned invalid JSON."
    );
  }
  if (!response.ok) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_API_FAILED",
      `Google request failed with HTTP ${response.status}.`
    );
  }
  return data;
}

export function parseGoogleDocId(value: string) {
  const raw = value.trim();
  if (/^[A-Za-z0-9_-]{20,255}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname !== "docs.google.com") return null;
    const match = url.pathname.match(
      /^\/document\/d\/([A-Za-z0-9_-]{20,255})(?:\/|$)/
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function paragraphText(paragraph: any) {
  const elements = Array.isArray(paragraph?.elements) ? paragraph.elements : [];
  return elements
    .map((element: any) =>
      typeof element?.textRun?.content === "string"
        ? element.textRun.content
        : ""
    )
    .join("")
    .replace(/\n$/, "");
}

function collectStructuralParagraphs(
  elements: any[] | undefined,
  out: string[]
) {
  if (!Array.isArray(elements)) return;
  for (const element of elements) {
    if (element?.paragraph) {
      out.push(paragraphText(element.paragraph));
    }
    const rows = element?.table?.tableRows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        for (const cell of row?.tableCells ?? []) {
          collectStructuralParagraphs(cell?.content, out);
        }
      }
    }
    if (element?.tableOfContents?.content) {
      collectStructuralParagraphs(element.tableOfContents.content, out);
    }
  }
}

function flattenTabs(tabs: any[] | undefined, out: EditorialSourceTabInput[]) {
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    const properties = tab?.tabProperties ?? {};
    const sourceTabId =
      typeof properties.tabId === "string" ? properties.tabId.trim() : "";
    if (!sourceTabId) {
      throw new WorkspaceEditorialGoogleSourceError(
        "GOOGLE_RESPONSE_INVALID",
        "Google document tab identity was unavailable."
      );
    }
    const paragraphs: string[] = [];
    collectStructuralParagraphs(tab?.documentTab?.body?.content, paragraphs);
    out.push({
      sourceTabId,
      tabOrder: out.length,
      title:
        typeof properties.title === "string" && properties.title.trim()
          ? properties.title.trim()
          : `Tab ${out.length + 1}`,
      paragraphs,
    });
    flattenTabs(tab?.childTabs, out);
  }
}

async function requireAccessToken(input: {
  actorUserId: number;
  connectionId: number;
  fetchImpl: typeof fetch;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const [connection] = await db
    .select()
    .from(workspaceGoogleConnections)
    .where(eq(workspaceGoogleConnections.id, input.connectionId))
    .limit(1);
  if (!connection || connection.userId !== input.actorUserId) {
    throw new WorkspaceEditorialGoogleSourceError(
      "CONNECTION_NOT_FOUND",
      "Google Docs connection was not found."
    );
  }
  if (
    connection.status !== "active" ||
    !connection.encryptedRefreshToken ||
    !hasRequiredDocsScopes(connection.grantedScopes)
  ) {
    throw new WorkspaceEditorialGoogleSourceError(
      "CONNECTION_RECONNECT_REQUIRED",
      "Google Docs connection requires reconnecting with read-only Docs scopes."
    );
  }
  const cipher = tokenCipher();
  let refreshToken: string;
  try {
    refreshToken = cipher.decrypt({
      encryptedRefreshToken: connection.encryptedRefreshToken,
      keyVersion: connection.keyVersion,
    });
  } catch {
    throw new WorkspaceEditorialGoogleSourceError(
      "CONNECTION_RECONNECT_REQUIRED",
      "Google Docs refresh credential could not be decrypted."
    );
  }
  const config = oauthConfig();
  const token = await checkedJsonFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    },
    input.fetchImpl
  );
  const accessToken =
    typeof token.access_token === "string" ? token.access_token.trim() : "";
  if (!accessToken) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Google refresh did not return an access token."
    );
  }
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

export async function listEditorialGoogleConnections(actorUserId: number) {
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
    .where(eq(workspaceGoogleConnections.userId, actorUserId));
  return rows.map((row: any) => ({
    id: row.id,
    status: row.status,
    scopeReady: hasRequiredDocsScopes(row.grantedScopes),
    updatedAt: row.updatedAt,
  }));
}

export async function fetchEditorialGoogleDocSource(input: {
  actorUserId: number;
  connectionId: number;
  documentUrlOrId: string;
  fetchImpl?: typeof fetch;
}): Promise<EditorialSourcePayload> {
  const providerDocumentId = parseGoogleDocId(input.documentUrlOrId);
  if (!providerDocumentId) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_DOC_ID_INVALID",
      "Google Docs URL or document ID is invalid."
    );
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const accessToken = await requireAccessToken({
    actorUserId: input.actorUserId,
    connectionId: input.connectionId,
    fetchImpl,
  });
  const metadata = await checkedJsonFetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(providerDocumentId)}?fields=id,name,mimeType,version,trashed`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    fetchImpl
  );
  if (
    metadata?.id !== providerDocumentId ||
    metadata?.mimeType !== GOOGLE_DOC_MIME_TYPE ||
    metadata?.trashed === true ||
    typeof metadata?.version !== "string"
  ) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Selected Google file is not an active Google Docs document."
    );
  }
  const document = await checkedJsonFetch(
    `${GOOGLE_DOCS_ENDPOINT}/${encodeURIComponent(providerDocumentId)}?includeTabsContent=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    fetchImpl
  );
  if (document?.documentId !== providerDocumentId) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Google Docs returned an unexpected document identity."
    );
  }
  const documentRevisionId =
    typeof document.revisionId === "string" ? document.revisionId.trim() : "";
  const tabs: EditorialSourceTabInput[] = [];
  flattenTabs(document?.tabs, tabs);
  if (!tabs.length) {
    const paragraphs: string[] = [];
    collectStructuralParagraphs(document?.body?.content, paragraphs);
    tabs.push({
      sourceTabId: "root",
      tabOrder: 0,
      title:
        typeof metadata?.name === "string" && metadata.name.trim()
          ? metadata.name.trim()
          : "Document",
      paragraphs,
    });
  }
  if (!tabs.some(tab => tab.paragraphs.some(text => text.trim()))) {
    throw new WorkspaceEditorialGoogleSourceError(
      "GOOGLE_RESPONSE_INVALID",
      "Google document contained no readable paragraphs."
    );
  }
  return {
    sourceKind: "google_doc",
    sourceKey: `google-doc:${providerDocumentId}`,
    providerDocumentId,
    mimeType: GOOGLE_DOC_MIME_TYPE,
    title:
      typeof metadata.name === "string" && metadata.name.trim()
        ? metadata.name.trim()
        : "Google Document",
    revisionKey: documentRevisionId || metadata.version,
    tabs,
  };
}
