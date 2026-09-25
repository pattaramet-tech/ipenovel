import { createHash, randomUUID } from "node:crypto";

import { NQA_V1_ENABLED_PERMISSION_TIERS } from "../controlPlane";
import { parseIntakeRow } from "../intake";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleDocumentMetadata,
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
  NqaGoogleValueRange,
} from "../google/contracts";
import { GoogleRestReadOnlyTransport } from "../google/transport";
import type { NqaChapterDocumentReader } from "../chapter/googleReader";
import type {
  NqaDocumentParagraph,
  NqaDocumentSnapshot,
  NqaDocumentTabSnapshot,
} from "../chapter/contracts";
import {
  buildTranslationChapterBoundaries,
  parseSourceHeading,
  parseTranslationHeading,
} from "../chapter/parser";
import { resolveChapter } from "../chapter/resolver";
import {
  extractSourceChapter,
  extractTranslationChapter,
} from "../chapter/extractor";
import { sanitizeNqaChapterTail } from "../chapter/sanitizer";
import { createNqaDeterministicQaHandlers } from "../deterministic/handlers";
import { createNqaSemanticQaHandlers } from "../semantic/handlers";
import { LocalHttpEmbeddingProvider } from "../semantic/embedding";
import { LocalHttpRerankerProvider } from "../semantic/alignment/reranker";
import { LocalHttpSmallLlmProvider } from "../semantic/adjudication/smallLlm";
import { LocalHttpStructureVerificationProvider } from "../semantic/structure/provider";
import { createNqaIdentityHandlers } from "../identity/handlers";
import { NqaNovelIdentityResolver } from "../identity/resolver";
import { JsonlNqaAdminGatewayAuditSink } from "./audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import type {
  NqaAuthenticatedPrincipal,
  NqaGatewayResponse,
} from "../mcp/contracts";
import {
  fetchEditorialGoogleDocSource,
  listEditorialGoogleConnections,
} from "../../workspace/editorialSource.googleDocs";
import {
  NQA_AUTOLINK_LIVE_TARGET,
  NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE,
  resolveWorkspaceNqaAutolinkRuntimeStatus,
} from "../../workspace/nqaAutolink.runtime";
import { JsonNqaAdminRunStore, resolveNqaAdminRunDirectory } from "./store";
import type {
  NqaAdminChapterResult,
  NqaAdminDisplayDecision,
  NqaAdminQcFinding,
  NqaAdminRun,
  NqaAdminRunRow,
  NqaAdminSampleMode,
  NqaAdminStartRunInput,
} from "./contracts";

const SHEETS_READ_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN";
const SHEETS_READ_SCOPES_ENV = "NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES";
const SHEETS_WRITE_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN";
const SHEETS_WRITE_SCOPES_ENV = "NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES";
const ADMIN_WRITEBACK_ENABLED_ENV = "NQA_ADMIN_WRITEBACK_ENABLED";
const FULL_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const EMBEDDING_ENDPOINT = "http://127.0.0.1:8765/embed";
const RERANK_ENDPOINT = "http://127.0.0.1:8766/rerank";
const ADJUDICATION_ENDPOINT = "http://127.0.0.1:8767/adjudicate";
const STRUCTURE_ENDPOINT = "http://127.0.0.1:8767/verify-structure";

const EMBEDDING_HEALTH = "http://127.0.0.1:8765/health";
const RERANK_HEALTH = "http://127.0.0.1:8766/health";
const QWEN_HEALTH = "http://127.0.0.1:8767/health";

const MAX_EVIDENCE_ITEMS = 20;
const EXCERPT_LIMIT = 900;

type Environment = Record<string, string | undefined>;

export class NqaAdminRuntimeError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_NOT_READY"
      | "GOOGLE_CONNECTION_NOT_READY"
      | "RUN_COMPLETE"
      | "GATEWAY_ERROR"
      | "RUN_EMPTY",
    message: string
  ) {
    super(message);
    this.name = "NqaAdminRuntimeError";
  }
}

function parseScopes(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/\s+/).filter(Boolean));
}

function truthySheetCell(value: unknown): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["true", "1", "yes", "y", "ใช่"].includes(normalized);
}

function boundedExcerpt(text: string | null | undefined): string | null {
  const normalized = text?.normalize("NFC").trim();
  if (!normalized) return null;
  return normalized.slice(0, EXCERPT_LIMIT);
}

function makeParagraphs(
  tabId: string,
  values: string[]
): NqaDocumentParagraph[] {
  let offset = 1;
  return values.map(text => {
    const startIndex = offset;
    const endIndex = startIndex + text.length + 1;
    offset = endIndex;
    return {
      text,
      startIndex,
      endIndex,
      tabId,
    };
  });
}

export class WorkspaceEditorialNqaDocsReader implements NqaChapterDocumentReader {
  private readonly cache = new Map<string, Promise<NqaDocumentSnapshot>>();

  constructor(
    private readonly actorUserId: number,
    private readonly connectionId: number,
    private readonly fetchImpl?: typeof fetch
  ) {}

  async readDocument(documentId: string): Promise<NqaDocumentSnapshot> {
    let pending = this.cache.get(documentId);
    if (!pending) {
      pending = this.load(documentId);
      this.cache.set(documentId, pending);
    }
    return await pending;
  }

  private async load(documentId: string): Promise<NqaDocumentSnapshot> {
    const source = await fetchEditorialGoogleDocSource({
      actorUserId: this.actorUserId,
      connectionId: this.connectionId,
      documentUrlOrId: documentId,
      fetchImpl: this.fetchImpl,
    });

    return {
      documentId: source.providerDocumentId ?? documentId,
      title: source.title || null,
      revisionId: source.revisionKey ?? null,
      tabs: source.tabs.map(tab => ({
        tabId: tab.sourceTabId,
        title: tab.title || null,
        index: tab.tabOrder,
        parentTabId: null,
        paragraphs: makeParagraphs(tab.sourceTabId, tab.paragraphs),
      })),
    };
  }
}

export function sampledTab(
  tab: NqaDocumentTabSnapshot,
  limit: number
): NqaDocumentTabSnapshot {
  const kept: NqaDocumentParagraph[] = [];
  let remaining = 0;

  for (const paragraph of tab.paragraphs) {
    const isHeading =
      parseSourceHeading(paragraph.text) !== null ||
      parseTranslationHeading(paragraph.text) !== null;

    if (isHeading) {
      kept.push(paragraph);
      remaining = limit;
      continue;
    }

    if (remaining > 0 && paragraph.text.trim()) {
      kept.push(paragraph);
      remaining -= 1;
    }
  }

  return {
    ...tab,
    paragraphs: kept,
  };
}

export class SamplingNqaChapterReader implements NqaChapterDocumentReader {
  private readonly cache = new Map<string, Promise<NqaDocumentSnapshot>>();

  constructor(
    private readonly base: NqaChapterDocumentReader,
    private readonly sample: NqaAdminSampleMode
  ) {}

  async readDocument(documentId: string): Promise<NqaDocumentSnapshot> {
    let pending = this.cache.get(documentId);
    if (!pending) {
      pending = this.load(documentId);
      this.cache.set(documentId, pending);
    }
    return await pending;
  }

  private async load(documentId: string): Promise<NqaDocumentSnapshot> {
    const snapshot = await this.base.readDocument(documentId);
    const sample = this.sample;
    if (sample === "FULL") return snapshot;
    return {
      ...snapshot,
      tabs: snapshot.tabs.map(tab => sampledTab(tab, sample)),
    };
  }
}

class SplitCredentialGoogleTransport implements NqaGoogleReadOnlyTransport {
  constructor(
    private readonly sheets: GoogleRestReadOnlyTransport,
    private readonly docs: NqaChapterDocumentReader
  ) {}

  async getSpreadsheetMetadata(
    spreadsheetId: string
  ): Promise<NqaGoogleSpreadsheetMetadata> {
    return await this.sheets.getSpreadsheetMetadata(spreadsheetId);
  }

  async batchGetValues(input: {
    spreadsheetId: string;
    ranges: string[];
  }): Promise<NqaGoogleValueRange[]> {
    return await this.sheets.batchGetValues(input);
  }

  async getDocumentMetadata(
    documentId: string
  ): Promise<NqaGoogleDocumentMetadata> {
    const snapshot = await this.docs.readDocument(documentId);
    return {
      documentId: snapshot.documentId,
      title: snapshot.title,
      revisionId: snapshot.revisionId,
      tabs: snapshot.tabs.map(tab => ({
        tabId: tab.tabId,
        title: tab.title,
        index: tab.index,
        parentTabId: tab.parentTabId,
      })),
    };
  }
}

function createSheetsReadTransport(
  env: Environment = process.env
): GoogleRestReadOnlyTransport {
  return new GoogleRestReadOnlyTransport({
    accessTokenProvider: () => env[SHEETS_READ_TOKEN_ENV] ?? "",
  });
}

function createQaAdapter(input: {
  actorUserId: number;
  googleConnectionId: number;
  sampleParagraphs: NqaAdminSampleMode;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  const baseReader = new WorkspaceEditorialNqaDocsReader(
    input.actorUserId,
    input.googleConnectionId
  );
  const reader = new SamplingNqaChapterReader(
    baseReader,
    input.sampleParagraphs
  );
  const sheetTransport = createSheetsReadTransport(env);
  const split = new SplitCredentialGoogleTransport(sheetTransport, reader);

  return {
    adapter: new NqaGoogleBulkIntakeAdapter(split, {
      spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
      sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
      columns: {
        novelTitle: "B",
        translation: "C",
        webSource: "E",
        preparedSource: "K",
      },
      maxRowsPerScan: 50,
    }),
    reader,
    sheetTransport,
  };
}

async function probeSidecar(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getNqaAdminStatus(
  actorUserId: number,
  env: Environment = process.env
) {
  const autolink = resolveWorkspaceNqaAutolinkRuntimeStatus(env);
  let googleConnections: Array<{
    id: number;
    status: string;
    scopeReady: boolean;
    updatedAt: unknown;
  }> = [];
  let googleConnectionError = false;
  try {
    googleConnections = await listEditorialGoogleConnections(actorUserId);
  } catch {
    googleConnectionError = true;
  }

  const [embeddingReady, rerankerReady, qwenReady] = await Promise.all([
    probeSidecar(EMBEDDING_HEALTH),
    probeSidecar(RERANK_HEALTH),
    probeSidecar(QWEN_HEALTH),
  ]);

  let runStoreReady = true;
  try {
    resolveNqaAdminRunDirectory(env);
  } catch {
    runStoreReady = false;
  }

  const docsReady =
    !googleConnectionError &&
    googleConnections.some(
      connection => connection.status === "active" && connection.scopeReady
    );

  const writeToken = env[SHEETS_WRITE_TOKEN_ENV]?.trim() ?? "";
  const writeScopeReady = parseScopes(env[SHEETS_WRITE_SCOPES_ENV]).has(
    FULL_SHEETS_SCOPE
  );
  const writebackEnabled = env[ADMIN_WRITEBACK_ENABLED_ENV] === "true";

  const qcBlockers: string[] = [];
  if (!autolink.previewReady) {
    qcBlockers.push(...autolink.previewBlockers);
  }
  if (!docsReady) qcBlockers.push("WORKSPACE_DOCS_CONNECTION_NOT_READY");
  if (!runStoreReady) qcBlockers.push("RUN_STORE_NOT_READY");

  const fullQaBlockers = [...qcBlockers];
  if (!embeddingReady) fullQaBlockers.push("EMBEDDING_SIDECAR_NOT_READY");
  if (!rerankerReady) fullQaBlockers.push("RERANKER_SIDECAR_NOT_READY");
  if (!qwenReady) fullQaBlockers.push("QWEN_SIDECAR_NOT_READY");

  const writebackBlockers: string[] = [];
  if (!writebackEnabled) writebackBlockers.push("WRITEBACK_DISABLED");
  if (!writeToken) writebackBlockers.push("WRITE_CREDENTIAL_MISSING");
  if (!writeScopeReady) writebackBlockers.push("WRITE_SCOPE_MISSING");

  return {
    target: NQA_AUTOLINK_LIVE_TARGET,
    fullQa: {
      ready: fullQaBlockers.length === 0,
      blockers: Array.from(new Set(fullQaBlockers)),
    },
    qc: {
      ready: qcBlockers.length === 0,
      blockers: Array.from(new Set(qcBlockers)),
    },
    google: {
      sheetReadReady: autolink.previewReady,
      docsReady,
      connectionError: googleConnectionError,
      connections: googleConnections,
    },
    semantic: {
      embeddingReady,
      rerankerReady,
      qwenReady,
    },
    audit: {
      runStoreReady,
    },
    writeback: {
      ready: writebackBlockers.length === 0,
      enabled: writebackEnabled,
      blockers: writebackBlockers,
    },
    autolink,
  };
}

async function planRows(input: {
  startRow: number;
  endRow: number;
  mode: NqaAdminStartRunInput["mode"];
  qcEligibilityOnly: boolean;
  env?: Environment;
}): Promise<NqaAdminRunRow[]> {
  const env = input.env ?? process.env;
  const transport = createSheetsReadTransport(env);
  const metadata = await transport.getSpreadsheetMetadata(
    NQA_AUTOLINK_LIVE_TARGET.spreadsheetId
  );
  const sheet = metadata.sheets.find(
    candidate => candidate.title === NQA_AUTOLINK_LIVE_TARGET.sheetName
  );
  if (!sheet) {
    throw new NqaAdminRuntimeError(
      "RUNTIME_NOT_READY",
      "Configured NQA Sheet tab was not found."
    );
  }

  const range =
    "'" +
    NQA_AUTOLINK_LIVE_TARGET.sheetName.replace(/'/g, "''") +
    "'!B" +
    input.startRow +
    ":K" +
    input.endRow;

  const [batch] = await transport.batchGetValues({
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    ranges: [range],
  });
  const values = batch?.values ?? [];

  const rows: NqaAdminRunRow[] = [];
  for (let row = input.startRow; row <= input.endRow; row += 1) {
    const cells = values[row - input.startRow] ?? [];
    const title = String(cells[0] ?? "").trim() || null;
    const translationUrl = String(cells[1] ?? "").trim() || null;
    const webUrl = String(cells[3] ?? "").trim() || null;
    const workflowF = truthySheetCell(cells[4]);
    const workflowG = truthySheetCell(cells[5]);
    const sourceUrl = String(cells[9] ?? "").trim() || null;

    const parse = parseIntakeRow({
      locator: {
        spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
        sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
        sheetId: sheet.sheetId,
        row,
      },
      novelDisplayTitle: title,
      translationUrl,
      webSourceUrl: webUrl,
      preparedSourceUrl: sourceUrl,
    });

    const rangeStart = parse.parsedBundle?.rangeStart ?? null;
    const rangeEnd = parse.parsedBundle?.rangeEnd ?? null;
    const eligibleByWorkflow =
      input.mode !== "QC" ||
      !input.qcEligibilityOnly ||
      (workflowF && !workflowG);
    const eligible = parse.status === "PASS" && eligibleByWorkflow;
    const chapters: number[] = [];
    if (
      eligible &&
      rangeStart !== null &&
      rangeEnd !== null &&
      rangeEnd >= rangeStart
    ) {
      for (let chapter = rangeStart; chapter <= rangeEnd; chapter += 1) {
        chapters.push(chapter);
      }
    }

    rows.push({
      row,
      title,
      rangeStart,
      rangeEnd,
      workflowF,
      workflowG,
      eligible,
      intakeStatus: parse.status,
      intakeIssues: [...parse.issues],
      chapters,
    });
  }

  return rows;
}

function emptyDecisionCounts(): NqaAdminRun["summary"]["decisions"] {
  return {
    PASS: 0,
    REVIEW: 0,
    MISMATCH: 0,
    INSUFFICIENT: 0,
  };
}

export async function startNqaAdminRun(
  actorUserId: number,
  input: NqaAdminStartRunInput,
  env: Environment = process.env
): Promise<NqaAdminRun> {
  const status = await getNqaAdminStatus(actorUserId, env);
  const readiness = input.mode === "FULL_QA" ? status.fullQa : status.qc;
  if (!readiness.ready) {
    throw new NqaAdminRuntimeError(
      "RUNTIME_NOT_READY",
      "NQA runtime is blocked: " + readiness.blockers.join(", ")
    );
  }

  const connection = status.google.connections.find(
    candidate =>
      candidate.id === input.googleConnectionId &&
      candidate.status === "active" &&
      candidate.scopeReady
  );
  if (!connection) {
    throw new NqaAdminRuntimeError(
      "GOOGLE_CONNECTION_NOT_READY",
      "Selected Workspace Google Docs connection is not ready."
    );
  }

  const rows = await planRows({
    startRow: input.startRow,
    endRow: input.endRow,
    mode: input.mode,
    qcEligibilityOnly: input.qcEligibilityOnly,
    env,
  });
  const totalChapters = rows.reduce((sum, row) => sum + row.chapters.length, 0);
  if (totalChapters === 0) {
    throw new NqaAdminRuntimeError(
      "RUN_EMPTY",
      "No eligible chapters were found for this run."
    );
  }
  if (totalChapters > 5_000) {
    throw new NqaAdminRuntimeError(
      "RUN_EMPTY",
      "Run exceeds the 5,000 chapter safety bound."
    );
  }

  const now = new Date().toISOString();
  const run: NqaAdminRun = {
    version: "nqa-admin-run-v1",
    runId: "nqa-admin-" + randomUUID(),
    actorUserId,
    mode: input.mode,
    startRow: input.startRow,
    endRow: input.endRow,
    googleConnectionId: input.googleConnectionId,
    sampleParagraphs: input.mode === "QC" ? "FULL" : input.sampleParagraphs,
    qcEligibilityOnly: input.qcEligibilityOnly,
    status: "READY",
    blocker: null,
    rows,
    cursor: {
      rowIndex: 0,
      chapterIndex: 0,
    },
    results: [],
    writebacks: [],
    summary: {
      totalRows: rows.length,
      eligibleRows: rows.filter(row => row.eligible).length,
      totalChapters,
      processedChapters: 0,
      decisions: emptyDecisionCounts(),
    },
    createdAt: now,
    updatedAt: now,
  };
  await new JsonNqaAdminRunStore(env).save(run);
  return run;
}

function principal(
  actorUserId: number,
  requestId: string
): NqaAuthenticatedPrincipal {
  return {
    principalId: "nqa-admin:" + actorUserId,
    sessionId: "nqa-admin-trpc:" + requestId,
    permissions: ["READ", "QA_OPERATE"],
    authenticated: true,
  };
}

function gatewayRequest(input: {
  requestId: string;
  correlationId: string;
  capability:
    | "nqa.novel.resolve_identity"
    | "nqa.qa.run_deterministic"
    | "nqa.qa.run_semantic";
  row: number;
  chapter: number;
}) {
  return {
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorId: "nqa-admin",
    capability: input.capability,
    target: {
      row: input.row,
      chapter: input.chapter,
    },
    idempotencyKey: createHash("sha256")
      .update(input.correlationId + ":" + input.capability)
      .digest("hex"),
    inputFingerprint: null,
    requestedAt: new Date().toISOString(),
  };
}

function buildGateway(input: {
  actorUserId: number;
  googleConnectionId: number;
  sampleParagraphs: NqaAdminSampleMode;
  env: Environment;
}) {
  const { adapter, reader } = createQaAdapter(input);
  const identityResolver = new NqaNovelIdentityResolver({
    novels: [],
    bundles: [],
  });
  const handlers = {
    ...createNqaIdentityHandlers({
      adapter,
      resolver: identityResolver,
    }),
    ...createNqaDeterministicQaHandlers({
      adapter,
      reader,
    }),
    ...createNqaSemanticQaHandlers({
      adapter,
      reader,
      embeddingProvider: new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
        endpoint: EMBEDDING_ENDPOINT,
        timeoutMs: 300_000,
      }),
      rerankerProvider: new LocalHttpRerankerProvider(
        "BAAI/bge-reranker-v2-m3",
        {
          endpoint: RERANK_ENDPOINT,
          timeoutMs: 300_000,
        }
      ),
      smallLlmProvider: new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
        endpoint: ADJUDICATION_ENDPOINT,
        timeoutMs: 300_000,
      }),
      structureProvider: new LocalHttpStructureVerificationProvider(
        "Qwen/Qwen3-1.7B",
        {
          endpoint: STRUCTURE_ENDPOINT,
          timeoutMs: 300_000,
        }
      ),
    }),
  };

  return {
    adapter,
    reader,
    gateway: new NqaMcpGateway({
      handlers: new NqaGatewayHandlerRegistry(handlers),
      idempotencyStore: new InMemoryNqaIdempotencyStore(),
      auditSink: new JsonlNqaAdminGatewayAuditSink(input.env),
      enabledPermissionTiers: NQA_V1_ENABLED_PERMISSION_TIERS,
    }),
  };
}

function mismatchReason(reason: string): boolean {
  return [
    "MEANING_DIVERGENCE",
    "EVENT_MISMATCH",
    "ENTITY_MISMATCH",
    "RELATIONSHIP_MISMATCH",
    "CAUSALITY_MISMATCH",
    "CHRONOLOGY_MISMATCH",
    "CONTRADICTION",
    "OMISSION_MAJOR",
    "ADDITION_MAJOR",
    "FABRICATION_SUSPECTED",
    "FABRICATION_DEFINITE",
    "WRONG_CHAPTER",
    "SOURCE_DRIFT",
    "EXACT_DUPLICATE_CHAPTER",
  ].includes(reason);
}

function displayDecision(
  coreDecision: "PASS" | "REVIEW" | "FAIL",
  reasons: readonly string[]
): NqaAdminDisplayDecision {
  if (coreDecision === "PASS") return "PASS";
  if (reasons.includes("INSUFFICIENT_EVIDENCE")) return "INSUFFICIENT";
  if (coreDecision === "FAIL" || reasons.some(mismatchReason)) {
    return "MISMATCH";
  }
  return "REVIEW";
}

function collectEvidence(semantic: any): Array<{
  kind: string;
  boundedSummary: string;
}> {
  const arrays = [
    semantic?.deterministic?.evidence,
    semantic?.globalSearch?.evidence,
    semantic?.alignment?.evidence,
    semantic?.adjudication?.evidence,
    semantic?.structure?.evidence,
  ];
  const output: Array<{ kind: string; boundedSummary: string }> = [];
  for (const values of arrays) {
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.boundedSummary === "string"
      ) {
        output.push({
          kind: typeof item.kind === "string" ? item.kind : "EVIDENCE",
          boundedSummary: item.boundedSummary.slice(0, 1_000),
        });
        if (output.length >= MAX_EVIDENCE_ITEMS) return output;
      }
    }
  }
  return output;
}

function semanticConfidence(semantic: any): number | null {
  const candidates = [
    semantic?.adjudication?.localLlm?.confidence,
    semantic?.structure?.confidence,
    semantic?.globalSearch?.expectedSimilarity,
  ];
  for (const value of candidates) {
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    ) {
      return value;
    }
  }
  return null;
}

async function chapterExcerpts(input: {
  adapter: NqaGoogleBulkIntakeAdapter;
  reader: NqaChapterDocumentReader;
  row: number;
  chapter: number;
}) {
  const row = await input.adapter.getRow(input.row);
  if (row.parse.status !== "PASS") {
    return {
      sourceExcerpt: null,
      translationExcerpt: null,
      source: null,
      translation: null,
      resolution: null,
      translationSnapshot: null,
    };
  }
  const [sourceSnapshot, translationSnapshot] = await Promise.all([
    input.reader.readDocument(row.parse.contract.preparedSourceRef.documentId),
    input.reader.readDocument(row.parse.contract.translationRef.documentId),
  ]);
  const resolution = resolveChapter({
    sourceSnapshot,
    translationSnapshot,
    chapter: input.chapter,
  });
  const source =
    resolution.source === null
      ? null
      : extractSourceChapter({
          snapshot: sourceSnapshot,
          boundary: resolution.source,
        });
  const translation =
    resolution.translation === null
      ? null
      : extractTranslationChapter({
          snapshot: translationSnapshot,
          boundary: resolution.translation,
        });

  return {
    sourceExcerpt: boundedExcerpt(source?.text),
    translationExcerpt: boundedExcerpt(translation?.text),
    source,
    translation,
    resolution,
    translationSnapshot,
  };
}

export function scanUnicodeAnomalies(text: string): string[] {
  const hits: string[] = [];
  for (const char of Array.from(text)) {
    const cp = char.codePointAt(0) ?? 0;
    if (
      char === "\ufffd" ||
      (cp <= 0x1f && !["\n", "\r", "\t"].includes(char)) ||
      cp === 0x7f
    ) {
      hits.push("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
    if (hits.length >= 10) break;
  }
  return Array.from(new Set(hits));
}

function foreignLetterScript(codePoint: number): string | null {
  if (
    (codePoint >= 0x0370 && codePoint <= 0x03ff) ||
    (codePoint >= 0x1f00 && codePoint <= 0x1fff)
  ) {
    return "Greek";
  }
  if (codePoint >= 0x0400 && codePoint <= 0x052f) return "Cyrillic";
  if (codePoint >= 0x0590 && codePoint <= 0x05ff) return "Hebrew";
  if (codePoint >= 0x0600 && codePoint <= 0x06ff) return "Arabic";
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return "Devanagari";
  if (codePoint >= 0x0980 && codePoint <= 0x09ff) return "Bengali";
  if (codePoint >= 0x0a00 && codePoint <= 0x0aff) return "Indic";
  if (codePoint >= 0x0b00 && codePoint <= 0x0cff) return "Indic";
  if (codePoint >= 0x0d00 && codePoint <= 0x0dff) return "Indic";
  if (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff)
  ) {
    return "CJK";
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return "Hangul";
  return null;
}

export function scanForeignScripts(text: string): string[] {
  const hits: string[] = [];
  for (const char of Array.from(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    const script = foreignLetterScript(codePoint);
    if (!script) continue;
    hits.push(
      script +
        ":" +
        char +
        " (U+" +
        codePoint.toString(16).toUpperCase().padStart(4, "0") +
        ")"
    );
    if (hits.length >= 10) break;
  }
  return Array.from(new Set(hits));
}

export function qcFindings(input: {
  translationText: string | null;
  rawParagraphs: NqaDocumentParagraph[];
}): NqaAdminQcFinding[] {
  const findings: NqaAdminQcFinding[] = [];
  const text = input.translationText ?? "";

  const unicode = scanUnicodeAnomalies(text);
  if (unicode.length > 0) {
    findings.push({
      type: "UNICODE_ANOMALY",
      severity: "FAIL",
      summary: "Unicode anomaly: " + unicode.join(", "),
    });
  }

  const foreign = scanForeignScripts(text);
  if (foreign.length > 0) {
    findings.push({
      type: "FOREIGN_SCRIPT",
      severity: "REVIEW",
      summary:
        "Foreign-script marker (Latin proper names are allowed): " +
        foreign.join(", "),
    });
  }

  if (input.rawParagraphs.length > 0) {
    const sanitized = sanitizeNqaChapterTail(input.rawParagraphs);
    if (sanitized.removedParagraphCount > 0) {
      findings.push({
        type: "FOOTER_CONTENT",
        severity: "REVIEW",
        summary:
          "Detected removable tail/footer content: " +
          sanitized.removedParagraphCount +
          " paragraph(s).",
      });
    }

    const body = input.rawParagraphs
      .slice(1)
      .map(paragraph => paragraph.text.trim())
      .filter(Boolean);
    if (body.length === 0) {
      findings.push({
        type: "EMPTY_CHAPTER",
        severity: "FAIL",
        summary: "Chapter heading exists but the chapter body is empty.",
      });
    }
  }

  return findings;
}

function rawTranslationParagraphs(input: {
  translationSnapshot: NqaDocumentSnapshot | null;
  chapter: number;
}): NqaDocumentParagraph[] {
  if (!input.translationSnapshot) return [];
  const boundary = buildTranslationChapterBoundaries(
    input.translationSnapshot
  ).find(
    candidate =>
      candidate.chapter === input.chapter &&
      candidate.variant === "production_original"
  );
  if (!boundary) return [];
  const tab = input.translationSnapshot.tabs.find(
    candidate => candidate.tabId === boundary.tabId
  );
  return (
    tab?.paragraphs.slice(boundary.paragraphStart, boundary.paragraphEnd + 1) ??
    []
  );
}

function qcCoreDecision(
  findings: NqaAdminQcFinding[]
): "PASS" | "REVIEW" | "FAIL" {
  if (findings.some(finding => finding.severity === "FAIL")) return "FAIL";
  if (findings.some(finding => finding.severity === "REVIEW")) return "REVIEW";
  return "PASS";
}

function advanceCursor(run: NqaAdminRun): void {
  const row = run.rows[run.cursor.rowIndex];
  if (!row) return;
  run.cursor.chapterIndex += 1;
  if (run.cursor.chapterIndex >= row.chapters.length) {
    run.cursor.rowIndex += 1;
    run.cursor.chapterIndex = 0;
  }
}

function nextWork(run: NqaAdminRun): { row: number; chapter: number } | null {
  while (run.cursor.rowIndex < run.rows.length) {
    const row = run.rows[run.cursor.rowIndex];
    if (!row.eligible || row.chapters.length === 0) {
      run.cursor.rowIndex += 1;
      run.cursor.chapterIndex = 0;
      continue;
    }
    const chapter = row.chapters[run.cursor.chapterIndex];
    if (chapter === undefined) {
      run.cursor.rowIndex += 1;
      run.cursor.chapterIndex = 0;
      continue;
    }
    return { row: row.row, chapter };
  }
  return null;
}

function responseResult(response: NqaGatewayResponse): any {
  if (response.status === "ERROR") {
    throw new NqaAdminRuntimeError(
      "GATEWAY_ERROR",
      "NQA gateway rejected execution: " + (response.error?.code ?? "UNKNOWN")
    );
  }
  return response.result as any;
}

export async function processNqaAdminRunNext(
  actorUserId: number,
  runId: string,
  env: Environment = process.env
): Promise<NqaAdminRun> {
  const store = new JsonNqaAdminRunStore(env);
  const run = await store.get(runId, actorUserId);
  const work = nextWork(run);
  if (!work) {
    run.status = "COMPLETED";
    run.updatedAt = new Date().toISOString();
    await store.save(run);
    return run;
  }

  const execution = buildGateway({
    actorUserId,
    googleConnectionId: run.googleConnectionId,
    sampleParagraphs: run.sampleParagraphs,
    env,
  });

  const requestId = randomUUID();
  const correlationId = run.runId + ":" + work.row + ":" + work.chapter;
  run.status = "RUNNING";

  const identityRequestId = randomUUID();
  const identityResponse = await execution.gateway.dispatch({
    principal: principal(actorUserId, identityRequestId),
    request: gatewayRequest({
      requestId: identityRequestId,
      correlationId: correlationId + ":identity",
      capability: "nqa.novel.resolve_identity",
      row: work.row,
      chapter: work.chapter,
    }),
  });
  const identityValue = responseResult(identityResponse);
  if (identityValue?.status === "CONTRACT_INVALID") {
    throw new NqaAdminRuntimeError(
      "GATEWAY_ERROR",
      "NQA identity stage rejected the row contract."
    );
  }
  const identitySummary = [
    "identityStatus=" + String(identityValue?.status ?? "unknown"),
    "kind=" + String(identityValue?.resolution?.kind ?? "unknown"),
    "novelId=" + String(identityValue?.resolution?.novel?.novelId ?? "review"),
    "auditRef=" + identityResponse.auditRef,
  ].join(" ");

  let result: Omit<NqaAdminChapterResult, "resultFingerprint">;
  if (run.mode === "FULL_QA") {
    const response = await execution.gateway.dispatch({
      principal: principal(actorUserId, requestId),
      request: gatewayRequest({
        requestId,
        correlationId,
        capability: "nqa.qa.run_semantic",
        row: work.row,
        chapter: work.chapter,
      }),
    });
    const value = responseResult(response);
    const semantic = value?.semantic;
    const coreDecision =
      semantic?.decision === "PASS" ||
      semantic?.decision === "REVIEW" ||
      semantic?.decision === "FAIL"
        ? semantic.decision
        : "REVIEW";
    const reasons = Array.isArray(semantic?.reasonCodes)
      ? semantic.reasonCodes.map(String)
      : [];
    const excerpts = await chapterExcerpts({
      adapter: execution.adapter,
      reader: execution.reader,
      row: work.row,
      chapter: work.chapter,
    });

    result = {
      row: work.row,
      chapter: work.chapter,
      displayDecision: displayDecision(coreDecision, reasons),
      coreDecision,
      reasonCodes: reasons,
      confidence: semanticConfidence(semantic),
      policyVersion:
        typeof semantic?.policyVersion === "string"
          ? semantic.policyVersion
          : null,
      modelSetVersion:
        "BAAI/bge-m3 + BAAI/bge-reranker-v2-m3 + Qwen/Qwen3-1.7B",
      evidence: [
        {
          kind: "IDENTITY",
          boundedSummary: identitySummary.slice(0, 1_000),
        },
        ...collectEvidence(semantic),
      ].slice(0, MAX_EVIDENCE_ITEMS),
      sourceExcerpt: excerpts.sourceExcerpt,
      translationExcerpt: excerpts.translationExcerpt,
      qcFindings: [],
      requestId: response.requestId,
      correlationId: response.correlationId,
      auditRef: response.auditRef,
      completedAt: new Date().toISOString(),
    };
  } else {
    const response = await execution.gateway.dispatch({
      principal: principal(actorUserId, requestId),
      request: gatewayRequest({
        requestId,
        correlationId,
        capability: "nqa.qa.run_deterministic",
        row: work.row,
        chapter: work.chapter,
      }),
    });
    const value = responseResult(response);
    const excerpts = await chapterExcerpts({
      adapter: execution.adapter,
      reader: execution.reader,
      row: work.row,
      chapter: work.chapter,
    });
    const rawParagraphs = rawTranslationParagraphs({
      translationSnapshot: excerpts.translationSnapshot,
      chapter: work.chapter,
    });
    const findings = qcFindings({
      translationText: excerpts.translation?.text ?? null,
      rawParagraphs,
    });
    const coreDecision = qcCoreDecision(findings);
    const display: NqaAdminDisplayDecision =
      coreDecision === "PASS"
        ? "PASS"
        : coreDecision === "FAIL"
          ? "MISMATCH"
          : "REVIEW";

    result = {
      row: work.row,
      chapter: work.chapter,
      displayDecision: display,
      coreDecision,
      reasonCodes: findings.map(finding => finding.type),
      confidence: null,
      policyVersion:
        typeof value?.deterministic?.policyVersion === "string"
          ? value.deterministic.policyVersion
          : null,
      modelSetVersion: "deterministic-qc-v1",
      evidence: [
        {
          kind: "IDENTITY",
          boundedSummary: identitySummary.slice(0, 1_000),
        },
        ...(Array.isArray(value?.deterministic?.evidence)
          ? value.deterministic.evidence
              .slice(0, MAX_EVIDENCE_ITEMS - 1)
              .map((item: any) => ({
                kind: typeof item?.kind === "string" ? item.kind : "EVIDENCE",
                boundedSummary:
                  typeof item?.boundedSummary === "string"
                    ? item.boundedSummary.slice(0, 1_000)
                    : "",
              }))
          : []),
      ],
      sourceExcerpt: null,
      translationExcerpt: excerpts.translationExcerpt,
      qcFindings: findings,
      requestId: response.requestId,
      correlationId: response.correlationId,
      auditRef: response.auditRef,
      completedAt: new Date().toISOString(),
    };
  }

  const resultFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        scope: "nqa-admin-chapter-result-v1",
        row: result.row,
        chapter: result.chapter,
        displayDecision: result.displayDecision,
        coreDecision: result.coreDecision,
        reasonCodes: result.reasonCodes,
        confidence: result.confidence,
        policyVersion: result.policyVersion,
        modelSetVersion: result.modelSetVersion,
        evidence: result.evidence,
        sourceExcerpt: result.sourceExcerpt,
        translationExcerpt: result.translationExcerpt,
        qcFindings: result.qcFindings,
        requestId: result.requestId,
        correlationId: result.correlationId,
        auditRef: result.auditRef,
        completedAt: result.completedAt,
      })
    )
    .digest("hex");
  const completedResult: NqaAdminChapterResult = {
    ...result,
    resultFingerprint,
  };
  run.results.push(completedResult);
  run.summary.processedChapters = run.results.length;
  run.summary.decisions[completedResult.displayDecision] += 1;
  advanceCursor(run);
  if (!nextWork(run)) run.status = "COMPLETED";
  run.updatedAt = new Date().toISOString();
  await store.save(run);
  return run;
}

export async function getNqaAdminRun(
  actorUserId: number,
  runId: string,
  env: Environment = process.env
) {
  return await new JsonNqaAdminRunStore(env).get(runId, actorUserId);
}

export async function listNqaAdminRuns(
  actorUserId: number,
  limit = 30,
  env: Environment = process.env
) {
  return await new JsonNqaAdminRunStore(env).list(actorUserId, limit);
}

export function nqaAdminRuntimeStaticConfig(env: Environment = process.env) {
  return {
    target: NQA_AUTOLINK_LIVE_TARGET,
    sheetReadTokenConfigured: Boolean(env[SHEETS_READ_TOKEN_ENV]?.trim()),
    sheetReadScopeReady: parseScopes(env[SHEETS_READ_SCOPES_ENV]).has(
      NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE
    ),
    writebackEnabled: env[ADMIN_WRITEBACK_ENABLED_ENV] === "true",
    writeTokenConfigured: Boolean(env[SHEETS_WRITE_TOKEN_ENV]?.trim()),
    writeScopeReady: parseScopes(env[SHEETS_WRITE_SCOPES_ENV]).has(
      FULL_SHEETS_SCOPE
    ),
  };
}

export function hashNqaAdminWriteback(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: "nqa-admin-writeback-preview-v1",
        input,
      })
    )
    .digest("hex");
}
