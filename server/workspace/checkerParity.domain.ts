import { createHash } from "node:crypto";

export const WORKSPACE_CHECKER_ENGINE_VERSION = "workspace-checker-snapshot-v1" as const;

export type CheckerSeverity = "info" | "warning" | "error";
export type SnapshotEvidenceField =
  | "byteLength"
  | "normalizationVersion"
  | "normalizedSha256"
  | "providerRevisionId";
export type SnapshotAssertionOperator = "eq" | "gte" | "lte" | "startsWith";

export interface CheckerSnapshotEvidence {
  id: number;
  providerRevisionId: string;
  normalizedSha256: string;
  normalizationVersion: number;
  byteLength: number;
}

export interface SnapshotAssertionRule {
  key: string;
  field: SnapshotEvidenceField;
  operator: SnapshotAssertionOperator;
  value: string | number;
  severity: CheckerSeverity;
  locationKey: string;
  message: string;
}

export interface CheckerRuleSetV1 {
  version: 1;
  failOn: "error";
  rules: SnapshotAssertionRule[];
}

export interface CheckerFindingInput {
  ruleKey: string;
  severity: CheckerSeverity;
  locationKey: string;
  excerptSha256: string;
  message: string;
}

export interface CheckerParityFinding {
  ruleKey: string;
  severity: CheckerSeverity;
  locationKey: string;
  excerptSha256: string;
}

export class CheckerRuleContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckerRuleContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CheckerRuleContractError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function parseRule(value: unknown, index: number): SnapshotAssertionRule {
  if (!isRecord(value)) {
    throw new CheckerRuleContractError(`rules[${index}] must be an object.`);
  }
  const key = requireString(value.key, `rules[${index}].key`);
  const field = value.field;
  if (!["byteLength", "normalizationVersion", "normalizedSha256", "providerRevisionId"].includes(String(field))) {
    throw new CheckerRuleContractError(`rules[${index}].field is unsupported.`);
  }
  const operator = value.operator;
  if (!["eq", "gte", "lte", "startsWith"].includes(String(operator))) {
    throw new CheckerRuleContractError(`rules[${index}].operator is unsupported.`);
  }
  const severity = value.severity;
  if (!["info", "warning", "error"].includes(String(severity))) {
    throw new CheckerRuleContractError(`rules[${index}].severity is unsupported.`);
  }
  const typedField = field as SnapshotEvidenceField;
  const typedOperator = operator as SnapshotAssertionOperator;
  const expected = value.value;
  const numericField = typedField === "byteLength" || typedField === "normalizationVersion";
  if (numericField) {
    if (typeof expected !== "number" || !Number.isFinite(expected)) {
      throw new CheckerRuleContractError(`rules[${index}].value must be numeric for ${typedField}.`);
    }
    if (typedOperator === "startsWith") {
      throw new CheckerRuleContractError(`rules[${index}] cannot use startsWith with ${typedField}.`);
    }
  } else {
    if (typeof expected !== "string") {
      throw new CheckerRuleContractError(`rules[${index}].value must be a string for ${typedField}.`);
    }
    if (typedOperator === "gte" || typedOperator === "lte") {
      throw new CheckerRuleContractError(`rules[${index}] cannot use ${typedOperator} with ${typedField}.`);
    }
  }
  return {
    key,
    field: typedField,
    operator: typedOperator,
    value: expected as string | number,
    severity: severity as CheckerSeverity,
    locationKey: requireString(value.locationKey, `rules[${index}].locationKey`),
    message: requireString(value.message, `rules[${index}].message`),
  };
}

export function parseCheckerRuleSet(rulesJson: string): CheckerRuleSetV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rulesJson);
  } catch {
    throw new CheckerRuleContractError("rulesJson must be valid JSON.");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.failOn !== "error" || !Array.isArray(parsed.rules)) {
    throw new CheckerRuleContractError("rulesJson must use checker rule-set contract version 1 with failOn=error.");
  }
  const rules = parsed.rules.map(parseRule);
  const keys = new Set<string>();
  for (const rule of rules) {
    if (keys.has(rule.key)) {
      throw new CheckerRuleContractError(`Duplicate checker rule key: ${rule.key}.`);
    }
    keys.add(rule.key);
  }
  return { version: 1, failOn: "error", rules };
}

function observedValue(snapshot: CheckerSnapshotEvidence, field: SnapshotEvidenceField): string | number {
  return snapshot[field];
}

function assertionPasses(actual: string | number, rule: SnapshotAssertionRule): boolean {
  switch (rule.operator) {
    case "eq":
      return actual === rule.value;
    case "gte":
      return typeof actual === "number" && typeof rule.value === "number" && actual >= rule.value;
    case "lte":
      return typeof actual === "number" && typeof rule.value === "number" && actual <= rule.value;
    case "startsWith":
      return typeof actual === "string" && typeof rule.value === "string" && actual.startsWith(rule.value);
  }
}

function evidenceHash(rule: SnapshotAssertionRule, actual: string | number): string {
  return createHash("sha256")
    .update(`workspace-checker-evidence-v1\0${rule.field}\0${String(actual)}`, "utf8")
    .digest("hex");
}

export function evaluateCheckerRuleSet(
  ruleSet: CheckerRuleSetV1,
  snapshot: CheckerSnapshotEvidence,
): { status: "passed" | "failed"; findings: CheckerFindingInput[] } {
  const findings = ruleSet.rules
    .filter(rule => !assertionPasses(observedValue(snapshot, rule.field), rule))
    .map(rule => {
      const actual = observedValue(snapshot, rule.field);
      return {
        ruleKey: rule.key,
        severity: rule.severity,
        locationKey: rule.locationKey,
        excerptSha256: evidenceHash(rule, actual),
        message: rule.message,
      } satisfies CheckerFindingInput;
    })
    .sort((a, b) =>
      a.ruleKey.localeCompare(b.ruleKey) ||
      a.locationKey.localeCompare(b.locationKey) ||
      a.excerptSha256.localeCompare(b.excerptSha256)
    );
  return {
    status: findings.some(finding => finding.severity === ruleSet.failOn) ? "failed" : "passed",
    findings,
  };
}

function semanticKey(finding: CheckerParityFinding): string {
  return `${finding.ruleKey}\0${finding.excerptSha256}`;
}

function countDuplicates(findings: readonly CheckerParityFinding[]): number {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${semanticKey(finding)}\0${finding.severity}\0${finding.locationKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  counts.forEach(count => {
    duplicates += Math.max(0, count - 1);
  });
  return duplicates;
}

export function compareCheckerParity(input: {
  legacy: readonly CheckerParityFinding[];
  workspace: readonly CheckerParityFinding[];
}) {
  const legacyByKey = new Map(input.legacy.map(finding => [semanticKey(finding), finding]));
  const workspaceByKey = new Map(input.workspace.map(finding => [semanticKey(finding), finding]));
  const missing: CheckerParityFinding[] = [];
  const unexpected: CheckerParityFinding[] = [];
  const severityMismatch: Array<{ legacy: CheckerParityFinding; workspace: CheckerParityFinding }> = [];
  const locationMismatch: Array<{ legacy: CheckerParityFinding; workspace: CheckerParityFinding }> = [];

  legacyByKey.forEach((legacy, key) => {
    const workspace = workspaceByKey.get(key);
    if (!workspace) {
      missing.push(legacy);
      return;
    }
    if (legacy.severity !== workspace.severity) severityMismatch.push({ legacy, workspace });
    if (legacy.locationKey !== workspace.locationKey) locationMismatch.push({ legacy, workspace });
  });
  workspaceByKey.forEach((workspace, key) => {
    if (!legacyByKey.has(key)) unexpected.push(workspace);
  });

  const duplicateLegacy = countDuplicates(input.legacy);
  const duplicateWorkspace = countDuplicates(input.workspace);
  return {
    pass:
      missing.length === 0 &&
      unexpected.length === 0 &&
      severityMismatch.length === 0 &&
      locationMismatch.length === 0 &&
      duplicateLegacy === 0 &&
      duplicateWorkspace === 0,
    missing,
    unexpected,
    severityMismatch,
    locationMismatch,
    duplicateLegacy,
    duplicateWorkspace,
  };
}
