import { createHash, randomUUID } from "node:crypto";

import {
  NQA_V1_ENABLED_PERMISSION_TIERS,
  type NqaPermissionTier,
} from "../controlPlane";
import { JsonlNqaAdminGatewayAuditSink } from "./audit";
import type {
  NqaAuthenticatedPrincipal,
  NqaGatewayResponse,
} from "../mcp/contracts";
import { NqaMcpGateway } from "../mcp/gateway";
import {
  NqaGatewayHandlerRegistry,
  type NqaGatewayHandlerContext,
} from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import { GoogleRestReadOnlyTransport } from "../google/transport";
import { NQA_AUTOLINK_LIVE_TARGET } from "../../workspace/nqaAutolink.runtime";
import type {
  NqaAdminRun,
  NqaAdminWritebackColumn,
  NqaAdminWritebackPreview,
} from "./contracts";
import { JsonNqaAdminRunStore } from "./store";
import { hashNqaAdminWriteback, nqaAdminRuntimeStaticConfig } from "./runtime";

const READ_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN";
const WRITE_TOKEN_ENV = "NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN";
const WRITEBACK_ENABLED_ENV = "NQA_ADMIN_WRITEBACK_ENABLED";

type Environment = Record<string, string | undefined>;

export class NqaAdminWritebackError extends Error {
  constructor(
    readonly code:
      | "ROW_NOT_COMPLETE"
      | "WRITEBACK_DISABLED"
      | "WRITE_CREDENTIAL_MISSING"
      | "WRITE_SCOPE_MISSING"
      | "PREVIEW_STALE"
      | "CONFIRMATION_MISMATCH"
      | "WRITE_FAILED"
      | "WRITE_VERIFY_FAILED",
    message: string
  ) {
    super(message);
    this.name = "NqaAdminWritebackError";
  }
}

function quoteSheetName(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function rowResults(run: NqaAdminRun, row: number) {
  return run.results.filter(result => result.row === row);
}

function assertRowComplete(run: NqaAdminRun, row: number) {
  const plan = run.rows.find(candidate => candidate.row === row);
  if (!plan || !plan.eligible || plan.chapters.length === 0) {
    throw new NqaAdminWritebackError(
      "ROW_NOT_COMPLETE",
      "Selected row is not an eligible NQA run row."
    );
  }
  const results = rowResults(run, row);
  const completed = new Set(results.map(result => result.chapter));
  if (plan.chapters.some(chapter => !completed.has(chapter))) {
    throw new NqaAdminWritebackError(
      "ROW_NOT_COMPLETE",
      "Selected row has not completed all planned chapters."
    );
  }
  return { plan, results };
}

function counts(results: ReturnType<typeof rowResults>) {
  const value = {
    PASS: 0,
    REVIEW: 0,
    MISMATCH: 0,
    INSUFFICIENT: 0,
  };
  for (const result of results) value[result.displayDecision] += 1;
  return value;
}

function preserveFreeMarker(
  currentValue: string,
  proposedValue: string
): string {
  if (/\bฟรี\b/.test(currentValue) && !/\bฟรี\b/.test(proposedValue)) {
    return proposedValue + " ฟรี";
  }
  return proposedValue;
}

function columnLValue(run: NqaAdminRun, row: number, currentValue: string) {
  const { results } = assertRowComplete(run, row);
  const summary = counts(results);
  let value: string;

  if (run.mode === "FULL_QA") {
    value =
      summary.PASS === results.length
        ? "พิสูจน์ความใกล้เคียงเนื้อหา=ผ่าน " + results.length + " บท"
        : [
            "Full QA:",
            "PASS " + summary.PASS,
            "REVIEW " + summary.REVIEW,
            "MISMATCH " + summary.MISMATCH,
            "INSUFFICIENT " + summary.INSUFFICIENT,
          ].join(" ");
  } else {
    const issueCount = results.length - summary.PASS;
    value =
      issueCount === 0
        ? "QC=ผ่าน " + results.length + " บท"
        : "QC: ผ่าน " + summary.PASS + " บท, พบประเด็น " + issueCount + " บท";
  }

  return preserveFreeMarker(currentValue, value);
}

function columnMValue(run: NqaAdminRun, row: number) {
  const { results } = assertRowComplete(run, row);
  const issues = results.filter(result => result.displayDecision !== "PASS");
  if (issues.length === 0) return "";

  return (
    "NQA หมายเหตุ: " +
    issues
      .slice(0, 20)
      .map(result => {
        const reasons = result.reasonCodes.slice(0, 3).join("/");
        return (
          "บท " +
          result.chapter +
          " " +
          result.displayDecision +
          (reasons ? " (" + reasons + ")" : "")
        );
      })
      .join("; ")
  ).slice(0, 2_000);
}

async function readCurrentCell(
  row: number,
  column: NqaAdminWritebackColumn,
  env: Environment
): Promise<string> {
  const transport = new GoogleRestReadOnlyTransport({
    accessTokenProvider: () => env[READ_TOKEN_ENV] ?? "",
  });
  const range =
    quoteSheetName(NQA_AUTOLINK_LIVE_TARGET.sheetName) + "!" + column + row;
  const [response] = await transport.batchGetValues({
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    ranges: [range],
  });
  return String(response?.values?.[0]?.[0] ?? "").trim();
}

async function buildPreview(input: {
  actorUserId: number;
  runId: string;
  row: number;
  column: NqaAdminWritebackColumn;
  env: Environment;
}): Promise<NqaAdminWritebackPreview> {
  const run = await new JsonNqaAdminRunStore(input.env).get(
    input.runId,
    input.actorUserId
  );
  const currentValue = await readCurrentCell(
    input.row,
    input.column,
    input.env
  );
  const value =
    input.column === "L"
      ? columnLValue(run, input.row, currentValue)
      : columnMValue(run, input.row);

  const fingerprint = hashNqaAdminWriteback({
    runId: input.runId,
    runUpdatedAt: run.updatedAt,
    row: input.row,
    column: input.column,
    value,
    currentValue,
  });
  return {
    version: "nqa-admin-writeback-preview-v1",
    runId: input.runId,
    row: input.row,
    column: input.column,
    value,
    fingerprint,
    confirmation:
      "CONFIRM NQA WRITEBACK ROW " + input.row + " COLUMN " + input.column,
  };
}

function requiredTarget(context: NqaGatewayHandlerContext) {
  if (!context.target.runId || !context.target.row || !context.target.column) {
    throw new Error("NQA writeback requires runId, row and column.");
  }
  return {
    runId: context.target.runId,
    row: context.target.row,
    column: context.target.column,
    confirmation: context.target.confirmation ?? null,
  };
}

async function writeAndVerify(input: {
  token: string;
  row: number;
  column: NqaAdminWritebackColumn;
  value: string;
}) {
  const range =
    quoteSheetName(NQA_AUTOLINK_LIVE_TARGET.sheetName) +
    "!" +
    input.column +
    input.row;
  const endpoint =
    "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(NQA_AUTOLINK_LIVE_TARGET.spreadsheetId) +
    "/values/" +
    encodeURIComponent(range) +
    "?valueInputOption=RAW";

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + input.token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      range,
      majorDimension: "ROWS",
      values: [[input.value]],
    }),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new NqaAdminWritebackError(
      "WRITE_FAILED",
      "Google Sheets writeback failed."
    );
  }

  const verifyTransport = new GoogleRestReadOnlyTransport({
    accessTokenProvider: () => input.token,
  });
  const [verified] = await verifyTransport.batchGetValues({
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    ranges: [range],
  });
  const actual = String(verified?.values?.[0]?.[0] ?? "");
  if (actual !== input.value) {
    throw new NqaAdminWritebackError(
      "WRITE_VERIFY_FAILED",
      "Google Sheets writeback verification did not match the preview."
    );
  }
}

function enabledTiers(env: Environment): readonly NqaPermissionTier[] {
  return env[WRITEBACK_ENABLED_ENV] === "true"
    ? [...NQA_V1_ENABLED_PERMISSION_TIERS, "REMEDIATION"]
    : NQA_V1_ENABLED_PERMISSION_TIERS;
}

function principal(
  actorUserId: number,
  requestId: string
): NqaAuthenticatedPrincipal {
  return {
    principalId: "nqa-admin:" + actorUserId,
    sessionId: "nqa-admin-writeback:" + requestId,
    permissions: ["READ", "REMEDIATION"],
    authenticated: true,
  };
}

function responseResult<T>(response: NqaGatewayResponse): T {
  if (response.status === "ERROR") {
    throw new NqaAdminWritebackError(
      response.error?.code === "TIER_DISABLED"
        ? "WRITEBACK_DISABLED"
        : "WRITE_FAILED",
      "NQA writeback gateway rejected the request: " +
        (response.error?.code ?? "UNKNOWN")
    );
  }
  return response.result as T;
}

function buildGateway(actorUserId: number, env: Environment) {
  const previewHandler = async (context: NqaGatewayHandlerContext) => {
    const target = requiredTarget(context);
    return await buildPreview({
      actorUserId,
      runId: target.runId,
      row: target.row,
      column: target.column,
      env,
    });
  };

  const confirmHandler = async (context: NqaGatewayHandlerContext) => {
    const target = requiredTarget(context);
    const config = nqaAdminRuntimeStaticConfig(env);
    if (!config.writebackEnabled) {
      throw new NqaAdminWritebackError(
        "WRITEBACK_DISABLED",
        "NQA Admin writeback is disabled."
      );
    }
    if (!config.writeTokenConfigured) {
      throw new NqaAdminWritebackError(
        "WRITE_CREDENTIAL_MISSING",
        "NQA writeback credential is missing."
      );
    }
    if (!config.writeScopeReady) {
      throw new NqaAdminWritebackError(
        "WRITE_SCOPE_MISSING",
        "NQA writeback credential is missing the full Sheets scope."
      );
    }

    const preview = await buildPreview({
      actorUserId,
      runId: target.runId,
      row: target.row,
      column: target.column,
      env,
    });
    if (context.inputFingerprint !== preview.fingerprint) {
      throw new NqaAdminWritebackError(
        "PREVIEW_STALE",
        "NQA writeback preview is stale."
      );
    }
    if (target.confirmation !== preview.confirmation) {
      throw new NqaAdminWritebackError(
        "CONFIRMATION_MISMATCH",
        "NQA writeback confirmation phrase does not match."
      );
    }

    const token = env[WRITE_TOKEN_ENV]?.trim() ?? "";
    await writeAndVerify({
      token,
      row: target.row,
      column: target.column,
      value: preview.value,
    });

    const store = new JsonNqaAdminRunStore(env);
    const run = await store.get(target.runId, actorUserId);
    const record = {
      column: target.column,
      row: target.row,
      fingerprint: preview.fingerprint,
      valueSha256: createHash("sha256")
        .update(preview.value, "utf8")
        .digest("hex"),
      confirmedAt: new Date().toISOString(),
      requestId: context.requestId,
      correlationId: context.correlationId,
    };
    run.writebacks = [...(run.writebacks ?? []), record];
    run.updatedAt = new Date().toISOString();
    await store.save(run);

    return {
      status: "VERIFIED",
      runId: target.runId,
      row: target.row,
      column: target.column,
      fingerprint: preview.fingerprint,
      valueSha256: record.valueSha256,
    };
  };

  return new NqaMcpGateway({
    handlers: new NqaGatewayHandlerRegistry({
      "nqa.result.writeback_preview": previewHandler,
      "nqa.result.writeback_confirm": confirmHandler,
    }),
    idempotencyStore: new InMemoryNqaIdempotencyStore(),
    auditSink: new JsonlNqaAdminGatewayAuditSink(env),
    enabledPermissionTiers: enabledTiers(env),
  });
}

export async function previewNqaAdminWriteback(input: {
  actorUserId: number;
  runId: string;
  row: number;
  column: NqaAdminWritebackColumn;
  env?: Environment;
}): Promise<{
  preview: NqaAdminWritebackPreview;
  requestId: string;
  correlationId: string;
  auditRef: string;
}> {
  const env = input.env ?? process.env;
  const requestId = randomUUID();
  const correlationId =
    input.runId + ":writeback-preview:" + input.row + ":" + input.column;
  const response = await buildGateway(input.actorUserId, env).dispatch({
    principal: principal(input.actorUserId, requestId),
    request: {
      requestId,
      correlationId,
      actorId: "nqa-admin:" + input.actorUserId,
      capability: "nqa.result.writeback_preview",
      target: {
        runId: input.runId,
        row: input.row,
        column: input.column,
      },
      idempotencyKey: null,
      inputFingerprint: null,
      requestedAt: new Date().toISOString(),
    },
  });
  return {
    preview: responseResult<NqaAdminWritebackPreview>(response),
    requestId: response.requestId,
    correlationId: response.correlationId,
    auditRef: response.auditRef,
  };
}

export async function confirmNqaAdminWriteback(input: {
  actorUserId: number;
  runId: string;
  row: number;
  column: NqaAdminWritebackColumn;
  previewFingerprint: string;
  confirmation: string;
  env?: Environment;
}) {
  const env = input.env ?? process.env;
  const requestId = randomUUID();
  const correlationId =
    input.runId + ":writeback-confirm:" + input.row + ":" + input.column;
  const response = await buildGateway(input.actorUserId, env).dispatch({
    principal: principal(input.actorUserId, requestId),
    request: {
      requestId,
      correlationId,
      actorId: "nqa-admin:" + input.actorUserId,
      capability: "nqa.result.writeback_confirm",
      target: {
        runId: input.runId,
        row: input.row,
        column: input.column,
        confirmation: input.confirmation,
      },
      idempotencyKey: createHash("sha256")
        .update(
          input.runId +
            ":" +
            input.row +
            ":" +
            input.column +
            ":" +
            input.previewFingerprint
        )
        .digest("hex"),
      inputFingerprint: input.previewFingerprint,
      requestedAt: new Date().toISOString(),
    },
  });
  return {
    result: responseResult(response),
    requestId: response.requestId,
    correlationId: response.correlationId,
    auditRef: response.auditRef,
  };
}
