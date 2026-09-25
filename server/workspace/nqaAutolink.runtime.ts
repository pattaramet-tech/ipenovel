import { randomUUID } from "node:crypto";

import {
  InMemoryNqaNovelIdAutolinkAuditStore,
  JsonFileNqaNovelIdAutolinkAuditStore,
  type NqaNovelIdAutolinkAuditStore,
} from "../nqa/autolink/audit";
import { DatabaseNqaNovelCatalogReader } from "../nqa/autolink/catalog";
import type {
  NqaNovelCatalogReader,
  NqaNovelIdSheetBackfillTransport,
} from "../nqa/autolink/contracts";
import {
  GoogleRestNovelIdSheetBackfillTransport,
  NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE,
} from "../nqa/autolink/googleTransport";
import { createNqaNovelIdAutolinkHandlers } from "../nqa/autolink/handlers";
import { NqaNovelIdAutolinkService } from "../nqa/autolink/service";
import {
  NQA_V1_ENABLED_PERMISSION_TIERS,
  type NqaPermissionTier,
} from "../nqa/controlPlane";
import {
  InMemoryNqaGatewayAuditSink,
  type NqaGatewayAuditSink,
} from "../nqa/mcp/audit";
import type {
  NqaGatewayResponse,
  NqaAuthenticatedPrincipal,
} from "../nqa/mcp/contracts";
import { NqaMcpGateway } from "../nqa/mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../nqa/mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../nqa/mcp/idempotency";

export const NQA_AUTOLINK_LIVE_TARGET = {
  spreadsheetId: "1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y",
  spreadsheetTitle: "รวมนิยาย",
  sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
} as const;

export const NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly" as const;

const CONFIGURED_SPREADSHEET_ID_ENV = "NQA_AUTOLINK_SPREADSHEET_ID";
const READ_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN";
const READ_SCOPES_ENV = "NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES";
const WRITE_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN";
const WRITE_SCOPES_ENV = "NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES";
const AUDIT_DIR_ENV = "NQA_AUTOLINK_AUDIT_DIR";
const REMEDIATION_ENABLED_ENV = "NQA_AUTOLINK_REMEDIATION_ENABLED";

export type WorkspaceNqaAutolinkBlocker =
  | "TARGET_SPREADSHEET_ID_NOT_CONFIGURED"
  | "TARGET_SPREADSHEET_ID_MISMATCH"
  | "READ_CREDENTIAL_MISSING"
  | "READ_SCOPE_MISSING"
  | "WRITE_CREDENTIAL_MISSING"
  | "WRITE_SCOPE_MISSING"
  | "READ_WRITE_CREDENTIALS_NOT_DISTINCT"
  | "AUDIT_DIR_MISSING"
  | "REMEDIATION_DISABLED";

export type WorkspaceNqaAutolinkRuntimeStatus = {
  target: typeof NQA_AUTOLINK_LIVE_TARGET;
  previewReady: boolean;
  confirmReady: boolean;
  remediationEnabled: boolean;
  readCredentialConfigured: boolean;
  readScopeReady: boolean;
  writeCredentialConfigured: boolean;
  writeScopeReady: boolean;
  credentialsDistinct: boolean;
  auditDirConfigured: boolean;
  previewBlockers: WorkspaceNqaAutolinkBlocker[];
  confirmBlockers: WorkspaceNqaAutolinkBlocker[];
};

type Environment = Record<string, string | undefined>;

type RuntimeDependencies = {
  env?: Environment;
  catalog?: NqaNovelCatalogReader;
  readTransport?: NqaNovelIdSheetBackfillTransport;
  writeTransport?: NqaNovelIdSheetBackfillTransport;
  auditStore?: NqaNovelIdAutolinkAuditStore;
  gatewayAuditSink?: NqaGatewayAuditSink;
  now?: () => string;
  requestIdFactory?: () => string;
};

export class WorkspaceNqaAutolinkRuntimeError extends Error {
  constructor(
    readonly code: "PREVIEW_RUNTIME_NOT_READY" | "CONFIRM_RUNTIME_NOT_READY",
    message: string,
    readonly blockers: readonly WorkspaceNqaAutolinkBlocker[]
  ) {
    super(message);
    this.name = "WorkspaceNqaAutolinkRuntimeError";
  }
}

function parseScopes(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/\s+/).filter(Boolean));
}

function hasScope(raw: string | undefined, required: string): boolean {
  return parseScopes(raw).has(required);
}

function nonEmpty(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return value ? value : null;
}

export function resolveWorkspaceNqaAutolinkRuntimeStatus(
  env: Environment = process.env
): WorkspaceNqaAutolinkRuntimeStatus {
  const configuredSpreadsheetId = nonEmpty(env[CONFIGURED_SPREADSHEET_ID_ENV]);
  const readToken = nonEmpty(env[READ_TOKEN_ENV]);
  const writeToken = nonEmpty(env[WRITE_TOKEN_ENV]);
  const auditDir = nonEmpty(env[AUDIT_DIR_ENV]);

  const targetConfigured = configuredSpreadsheetId !== null;
  const targetMatches =
    configuredSpreadsheetId === NQA_AUTOLINK_LIVE_TARGET.spreadsheetId;
  const readCredentialConfigured = readToken !== null;
  const readScopeReady = hasScope(
    env[READ_SCOPES_ENV],
    NQA_GOOGLE_NOVEL_ID_PREVIEW_SCOPE
  );
  const writeCredentialConfigured = writeToken !== null;
  const writeScopeReady = hasScope(
    env[WRITE_SCOPES_ENV],
    NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE
  );
  const credentialsDistinct =
    !readToken || !writeToken || readToken !== writeToken;
  const auditDirConfigured = auditDir !== null;
  const remediationEnabled = env[REMEDIATION_ENABLED_ENV] === "true";

  const sharedBlockers: WorkspaceNqaAutolinkBlocker[] = [];
  if (!targetConfigured) {
    sharedBlockers.push("TARGET_SPREADSHEET_ID_NOT_CONFIGURED");
  } else if (!targetMatches) {
    sharedBlockers.push("TARGET_SPREADSHEET_ID_MISMATCH");
  }
  if (!auditDirConfigured) sharedBlockers.push("AUDIT_DIR_MISSING");

  const previewBlockers = [...sharedBlockers];
  if (!readCredentialConfigured) {
    previewBlockers.push("READ_CREDENTIAL_MISSING");
  }
  if (!readScopeReady) previewBlockers.push("READ_SCOPE_MISSING");

  const confirmBlockers = [...sharedBlockers];
  if (!remediationEnabled) {
    confirmBlockers.push("REMEDIATION_DISABLED");
  }
  if (!writeCredentialConfigured) {
    confirmBlockers.push("WRITE_CREDENTIAL_MISSING");
  }
  if (!writeScopeReady) confirmBlockers.push("WRITE_SCOPE_MISSING");
  if (!credentialsDistinct) {
    confirmBlockers.push("READ_WRITE_CREDENTIALS_NOT_DISTINCT");
  }

  return {
    target: NQA_AUTOLINK_LIVE_TARGET,
    previewReady: previewBlockers.length === 0,
    confirmReady: confirmBlockers.length === 0,
    remediationEnabled,
    readCredentialConfigured,
    readScopeReady,
    writeCredentialConfigured,
    writeScopeReady,
    credentialsDistinct,
    auditDirConfigured,
    previewBlockers,
    confirmBlockers,
  };
}

function principal(
  actorUserId: number,
  requestId: string
): NqaAuthenticatedPrincipal {
  return {
    principalId: "workspace-admin:" + actorUserId,
    sessionId: "workspace-trpc:" + requestId,
    permissions: ["READ", "REMEDIATION"],
    authenticated: true,
  };
}

function enabledPermissionTiers(
  remediationEnabled: boolean
): readonly NqaPermissionTier[] {
  return remediationEnabled
    ? [...NQA_V1_ENABLED_PERMISSION_TIERS, "REMEDIATION"]
    : NQA_V1_ENABLED_PERMISSION_TIERS;
}

function requestEnvelope(input: {
  requestId: string;
  correlationId: string;
  actorId: string;
  capability: "nqa.novel_link.preview" | "nqa.novel_link.confirm_backfill";
  row: number;
  novelId?: number;
  previewFingerprint?: string;
  requestedAt: string;
}) {
  return {
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorId: input.actorId,
    capability: input.capability,
    target: {
      row: input.row,
      ...(input.novelId ? { novelId: String(input.novelId) } : {}),
    },
    idempotencyKey: null,
    inputFingerprint: input.previewFingerprint ?? null,
    requestedAt: input.requestedAt,
  };
}

export class WorkspaceNqaAutolinkRuntime {
  private readonly statusValue: WorkspaceNqaAutolinkRuntimeStatus;
  private readonly gateway: NqaMcpGateway;
  private readonly now: () => string;
  private readonly requestIdFactory: () => string;

  constructor(input: RuntimeDependencies = {}) {
    const env = input.env ?? process.env;
    this.statusValue = resolveWorkspaceNqaAutolinkRuntimeStatus(env);
    this.now = input.now ?? (() => new Date().toISOString());
    this.requestIdFactory = input.requestIdFactory ?? randomUUID;

    const auditDir = nonEmpty(env[AUDIT_DIR_ENV]);
    const auditStore =
      input.auditStore ??
      (auditDir
        ? new JsonFileNqaNovelIdAutolinkAuditStore(auditDir)
        : new InMemoryNqaNovelIdAutolinkAuditStore());

    const readTransport =
      input.readTransport ??
      new GoogleRestNovelIdSheetBackfillTransport({
        accessTokenProvider: () => env[READ_TOKEN_ENV] ?? "",
      });
    const writeTransport =
      input.writeTransport ??
      new GoogleRestNovelIdSheetBackfillTransport({
        accessTokenProvider: () => env[WRITE_TOKEN_ENV] ?? "",
      });
    const catalog = input.catalog ?? new DatabaseNqaNovelCatalogReader();

    const serviceConfig = {
      ...NQA_AUTOLINK_LIVE_TARGET,
      authorizationTtlSeconds: 300,
    };
    const previewService = new NqaNovelIdAutolinkService({
      transport: readTransport,
      catalog,
      auditStore,
      config: serviceConfig,
      now: this.now,
    });
    const confirmService = new NqaNovelIdAutolinkService({
      transport: writeTransport,
      catalog,
      auditStore,
      config: serviceConfig,
      now: this.now,
    });

    const previewHandlers = createNqaNovelIdAutolinkHandlers(previewService);
    const confirmHandlers = createNqaNovelIdAutolinkHandlers(confirmService);
    const handlers = new NqaGatewayHandlerRegistry({
      "nqa.novel_link.preview": previewHandlers["nqa.novel_link.preview"],
      "nqa.novel_link.confirm_backfill":
        confirmHandlers["nqa.novel_link.confirm_backfill"],
    });

    this.gateway = new NqaMcpGateway({
      handlers,
      idempotencyStore: new InMemoryNqaIdempotencyStore(),
      auditSink: input.gatewayAuditSink ?? new InMemoryNqaGatewayAuditSink(),
      enabledPermissionTiers: enabledPermissionTiers(
        this.statusValue.remediationEnabled
      ),
      now: this.now,
    });
  }

  status(): WorkspaceNqaAutolinkRuntimeStatus {
    return structuredClone(this.statusValue);
  }

  async preview(input: {
    actorUserId: number;
    row: number;
    correlationId?: string;
  }): Promise<NqaGatewayResponse> {
    if (!this.statusValue.previewReady) {
      throw new WorkspaceNqaAutolinkRuntimeError(
        "PREVIEW_RUNTIME_NOT_READY",
        "NQA Novel ID Auto-Link preview runtime is not ready.",
        this.statusValue.previewBlockers
      );
    }

    const requestId = this.requestIdFactory();
    return await this.gateway.dispatch({
      principal: principal(input.actorUserId, requestId),
      request: requestEnvelope({
        requestId,
        correlationId: input.correlationId ?? requestId,
        actorId: "workspace-admin:" + input.actorUserId,
        capability: "nqa.novel_link.preview",
        row: input.row,
        requestedAt: this.now(),
      }),
    });
  }

  async confirmBackfill(input: {
    actorUserId: number;
    row: number;
    novelId: number;
    previewFingerprint: string;
    correlationId?: string;
  }): Promise<NqaGatewayResponse> {
    const requestId = this.requestIdFactory();

    if (!this.statusValue.remediationEnabled) {
      return await this.gateway.dispatch({
        principal: principal(input.actorUserId, requestId),
        request: requestEnvelope({
          requestId,
          correlationId: input.correlationId ?? requestId,
          actorId: "workspace-admin:" + input.actorUserId,
          capability: "nqa.novel_link.confirm_backfill",
          row: input.row,
          novelId: input.novelId,
          previewFingerprint: input.previewFingerprint,
          requestedAt: this.now(),
        }),
      });
    }

    if (!this.statusValue.confirmReady) {
      throw new WorkspaceNqaAutolinkRuntimeError(
        "CONFIRM_RUNTIME_NOT_READY",
        "NQA Novel ID Auto-Link confirmation runtime is not ready.",
        this.statusValue.confirmBlockers
      );
    }

    return await this.gateway.dispatch({
      principal: principal(input.actorUserId, requestId),
      request: requestEnvelope({
        requestId,
        correlationId: input.correlationId ?? requestId,
        actorId: "workspace-admin:" + input.actorUserId,
        capability: "nqa.novel_link.confirm_backfill",
        row: input.row,
        novelId: input.novelId,
        previewFingerprint: input.previewFingerprint,
        requestedAt: this.now(),
      }),
    });
  }
}

export function createWorkspaceNqaAutolinkRuntime(
  input: RuntimeDependencies = {}
): WorkspaceNqaAutolinkRuntime {
  return new WorkspaceNqaAutolinkRuntime(input);
}

export function getWorkspaceNqaAutolinkRuntime(): WorkspaceNqaAutolinkRuntime {
  return createWorkspaceNqaAutolinkRuntime();
}
