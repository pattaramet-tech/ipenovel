import { validateNqaSidecarEndpoint } from "../sidecarEndpoint";
import type {
  NqaStructureDimension,
  NqaStructureDimensionAssessment,
  NqaStructureEvidenceItem,
  NqaStructurePairAssessment,
  NqaStructureVerificationProvider,
  NqaStructuredCausalLink,
  NqaStructuredEntity,
  NqaStructuredEvent,
  NqaStructuredRelationship,
  NqaStructuredSide,
} from "./contracts";

const DIMENSIONS = new Set<NqaStructureDimension>([
  "EVENT",
  "ENTITY",
  "RELATIONSHIP",
  "CAUSALITY",
  "CHRONOLOGY",
]);

function finiteProbability(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("Local structure verifier returned invalid " + field + ".");
  }
  return value;
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  nullable = false
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error("Local structure verifier returned invalid " + field + ".");
  }
  return value;
}

function parseEntities(value: unknown): NqaStructuredEntity[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Local structure verifier returned invalid entities.");
  }
  return value.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Local structure verifier returned invalid entity.");
    }
    const object = item as Record<string, unknown>;
    return {
      canonicalName: boundedString(
        object.canonicalName,
        "entity canonicalName",
        120
      ) as string,
      role: boundedString(object.role, "entity role", 120, true),
    };
  });
}

function parseEvents(value: unknown): NqaStructuredEvent[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Local structure verifier returned invalid events.");
  }
  return value.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Local structure verifier returned invalid event.");
    }
    const object = item as Record<string, unknown>;
    if (
      typeof object.order !== "number" ||
      !Number.isInteger(object.order) ||
      object.order < 0 ||
      object.order > 100
    ) {
      throw new Error("Local structure verifier returned invalid event order.");
    }
    return {
      eventId: boundedString(object.eventId, "eventId", 80) as string,
      actor: boundedString(object.actor, "event actor", 120, true),
      action: boundedString(object.action, "event action", 180) as string,
      object: boundedString(object.object, "event object", 180, true),
      outcome: boundedString(object.outcome, "event outcome", 180, true),
      order: object.order,
    };
  });
}

function parseRelationships(value: unknown): NqaStructuredRelationship[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Local structure verifier returned invalid relationships.");
  }
  return value.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error(
        "Local structure verifier returned invalid relationship."
      );
    }
    const object = item as Record<string, unknown>;
    return {
      subject: boundedString(
        object.subject,
        "relationship subject",
        120
      ) as string,
      relation: boundedString(
        object.relation,
        "relationship relation",
        160
      ) as string,
      object: boundedString(
        object.object,
        "relationship object",
        120
      ) as string,
    };
  });
}

function parseCausalLinks(value: unknown): NqaStructuredCausalLink[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Local structure verifier returned invalid causal links.");
  }
  return value.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Local structure verifier returned invalid causal link.");
    }
    const object = item as Record<string, unknown>;
    return {
      causeEventId: boundedString(
        object.causeEventId,
        "causeEventId",
        80
      ) as string,
      effectEventId: boundedString(
        object.effectEventId,
        "effectEventId",
        80
      ) as string,
    };
  });
}

function parseSide(value: unknown): NqaStructuredSide {
  if (!value || typeof value !== "object") {
    throw new Error(
      "Local structure verifier returned invalid structured side."
    );
  }
  const object = value as Record<string, unknown>;
  return {
    entities: parseEntities(object.entities),
    events: parseEvents(object.events),
    relationships: parseRelationships(object.relationships),
    causalLinks: parseCausalLinks(object.causalLinks),
  };
}

function parseDimensions(value: unknown): NqaStructureDimensionAssessment[] {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error("Local structure verifier must return five dimensions.");
  }
  const seen = new Set<NqaStructureDimension>();
  return value.map(item => {
    if (!item || typeof item !== "object") {
      throw new Error("Local structure verifier returned invalid dimension.");
    }
    const object = item as Record<string, unknown>;
    if (
      typeof object.dimension !== "string" ||
      !DIMENSIONS.has(object.dimension as NqaStructureDimension)
    ) {
      throw new Error(
        "Local structure verifier returned invalid dimension name."
      );
    }
    const dimension = object.dimension as NqaStructureDimension;
    if (seen.has(dimension)) {
      throw new Error("Local structure verifier returned duplicate dimension.");
    }
    seen.add(dimension);

    if (
      object.status !== "MATCH" &&
      object.status !== "MISMATCH" &&
      object.status !== "INSUFFICIENT"
    ) {
      throw new Error(
        "Local structure verifier returned invalid dimension status."
      );
    }

    return {
      dimension,
      status: object.status,
      confidence: finiteProbability(object.confidence, "dimension confidence"),
      boundedSummary: boundedString(
        object.boundedSummary,
        "dimension summary",
        500
      ) as string,
    };
  });
}

export class LocalHttpStructureVerificationProvider implements NqaStructureVerificationProvider {
  readonly providerId = "local-http-structure-verifier";

  constructor(
    readonly modelVersion: string,
    private readonly input: {
      endpoint: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
      privateBridge?: boolean;
    }
  ) {
    validateNqaSidecarEndpoint({
      endpoint: input.endpoint,
      privateBridge: input.privateBridge,
    });
  }

  async verify(
    items: NqaStructureEvidenceItem[]
  ): Promise<NqaStructurePairAssessment[]> {
    if (items.length === 0) return [];
    const ids = new Set(items.map(item => item.evidenceId));
    if (ids.size !== items.length) {
      throw new Error("Structure evidence IDs must be unique.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, this.input.timeoutMs ?? 180_000)
    );

    try {
      const response = await (this.input.fetchFn ?? fetch)(
        this.input.endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: this.modelVersion,
            items,
          }),
          signal: controller.signal,
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          "Local structure request failed with status " + response.status + "."
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error("Local structure verifier returned malformed JSON.");
      }

      const assessments = (parsed as { assessments?: unknown })?.assessments;
      if (!Array.isArray(assessments) || assessments.length !== items.length) {
        throw new Error(
          "Local structure assessment count does not match input."
        );
      }

      return assessments.map((assessment, index) => {
        if (!assessment || typeof assessment !== "object") {
          throw new Error(
            "Local structure verifier returned invalid assessment."
          );
        }
        const object = assessment as Record<string, unknown>;
        if (object.evidenceId !== items[index].evidenceId) {
          throw new Error(
            "Local structure assessment identity/order mismatch."
          );
        }

        return {
          evidenceId: object.evidenceId as string,
          source: parseSide(object.source),
          translation: parseSide(object.translation),
          dimensions: parseDimensions(object.dimensions),
        };
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
