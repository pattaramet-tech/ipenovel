import { describe, expect, it } from "vitest";

import {
  NQA_CANONICAL_CAPTURE,
  NQA_CANONICAL_FIXTURES,
} from "./fixtures/canonical";

describe("NQA canonical regression fixtures", () => {
  it("records row drift separately from immutable fixture identity", () => {
    expect(NQA_CANONICAL_CAPTURE.historicalIncidentRow).toBe(1584);
    expect(NQA_CANONICAL_CAPTURE.currentRow).toBe(1562);
    expect(NQA_CANONICAL_CAPTURE.currentRow).not.toBe(
      NQA_CANONICAL_CAPTURE.historicalIncidentRow
    );
  });

  it("contains the canonical bad Chapter 197 fixture", () => {
    const bad = NQA_CANONICAL_FIXTURES.find(
      fixture =>
        fixture.fixtureId === "nqa_fixture_shinobi_197_bad_historical_69"
    );

    expect(bad).toMatchObject({
      expectedDecision: "FAIL",
      goldLabelStatus: "CANONICAL_INCIDENT",
      provenance: "HISTORICAL_REVISION",
    });
    expect(bad?.source.internalSequence).toBe(198);
    expect(bad?.source.chapter).toBe(197);
    expect(bad?.translation.document.driveRevisionId).toBe("69");
    expect(bad?.translation.fingerprint.sha256).toBe(
      "5eb68ab366d0ab258676d07e644799809777bd004f4ed8ff21862dc8e4256ea0"
    );
  });

  it("keeps positive controls pending human gold-label signoff", () => {
    const positives = NQA_CANONICAL_FIXTURES.filter(
      fixture => fixture.expectedDecision === "PASS"
    );

    expect(positives).toHaveLength(2);
    expect(
      positives.every(
        fixture => fixture.goldLabelStatus === "CANDIDATE_PENDING_HUMAN_SIGNOFF"
      )
    ).toBe(true);
  });

  it("pins source and corrected translation revisions independently", () => {
    const corrected = NQA_CANONICAL_FIXTURES.find(
      fixture =>
        fixture.fixtureId === "nqa_fixture_shinobi_197_corrected_current_90"
    );

    expect(corrected?.source.document.driveRevisionId).toBe("4");
    expect(corrected?.translation.document.driveRevisionId).toBe("90");
    expect(corrected?.translation.document.tabId).toBe("t.bf525hytchcg");
  });
});
