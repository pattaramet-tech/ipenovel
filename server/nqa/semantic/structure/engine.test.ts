import { describe, expect, it } from "vitest";

import type {
  NqaStructureEvidenceItem,
  NqaStructurePairAssessment,
  NqaStructureVerificationProvider,
} from "./contracts";
import { runStructuredVerification } from "./engine";

function item(id = "item-1"): NqaStructureEvidenceItem {
  return {
    evidenceId: id,
    kind: "ALIGNED_PAIR",
    sourceHash: "a".repeat(64),
    translationHash: "b".repeat(64),
    sourceStartIndex: 1,
    sourceEndIndex: 10,
    translationStartIndex: 20,
    translationEndIndex: 30,
    rerankScore: 0.7,
    sourceText: "Source text",
    translationText: "ข้อความแปล",
  };
}

function assessment(input?: {
  event?: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  entity?: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  relationship?: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  causality?: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  chronology?: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  confidence?: number;
}): NqaStructurePairAssessment {
  const confidence = input?.confidence ?? 0.95;
  const dimensions = [
    ["EVENT", input?.event ?? "MATCH"],
    ["ENTITY", input?.entity ?? "MATCH"],
    ["RELATIONSHIP", input?.relationship ?? "MATCH"],
    ["CAUSALITY", input?.causality ?? "MATCH"],
    ["CHRONOLOGY", input?.chronology ?? "MATCH"],
  ] as const;

  return {
    evidenceId: "item-1",
    source: {
      entities: [{ canonicalName: "Sabo", role: "actor" }],
      events: [
        {
          eventId: "s1",
          actor: "Sabo",
          action: "enters",
          object: "room",
          outcome: null,
          order: 0,
        },
      ],
      relationships: [],
      causalLinks: [],
    },
    translation: {
      entities: [{ canonicalName: "Sabo", role: "actor" }],
      events: [
        {
          eventId: "t1",
          actor: "Sabo",
          action: "enters",
          object: "room",
          outcome: null,
          order: 0,
        },
      ],
      relationships: [],
      causalLinks: [],
    },
    dimensions: dimensions.map(([dimension, status]) => ({
      dimension,
      status,
      confidence,
      boundedSummary: dimension + " " + status,
    })),
  };
}

function provider(
  value: NqaStructurePairAssessment | Error
): NqaStructureVerificationProvider {
  return {
    providerId: "fixture-structure",
    modelVersion: "fixture-v1",
    async verify() {
      if (value instanceof Error) throw value;
      return [value];
    },
  };
}

describe("NQA M12 structured verification engine", () => {
  it("passes when enough dimensions strongly match", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(assessment()),
    });

    expect(result.decision).toBe("PASS");
    expect(result.reasonCodes).toEqual([]);
    expect(result.metrics.strongMatchCount).toBe(5);
  });

  it("reviews a single strong structured mismatch", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(
        assessment({
          entity: "MISMATCH",
        })
      ),
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toEqual(["ENTITY_MISMATCH"]);
  });

  it("keeps a single-item multi-dimension mismatch at REVIEW by default", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(
        assessment({
          event: "MISMATCH",
          entity: "MISMATCH",
          relationship: "MISMATCH",
        })
      ),
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.metrics.strongMismatchItemCount).toBe(1);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "EVENT_MISMATCH",
        "ENTITY_MISMATCH",
        "RELATIONSHIP_MISMATCH",
      ])
    );
  });

  it("fails an event mismatch plus a supporting mismatch", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(
        assessment({
          event: "MISMATCH",
          entity: "MISMATCH",
        })
      ),
      policy: { minFailItems: 1 },
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["EVENT_MISMATCH", "ENTITY_MISMATCH"])
    );
  });

  it("fails three strong non-event mismatches", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(
        assessment({
          entity: "MISMATCH",
          relationship: "MISMATCH",
          causality: "MISMATCH",
        })
      ),
      policy: { minFailItems: 1 },
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "ENTITY_MISMATCH",
        "RELATIONSHIP_MISMATCH",
        "CAUSALITY_MISMATCH",
      ])
    );
  });

  it("ignores mismatches below confidence threshold", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(
        assessment({
          event: "MISMATCH",
          entity: "MISMATCH",
          confidence: 0.6,
        })
      ),
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
    expect(result.metrics.strongMismatchCount).toBe(0);
  });

  it("fails safe to REVIEW when provider errors", async () => {
    const result = await runStructuredVerification({
      items: [item()],
      provider: provider(new Error("model failed")),
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      reasonCodes: ["INSUFFICIENT_EVIDENCE"],
      assessments: [],
    });
  });

  it("keeps raw snippet text out of result evidence", async () => {
    const secret = "UNIQUE_STRUCTURE_SECRET";
    const secretItem = {
      ...item(),
      sourceText: secret,
      translationText: secret,
    };
    const result = await runStructuredVerification({
      items: [secretItem],
      provider: provider(assessment()),
    });

    expect(JSON.stringify(result.evidence)).not.toContain(secret);
  });
});
