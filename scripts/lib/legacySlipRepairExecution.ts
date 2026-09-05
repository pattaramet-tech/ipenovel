import {
  isPrivateInputPath,
  readPrivateRepairInput,
  requirePrivateLinux,
} from "./legacySlipRepairPrivateInput";
import {
  parseRepairPlan,
  parsePrivateRepairJson,
  parseOperatorAttestationBytes,
  PINNED_REPAIR_PLAN_SHA256,
} from "./legacySlipRepairContract";
import {
  validateLegacySlipAuditEnvironment,
  type LegacySlipAuditEnvironment,
} from "./legacySlipAuditOptions";
import { dryRunLegacySlipRepair } from "./legacySlipRepairDryRun";
import type { RelinkReaders } from "./legacySlipRelinkPlan";
import type {
  RepairAuthorityInput,
  RepairWriterInput,
  RepairWriterResult,
} from "./legacySlipRepairWriter";

/** Reviewed source-code release switch, NOT an env/CLI/operator override.
 * Remains false until real Linux/MariaDB gates and a separate release review. */
export const LEGACY_REPAIR_EXECUTION_RELEASED = false;

export interface RepairExecutionArgs {
  mode: "execute" | "reconcile";
  plan: string;
  attestation: string;
  review: string;
  authorization: string;
  codeSha: string;
}
export class RepairExecutionError extends Error {
  constructor(readonly code: "INVALID_EXECUTION_ARGUMENTS") {
    super(code);
  }
}

/** Syntax only, before environment, private files or network access. */
export function parseRepairExecutionArgs(
  argv: readonly string[]
): RepairExecutionArgs | { mode: "help" } {
  const invalid = (): never => {
    throw new RepairExecutionError("INVALID_EXECUTION_ARGUMENTS");
  };
  if (argv.length === 1 && argv[0] === "--help") return { mode: "help" };
  if (argv.length !== 7) return invalid();
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (const token of argv) {
    if (
      token === "--execute" ||
      token === "--reconcile" ||
      token === "--confirm-preview"
    ) {
      if (switches.has(token)) return invalid();
      switches.add(token);
      continue;
    }
    const match =
      /^--(plan|attestation|review|authorization|code-sha)=(.+)$/.exec(token);
    if (!match || Object.hasOwn(values, match[1])) return invalid();
    values[match[1]] = match[2];
  }
  if (
    switches.size !== 2 ||
    !switches.has("--confirm-preview") ||
    Object.keys(values).length !== 5
  )
    return invalid();
  for (const key of ["plan", "attestation", "review", "authorization"])
    if (!isPrivateInputPath(values[key])) return invalid();
  if (!/^[a-f0-9]{40}$/.test(values["code-sha"])) return invalid();
  // Four distinct artifacts; never conflate a reviewed record and permission.
  if (
    new Set([
      values.plan,
      values.attestation,
      values.review,
      values.authorization,
    ]).size !== 4
  )
    return invalid();
  return {
    mode: switches.has("--execute") ? "execute" : "reconcile",
    plan: values.plan,
    attestation: values.attestation,
    review: values.review,
    authorization: values.authorization,
    codeSha: values["code-sha"],
  };
}

const COMMON = {
  type: "summary",
  mode: "repair-execution",
  sourceType: "order_payment",
  sourceId: 11280001,
  objectWrites: 0,
  historicalByteIdentity: "UNPROVEN",
  historicalCoverageComplete: false,
  automaticRetry: false,
} as const;
function blocked(code: string) {
  return {
    ...COMMON,
    status: "BLOCKED" as const,
    code,
    committedDatabaseWrites: 0,
    writerInvoked: false,
    nextAction: "STOP_AND_REVIEW",
  };
}
export function repairExecutionDisabledSummary(codeSha: string) {
  return {
    ...blocked("LIVE_EXECUTION_RELEASE_GATE_DISABLED"),
    writeAuthorized: false,
    liveApplyAvailable: false,
    declaredCodeSha: codeSha,
    codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED",
  };
}

type Readers = RelinkReaders & { close(): void };
export interface RepairExecutionDependencies {
  requireLinux?: () => unknown;
  readPrivate?: typeof readPrivateRepairInput;
  environment?: () => NodeJS.ProcessEnv;
  createReaders?: (config: LegacySlipAuditEnvironment) => Readers;
  executeWriter?: (
    input: RepairWriterInput,
    config: LegacySlipAuditEnvironment
  ) => Promise<RepairWriterResult>;
  now?: () => number;
  monotonicNow?: () => number;
}

/** Candidate workflow, deliberately NOT released to operators yet. The CLI
 * source gate rejects before calling this. Dependencies exist for synthetic
 * tests, never operator-provided flags, target/pin overrides or release bypass.
 * JSON establishes record consistency, not human identity or actual freeze.
 */
export async function runPreparedLegacySlipRepairExecution(
  args: RepairExecutionArgs,
  dependencies: RepairExecutionDependencies = {}
) {
  if (args.mode !== "execute") return blocked("INVALID_EXECUTION_MODE");
  const read = dependencies.readPrivate ?? readPrivateRepairInput;
  const now = dependencies.now ?? Date.now;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  let stage = "PRIVATE_INPUT_REJECTED";
  let writerInvoked = false;
  try {
    (dependencies.requireLinux ?? requirePrivateLinux)();
    // Own each bounded byte buffer immediately; no caller can change an earlier
    // artifact while another private-file read is in flight.
    const planBytes = Buffer.from(await read(args.plan, 8 * 1024 * 1024));
    const intent = parseRepairPlan(planBytes, PINNED_REPAIR_PLAN_SHA256);
    const operatorAttestationBytes = Buffer.from(
      await read(args.attestation, 64 * 1024)
    );
    const attestation = parseOperatorAttestationBytes(
      operatorAttestationBytes,
      intent
    );
    const reviewBytes = Buffer.from(await read(args.review, 64 * 1024));
    const secondReview = parsePrivateRepairJson(reviewBytes, 64 * 1024);
    const authorizationBytes = Buffer.from(
      await read(args.authorization, 64 * 1024)
    );
    const authorization = parsePrivateRepairJson(authorizationBytes, 64 * 1024);
    stage = "ENVIRONMENT_REJECTED";
    const config = validateLegacySlipAuditEnvironment(
      (dependencies.environment ?? (() => process.env))()
    );
    const { validateRepairAuthority, executeLegacySlipRepair } =
      await import("./legacySlipRepairWriter");
    stage = "AUTHORITY_REJECTED";
    const validated = validateRepairAuthority(
      {
        intent,
        planBytes,
        operatorAttestationBytes,
        secondReview,
        authorization,
      } as RepairAuthorityInput,
      config,
      now
    );
    const { relinkTargetFingerprint, createRelinkReaders } =
      await import("./legacySlipRelinkPlan");
    validated.checkFresh();

    // Wall time starts BEFORE client creation and first read. Never timestamp
    // slow old observations as fresh after their completion. Monotonic time
    // independently bounds the window if the system clock moves backwards.
    const startedAt = now();
    const startedMono = monotonicNow();
    const expiresAt = Math.min(
      startedAt + 60_000,
      Date.parse(validated.input.authorization.expiresAt),
      Date.parse(validated.input.authorization.maintenance.expiresAt)
    );
    const checkFresh = () => {
      validated.checkFresh();
      const wall = now(),
        elapsed = monotonicNow() - startedMono;
      if (
        !Number.isFinite(wall) ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        wall < startedAt ||
        wall >= expiresAt ||
        elapsed >= 60_000
      )
        throw new Error("PREFLIGHT_WINDOW_EXPIRED");
    };
    stage = "PREFLIGHT_REJECTED";
    checkFresh();
    const readers = (dependencies.createReaders ?? createRelinkReaders)(config);
    let preflightResult;
    try {
      const guard = async <T>(work: () => Promise<T>): Promise<T> => {
        checkFresh();
        const value = await work();
        checkFresh();
        return value;
      };
      preflightResult = await dryRunLegacySlipRepair(
        validated.intent,
        attestation,
        {
          readSource: target => guard(() => readers.readSource(target)),
          listCandidate: target => guard(() => readers.listCandidate(target)),
          readCandidate: candidate =>
            guard(() => readers.readCandidate(candidate)),
          readCrossReferences: input =>
            guard(() => readers.readCrossReferences(input)),
        },
        {
          targetFingerprint: relinkTargetFingerprint(config),
          now: monotonicNow,
        }
      );
    } finally {
      // No R2 client remains open when entering the locking writer.
      readers.close();
    }
    checkFresh();
    if (preflightResult.status !== "DRY_RUN_MATCH")
      return blocked("FRESH_PREFLIGHT_DID_NOT_MATCH");
    const input: RepairWriterInput = {
      ...validated.input,
      preflight: {
        intentSha256: validated.intent.intentSha256,
        targetFingerprint: validated.intent.targetFingerprint,
        checkedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        candidate: structuredClone(validated.intent.candidate),
        allCrossReferencesClear: true,
      },
    };
    checkFresh();
    writerInvoked = true;
    const result = await (
      dependencies.executeWriter ?? executeLegacySlipRepair
    )(input, config);
    return sanitizeWriterResult(result);
  } catch {
    // After dispatch, a thrown writer cannot prove that it did not commit.
    return writerInvoked ? unknownResult() : blocked(stage);
  }
}

/** Supported read-only inspection of retained original operation records. No
 * execution release bypass: this does not create preflight, write, or retry. */
export async function runLegacySlipRepairReconciliation(
  args: RepairExecutionArgs,
  dependencies: Pick<
    RepairExecutionDependencies,
    "requireLinux" | "readPrivate" | "environment"
  > = {}
) {
  const base = {
    ...COMMON,
    mode: "repair-reconciliation",
    databaseWrites: 0,
    writeAuthorized: false,
    liveApplyAvailable: false,
    nextAction: "STOP_NO_AUTOMATIC_RETRY",
  } as const;
  if (args.mode !== "reconcile")
    return { ...base, status: "BLOCKED", code: "INVALID_RECONCILIATION_MODE" };
  try {
    (dependencies.requireLinux ?? requirePrivateLinux)();
    const read = dependencies.readPrivate ?? readPrivateRepairInput;
    const planBytes = Buffer.from(await read(args.plan, 8 * 1024 * 1024));
    const intent = parseRepairPlan(planBytes, PINNED_REPAIR_PLAN_SHA256);
    const operatorAttestationBytes = Buffer.from(
      await read(args.attestation, 64 * 1024)
    );
    parseOperatorAttestationBytes(operatorAttestationBytes, intent);
    const secondReview = parsePrivateRepairJson(
      Buffer.from(await read(args.review, 64 * 1024)),
      64 * 1024
    );
    const authorization = parsePrivateRepairJson(
      Buffer.from(await read(args.authorization, 64 * 1024)),
      64 * 1024
    );
    const config = validateLegacySlipAuditEnvironment(
      (dependencies.environment ?? (() => process.env))()
    );
    const { reconcileLegacySlipRepair } =
      await import("./legacySlipRepairReconciliation");
    const result = await reconcileLegacySlipRepair(
      {
        intent,
        planBytes,
        operatorAttestationBytes,
        secondReview,
        authorization,
      } as RepairAuthorityInput,
      config
    );
    const statuses = [
      "MATCHING_AUDIT_AND_STATE",
      "NO_COMMIT_EVIDENCE",
      "CONFLICT",
      "UNKNOWN",
      "BLOCKED",
    ];
    const status = statuses.includes(result.status) ? result.status : "UNKNOWN";
    return { ...base, status, code: `READ_ONLY_${status}` };
  } catch {
    return {
      ...base,
      status: "BLOCKED",
      code: "RECONCILIATION_INPUT_OR_READ_FAILED",
    };
  }
}

function unknownResult() {
  return {
    ...COMMON,
    status: "UNKNOWN" as const,
    code: "WRITER_OUTCOME_UNKNOWN",
    committedDatabaseWrites: null,
    writerInvoked: true,
    nextAction: "STOP_AND_RECONCILE_READ_ONLY_NO_RETRY",
  };
}
function sanitizeWriterResult(result: RepairWriterResult) {
  // Do not spread raw errors or arbitrary dependency-returned fields/codes.
  if (
    result.status === "APPLIED" &&
    result.code === "REFERENCE_AND_PRIVATE_AUDIT_COMMITTED"
  )
    return {
      ...COMMON,
      status: "APPLIED" as const,
      code: result.code,
      committedDatabaseWrites: 2,
      writerInvoked: true,
      nextAction: "STOP_AND_INDEPENDENTLY_VERIFY",
    };
  if (
    result.status === "ALREADY_APPLIED" &&
    result.code === "EXACT_AUDIT_AND_AFTER_IMAGE_MATCH"
  )
    return {
      ...COMMON,
      status: "ALREADY_APPLIED" as const,
      code: result.code,
      committedDatabaseWrites: 0,
      writerInvoked: true,
      nextAction: "STOP_AND_INDEPENDENTLY_VERIFY",
    };
  if (result.status === "BLOCKED" || result.status === "ROLLED_BACK")
    return {
      ...COMMON,
      status: result.status,
      code:
        result.status === "BLOCKED"
          ? "WRITER_BLOCKED"
          : "WRITER_ROLLBACK_CONFIRMED",
      committedDatabaseWrites: 0,
      writerInvoked: true,
      nextAction: "STOP_AND_REVIEW",
    };
  const reconciliation = [
    "MATCHING_AUDIT_AND_STATE",
    "NO_COMMIT_EVIDENCE",
    "CONFLICT",
    "FAILED",
  ].includes(result.reconciliation ?? "")
    ? result.reconciliation
    : undefined;
  return { ...unknownResult(), ...(reconciliation ? { reconciliation } : {}) };
}
