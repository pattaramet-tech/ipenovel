export type WorkspaceAiQcOperationalState =
  | "queued"
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "receipt_recovery_needed"
  | "inconsistent";

export interface WorkspaceAiQcOperationalAttempt {
  id: number;
  attemptNo: number;
  status: "claimed" | "running" | "succeeded" | "failed" | "abandoned";
  leaseExpiresAt: Date;
  providerRequestId: string | null;
  errorClass: string | null;
}

export interface WorkspaceAiQcOperationalArtifact {
  attemptId: number;
  artifactType: string;
  contentObjectKey: string;
  contentSha256: string;
}

export function deriveAiQcOperationalState(input: {
  jobStatus: "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: WorkspaceAiQcOperationalAttempt[];
  artifacts: WorkspaceAiQcOperationalArtifact[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const attempts = [...input.attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const latestAttempt = attempts.at(-1) ?? null;
  const qcArtifacts = input.artifacts.filter(artifact => artifact.artifactType === "qc_findings_v1");
  const receiptAttempts = attempts.filter(attempt => Boolean(attempt.providerRequestId));
  const receiptIds = Array.from(new Set(
    receiptAttempts.map(attempt => attempt.providerRequestId).filter((value): value is string => Boolean(value))
  ));
  const succeededAttemptIds = new Set(attempts.filter(attempt => attempt.status === "succeeded").map(attempt => attempt.id));
  const successfulArtifacts = qcArtifacts.filter(artifact => succeededAttemptIds.has(artifact.attemptId));

  const inconsistent =
    receiptIds.length > 1 ||
    qcArtifacts.some(artifact => !attempts.some(attempt => attempt.id === artifact.attemptId)) ||
    qcArtifacts.some(artifact => !attempts.find(attempt => attempt.id === artifact.attemptId)?.providerRequestId) ||
    (input.jobStatus === "succeeded" && (successfulArtifacts.length === 0 || receiptIds.length !== 1));

  const hasActiveLease = Boolean(
    latestAttempt &&
    (latestAttempt.status === "claimed" || latestAttempt.status === "running") &&
    latestAttempt.leaseExpiresAt.getTime() > now.getTime()
  );

  let state: WorkspaceAiQcOperationalState;
  if (inconsistent) {
    state = "inconsistent";
  } else if (hasActiveLease) {
    state = "active";
  } else if (receiptIds.length === 1 && successfulArtifacts.length === 0) {
    state = "receipt_recovery_needed";
  } else if (input.jobStatus === "succeeded") {
    state = "succeeded";
  } else if (input.jobStatus === "cancelled") {
    state = "cancelled";
  } else if (input.jobStatus === "failed") {
    state = "failed";
  } else if (input.jobStatus === "queued") {
    state = "queued";
  } else if (latestAttempt && (latestAttempt.status === "claimed" || latestAttempt.status === "running")) {
    state = latestAttempt.leaseExpiresAt.getTime() <= now.getTime() ? "abandoned" : "active";
  } else {
    state = "abandoned";
  }

  return {
    state,
    latestAttempt,
    canonicalProviderRequestId: receiptIds.length === 1 ? receiptIds[0] : null,
    distinctProviderReceiptCount: receiptIds.length,
    attemptCount: attempts.length,
    artifactCount: input.artifacts.length,
    qcArtifactCount: qcArtifacts.length,
    successfulQcArtifactCount: successfulArtifacts.length,
    recoveryRequired: state === "receipt_recovery_needed",
  };
}
