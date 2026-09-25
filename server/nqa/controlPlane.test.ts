import { describe, expect, it } from "vitest";

import {
  InMemoryNqaAuditSink,
  NQA_CAPABILITIES,
  NQA_V1_ENABLED_PERMISSION_TIERS,
  authorizeAndAudit,
  authorizeNqaCapability,
} from "./controlPlane";

describe("NQA MCP control plane", () => {
  it("keeps the V1 runtime enabled tiers limited to READ and QA_OPERATE", () => {
    expect([...NQA_V1_ENABLED_PERMISSION_TIERS].sort()).toEqual([
      "QA_OPERATE",
      "READ",
    ]);

    const declaredPermissions = new Set(
      Object.values(NQA_CAPABILITIES).map(
        definition => definition.requiredPermission
      )
    );
    expect(declaredPermissions.has("PRODUCTION_MUTATION")).toBe(true);
  });

  it("allows a read capability with READ permission", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.chapter.extract",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("denies QA execution to a read-only actor", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.qa.run_semantic",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "MISSING_PERMISSION",
      requiredPermission: "QA_OPERATE",
    });
  });

  it("gates M14 review mutation while keeping curated export read-only", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.review.submit_action",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "MISSING_PERMISSION",
      requiredPermission: "QA_OPERATE",
    });

    expect(
      authorizeNqaCapability({
        capability: "nqa.review.submit_action",
        actorPermissions: ["QA_OPERATE"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });

    expect(
      authorizeNqaCapability({
        capability: "nqa.review.export_curated",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("keeps M15 calibration and promotion-gate capabilities read-only", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.calibration.evaluate",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });

    expect(
      authorizeNqaCapability({
        capability: "nqa.calibration.promotion_gate",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("keeps M16 candidate-policy capabilities read-only", () => {
    for (const capability of [
      "nqa.candidate_policy.materialize",
      "nqa.candidate_policy.shadow_revalidate",
      "nqa.candidate_policy.activation_readiness",
    ] as const) {
      expect(
        authorizeNqaCapability({
          capability,
          actorPermissions: ["READ"],
        })
      ).toMatchObject({ allowed: true, reason: "ALLOW" });
    }
  });

  it("keeps novel-id preview read-only and Column A backfill behind the disabled REMEDIATION tier", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.novel_link.preview",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });

    expect(
      authorizeNqaCapability({
        capability: "nqa.novel_link.confirm_backfill",
        actorPermissions: ["REMEDIATION"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "TIER_DISABLED",
      requiredPermission: "REMEDIATION",
    });

    expect(
      authorizeNqaCapability({
        capability: "nqa.novel_link.confirm_backfill",
        actorPermissions: ["REMEDIATION"],
        enabledPermissionTiers: ["READ", "QA_OPERATE", "REMEDIATION"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("keeps M17 policy switching disabled unless the production tier is explicitly enabled", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.policy.activate_candidate",
        actorPermissions: ["PRODUCTION_MUTATION"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "TIER_DISABLED",
      requiredPermission: "PRODUCTION_MUTATION",
    });

    expect(
      authorizeNqaCapability({
        capability: "nqa.policy.rollback",
        actorPermissions: ["PRODUCTION_MUTATION"],
        enabledPermissionTiers: ["READ", "QA_OPERATE", "PRODUCTION_MUTATION"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("keeps M19 soak evaluation read-only and scope expansion production-gated", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.evaluate_soak",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });

    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.expand_scope",
        actorPermissions: ["PRODUCTION_MUTATION"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "TIER_DISABLED",
      requiredPermission: "PRODUCTION_MUTATION",
    });

    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.expand_scope",
        actorPermissions: ["PRODUCTION_MUTATION"],
        enabledPermissionTiers: ["READ", "QA_OPERATE", "PRODUCTION_MUTATION"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("keeps M20 completion read-only and candidate finalization production-gated", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.evaluate_completion",
        actorPermissions: ["READ"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });

    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.finalize_candidate",
        actorPermissions: ["PRODUCTION_MUTATION"],
      })
    ).toMatchObject({
      allowed: false,
      reason: "TIER_DISABLED",
      requiredPermission: "PRODUCTION_MUTATION",
    });

    expect(
      authorizeNqaCapability({
        capability: "nqa.rollout.finalize_candidate",
        actorPermissions: ["PRODUCTION_MUTATION"],
        enabledPermissionTiers: ["READ", "QA_OPERATE", "PRODUCTION_MUTATION"],
      })
    ).toMatchObject({ allowed: true, reason: "ALLOW" });
  });

  it("fails closed for any capability not in the allowlist", () => {
    expect(
      authorizeNqaCapability({
        capability: "nqa.unregistered.operation",
        actorPermissions: ["READ", "QA_OPERATE"],
      })
    ).toEqual({
      allowed: false,
      capability: "nqa.unregistered.operation",
      requiredPermission: null,
      reason: "UNKNOWN_CAPABILITY",
    });
  });

  it("audits rejected requests without storing novel content payloads", async () => {
    const sink = new InMemoryNqaAuditSink();
    const decision = await authorizeAndAudit({
      request: {
        requestId: "req-1",
        correlationId: "corr-1",
        actorId: "chatgpt-session",
        capability: "nqa.unregistered.operation",
        target: { row: 1562, chapter: 197 },
        requestedAt: "2026-09-24T00:00:00+07:00",
      },
      actorPermissions: ["READ", "QA_OPERATE"],
      sink,
      now: () => "2026-09-24T00:00:01+07:00",
    });

    expect(decision.allowed).toBe(false);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      permissionDecision: "DENY",
      outcome: "REJECTED",
      permissionReason: "UNKNOWN_CAPABILITY",
    });
    expect(sink.records[0]).not.toHaveProperty("payload");
  });
});
