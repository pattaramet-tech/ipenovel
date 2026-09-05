import { describe, expect, it } from "vitest";
import {
  chooseVerifiedCandidate,
  classifyBulkRelinkObject,
  isTrustedLegacySlipUrl,
  parseBulkRelinkArgs,
  privateReference,
} from "../scripts/lib/bulkLegacySlipRelink";

describe("bulk legacy slip relink", () => {
  it("requires explicit preview and apply confirmation", () => {
    expect(
      parseBulkRelinkArgs(["--dry-run", "--confirm-preview", "--type=all"])
    ).toEqual({ mode: "dry-run", type: "all" });
    expect(
      parseBulkRelinkArgs([
        "--apply",
        "--confirm-preview",
        "--type=payments",
        "--confirm-bulk-relink-approved-legacy-slips",
      ])
    ).toEqual({ mode: "apply", type: "payments" });
    for (const args of [
      ["--apply", "--confirm-preview", "--type=all"],
      ["--dry-run", "--type=all"],
      ["--dry-run", "--apply", "--confirm-preview", "--type=all"],
      ["--dry-run", "--confirm-preview", "--type=other"],
    ])
      expect(() => parseBulkRelinkArgs(args)).toThrow("INVALID_ARGUMENTS");
  });

  it("accepts only the exact trusted legacy host", () => {
    expect(
      isTrustedLegacySlipUrl(
        "https://d2xsxph8kpxj0f.cloudfront.net/slips/a.jpg"
      )
    ).toBe(true);
    expect(
      isTrustedLegacySlipUrl("http://d2xsxph8kpxj0f.cloudfront.net/slips/a.jpg")
    ).toBe(false);
    expect(
      isTrustedLegacySlipUrl(
        "https://d2xsxph8kpxj0f.cloudfront.net.attacker.example/slips/a.jpg"
      )
    ).toBe(false);
    expect(
      isTrustedLegacySlipUrl("r2p:payment-slips/legacy/payments/1/a.jpg")
    ).toBe(false);
  });

  it("maps only canonical migration keys", () => {
    const valid = classifyBulkRelinkObject("payments", {
      key: "payment-slips/legacy/payments/11280001/1700000000000-abc123.jpg",
      etag: '"etag-value"',
      size: 193902,
    });
    expect(valid.kind).toBe("candidate");
    if (valid.kind === "candidate") {
      expect(valid.sourceId).toBe(11280001);
      expect(privateReference(valid.object)).toBe(
        "r2p:payment-slips/legacy/payments/11280001/1700000000000-abc123.jpg"
      );
    }
    expect(
      classifyBulkRelinkObject("payments", {
        key: "payment-slips/legacy/payments/11280001/not-a-migration-key.jpg",
        etag: '"etag"',
        size: 1,
      })
    ).toMatchObject({ kind: "invalid", sourceId: 11280001 });
  });

  it("allows duplicate objects only when their verified bytes match", () => {
    const left = {
      key: "payment-slips/legacy/payments/1/1-aaaaaa.jpg",
      etag: '"a"',
      size: 10,
    };
    const right = {
      key: "payment-slips/legacy/payments/1/2-bbbbbb.jpg",
      etag: '"b"',
      size: 10,
    };
    expect(
      chooseVerifiedCandidate([
        { object: left, hash: "a".repeat(64) },
        { object: right, hash: "a".repeat(64) },
      ])
    ).toEqual({ status: "ready", object: right });
    expect(
      chooseVerifiedCandidate([
        { object: left, hash: "a".repeat(64) },
        { object: right, hash: "b".repeat(64) },
      ])
    ).toEqual({ status: "ambiguous" });
  });
});
