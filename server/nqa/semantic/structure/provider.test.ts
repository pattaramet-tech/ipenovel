import { describe, expect, it, vi } from "vitest";

import type { NqaStructureEvidenceItem } from "./contracts";
import { LocalHttpStructureVerificationProvider } from "./provider";

function item(): NqaStructureEvidenceItem {
  return {
    evidenceId: "item-1",
    kind: "ALIGNED_PAIR",
    sourceHash: "a".repeat(64),
    translationHash: "b".repeat(64),
    sourceStartIndex: 1,
    sourceEndIndex: 10,
    translationStartIndex: 20,
    translationEndIndex: 30,
    rerankScore: 0.7,
    sourceText: "Source",
    translationText: "แปล",
  };
}

function assessment() {
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
    dimensions: [
      "EVENT",
      "ENTITY",
      "RELATIONSHIP",
      "CAUSALITY",
      "CHRONOLOGY",
    ].map(dimension => ({
      dimension,
      status: "MATCH",
      confidence: 0.95,
      boundedSummary: dimension + " matches",
    })),
  };
}

describe("NQA M12 local structure provider", () => {
  it("rejects non-loopback endpoints", () => {
    expect(
      () =>
        new LocalHttpStructureVerificationProvider("Qwen/Qwen3-1.7B", {
          endpoint: "https://example.com/verify-structure",
        })
    ).toThrow("Local structure endpoint must use a loopback hostname.");
  });

  it("posts bounded items and parses typed assessments", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("Qwen/Qwen3-1.7B");
        expect(body.items).toEqual([item()]);
        return new Response(JSON.stringify({ assessments: [assessment()] }), {
          status: 200,
        });
      }
    );

    const provider = new LocalHttpStructureVerificationProvider(
      "Qwen/Qwen3-1.7B",
      {
        endpoint: "http://127.0.0.1:8767/verify-structure",
        fetchFn,
      }
    );

    const result = await provider.verify([item()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      evidenceId: "item-1",
      dimensions: expect.arrayContaining([
        expect.objectContaining({
          dimension: "EVENT",
          status: "MATCH",
          confidence: 0.95,
        }),
      ]),
    });
  });

  it("requires all five dimensions exactly once", async () => {
    const invalid = assessment();
    invalid.dimensions = invalid.dimensions.slice(0, 4);

    const provider = new LocalHttpStructureVerificationProvider(
      "Qwen/Qwen3-1.7B",
      {
        endpoint: "http://localhost:8767/verify-structure",
        fetchFn: async () =>
          new Response(JSON.stringify({ assessments: [invalid] }), {
            status: 200,
          }),
      }
    );

    await expect(provider.verify([item()])).rejects.toThrow(
      "Local structure verifier must return five dimensions."
    );
  });

  it("rejects out-of-range confidence", async () => {
    const invalid = assessment();
    invalid.dimensions[0].confidence = 1.5;

    const provider = new LocalHttpStructureVerificationProvider(
      "Qwen/Qwen3-1.7B",
      {
        endpoint: "http://localhost:8767/verify-structure",
        fetchFn: async () =>
          new Response(JSON.stringify({ assessments: [invalid] }), {
            status: 200,
          }),
      }
    );

    await expect(provider.verify([item()])).rejects.toThrow(
      "Local structure verifier returned invalid dimension confidence."
    );
  });

  it("does not leak response bodies on HTTP failure", async () => {
    const provider = new LocalHttpStructureVerificationProvider(
      "Qwen/Qwen3-1.7B",
      {
        endpoint: "http://localhost:8767/verify-structure",
        fetchFn: async () =>
          new Response("secret model output", { status: 500 }),
      }
    );

    await expect(provider.verify([item()])).rejects.toThrow(
      "Local structure request failed with status 500."
    );
  });
});
