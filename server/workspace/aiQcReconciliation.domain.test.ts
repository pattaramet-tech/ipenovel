import { describe, expect, it } from "vitest";
import { deriveAiQcOperationalState } from "./aiQcReconciliation.domain";

const receipt = "receipt-1";
const attempt = (overrides: Partial<any> = {}) => ({
  id: 1,
  attemptNo: 1,
  status: "running" as const,
  leaseExpiresAt: new Date("2026-09-08T08:10:00Z"),
  providerRequestId: receipt,
  errorClass: null,
  ...overrides,
});

describe("M04-C AI QC operational derivation", () => {
  it("keeps a receipt-bearing live lease active, then requires recovery after expiry", () => {
    const active = deriveAiQcOperationalState({
      jobStatus: "running",
      attempts: [attempt()],
      artifacts: [],
      now: new Date("2026-09-08T08:09:00Z"),
    });
    expect(active.state).toBe("active");
    expect(active.recoveryRequired).toBe(false);

    const expired = deriveAiQcOperationalState({
      jobStatus: "running",
      attempts: [attempt()],
      artifacts: [],
      now: new Date("2026-09-08T08:11:00Z"),
    });
    expect(expired.state).toBe("receipt_recovery_needed");
    expect(expired.canonicalProviderRequestId).toBe(receipt);
  });

  it("flags multiple provider receipts as inconsistent and recognizes a complete success", () => {
    const inconsistent = deriveAiQcOperationalState({
      jobStatus: "failed",
      attempts: [attempt({ status: "failed" }), attempt({ id: 2, attemptNo: 2, status: "failed", providerRequestId: "receipt-2" })],
      artifacts: [],
    });
    expect(inconsistent.state).toBe("inconsistent");

    const succeeded = deriveAiQcOperationalState({
      jobStatus: "succeeded",
      attempts: [attempt({ status: "succeeded", leaseExpiresAt: new Date("2026-09-08T08:00:00Z") })],
      artifacts: [{ attemptId: 1, artifactType: "qc_findings_v1", contentObjectKey: "k", contentSha256: "a".repeat(64) }],
      now: new Date("2026-09-08T08:20:00Z"),
    });
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.successfulQcArtifactCount).toBe(1);
  });
});
