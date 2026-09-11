import { describe, expect, it } from "vitest";
import {
  compareCheckerParity,
  evaluateCheckerRuleSet,
  parseCheckerRuleSet,
} from "./checkerParity.domain";

const snapshot = {
  id: 7,
  providerRevisionId: "rev-m03-2",
  normalizedSha256: "a".repeat(64),
  normalizationVersion: 1,
  byteLength: 37,
};

const copiedLegacyFinding = {
  ruleKey: "snapshot.revision.expected",
  severity: "error" as const,
  locationKey: "snapshot:revision",
  excerptSha256: "05ce1de93bf4c504733b49ef76a7f70363f4ce3bce467772a970b01e2cddaa14",
};

describe("workspace M03-B deterministic checker parity", () => {
  it("evaluates immutable snapshot evidence deterministically", () => {
    const ruleSet = parseCheckerRuleSet(JSON.stringify({
      version: 1,
      failOn: "error",
      rules: [{
        key: "snapshot.revision.expected",
        field: "providerRevisionId",
        operator: "eq",
        value: "legacy-rev",
        severity: "error",
        locationKey: "snapshot:revision",
        message: "Snapshot revision must match the copied legacy baseline.",
      }],
    }));

    const first = evaluateCheckerRuleSet(ruleSet, snapshot);
    const second = evaluateCheckerRuleSet(ruleSet, snapshot);
    expect(first).toEqual(second);
    expect(first.status).toBe("failed");
    expect(first.findings).toEqual([
      expect.objectContaining(copiedLegacyFinding),
    ]);
  });

  it("reports zero variance for the committed copied-legacy fixture", () => {
    const parity = compareCheckerParity({
      legacy: [copiedLegacyFinding],
      workspace: [copiedLegacyFinding],
    });
    expect(parity).toMatchObject({
      pass: true,
      missing: [],
      unexpected: [],
      severityMismatch: [],
      locationMismatch: [],
      duplicateLegacy: 0,
      duplicateWorkspace: 0,
    });
  });

  it("classifies missing, unexpected, severity, location and duplicate variance", () => {
    const parity = compareCheckerParity({
      legacy: [copiedLegacyFinding, copiedLegacyFinding],
      workspace: [
        { ...copiedLegacyFinding, severity: "warning", locationKey: "snapshot:other" },
        {
          ruleKey: "workspace.only",
          severity: "info",
          locationKey: "snapshot:workspace",
          excerptSha256: "b".repeat(64),
        },
      ],
    });
    expect(parity.pass).toBe(false);
    expect(parity.severityMismatch).toHaveLength(1);
    expect(parity.locationMismatch).toHaveLength(1);
    expect(parity.unexpected).toHaveLength(1);
    expect(parity.duplicateLegacy).toBe(1);
  });

  it("rejects unsupported rule contracts instead of inventing content rules", () => {
    expect(() => parseCheckerRuleSet(JSON.stringify({
      version: 1,
      failOn: "error",
      rules: [{
        key: "body.contains",
        field: "documentBody",
        operator: "eq",
        value: "text",
        severity: "error",
        locationKey: "body",
        message: "unsupported",
      }],
    }))).toThrow(/field is unsupported/);
  });
});
