import { describe, expect, it } from "vitest";

import {
  InMemoryNqaAuditSink,
  NQA_CAPABILITIES,
  authorizeAndAudit,
  authorizeNqaCapability,
} from "./controlPlane";

describe("NQA MCP control plane", () => {
  it("exposes only READ and QA_OPERATE capability tiers in V1", () => {
    const permissions = new Set(
      Object.values(NQA_CAPABILITIES).map(
        definition => definition.requiredPermission
      )
    );

    expect([...permissions].sort()).toEqual(["QA_OPERATE", "READ"]);
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
