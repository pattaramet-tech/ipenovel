import type {
  NqaJevDecision,
  NqaJevProvider,
  NqaJevRoute,
  NqaJevState,
} from "./contracts";

type JevChoiceAnswer = {
  type?: string;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
};

type JevNoulAnswer = {
  type?: string;
  noul?: unknown;
};

type JevScoreAnswer = {
  type?: string;
  score?: unknown;
  confidence?: unknown;
};

function finiteProbability(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("Jev returned invalid " + field + ".");
  }
  return value;
}

export class JevHttpDecisionProvider implements NqaJevProvider {
  readonly providerId = "typesafe-jev";

  constructor(
    readonly modelVersion: string,
    private readonly input: {
      apiKey: string;
      endpoint?: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    }
  ) {
    if (!input.apiKey.trim()) {
      throw new Error("Jev API key is required.");
    }

    const endpoint = input.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    const parsed = new URL(endpoint);
    const allowedHosts = new Set(["api.typesafe.ai", "thejevai.com"]);

    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.has(parsed.hostname) ||
      parsed.pathname !== "/v1/systemone"
    ) {
      throw new Error(
        "Jev endpoint must be an approved HTTPS System One endpoint."
      );
    }
  }

  async decide(state: NqaJevState): Promise<NqaJevDecision> {
    const endpoint =
      this.input.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, this.input.timeoutMs ?? 15_000)
    );

    try {
      const response = await (this.input.fetchFn ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.input.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: this.modelVersion,
          state,
          questions: {
            route: {
              type: "choice",
              instructions:
                "Route this QA review evidence. Choose accept_machine only when the machine evidence is already decisive, escalate_local_llm when bounded text evidence should be examined by a local language model, or human_review when evidence remains insufficient or contradictory.",
              criteria: {
                accept_machine:
                  "Machine metrics and reason codes are already decisive enough to retain the upstream review outcome without text adjudication.",
                escalate_local_llm:
                  "Bounded text snippets should be examined by the local language model to adjudicate semantic fidelity.",
                human_review:
                  "The evidence is too incomplete, contradictory, or high-risk for automated adjudication.",
              },
            },
            evidence_sufficient: {
              type: "noul",
              instructions:
                "Is the supplied machine evidence sufficient for an automated adjudication step without requiring additional source retrieval?",
              criteria: {
                true: "Evidence is sufficient for automated adjudication.",
                false: "Additional evidence or human review is required.",
              },
            },
            semantic_risk: {
              type: "score",
              instructions:
                "Rate the risk that the translation is semantically wrong based only on these machine evidence signals.",
              criteria: ["low", "moderate", "high", "critical"],
            },
          },
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          "Jev request failed with status " + response.status + "."
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Jev returned malformed JSON.");
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error("Jev response is invalid.");
      }

      const responseObject = parsed as {
        model?: unknown;
        result?: { answers?: unknown };
        answers?: unknown;
      };
      const answers = responseObject.result?.answers ?? responseObject.answers;

      if (!answers || typeof answers !== "object") {
        throw new Error("Jev response is missing answers.");
      }

      const answerMap = answers as Record<string, unknown>;
      const routeAnswer = answerMap.route as JevChoiceAnswer;
      const evidenceAnswer = answerMap.evidence_sufficient as JevNoulAnswer;
      const riskAnswer = answerMap.semantic_risk as JevScoreAnswer;

      const route = routeAnswer?.choice;
      if (
        route !== "accept_machine" &&
        route !== "escalate_local_llm" &&
        route !== "human_review"
      ) {
        throw new Error("Jev returned an invalid route.");
      }

      const routeConfidence = finiteProbability(
        routeAnswer.confidence,
        "route confidence"
      );
      const evidenceSufficientProbability = finiteProbability(
        evidenceAnswer?.noul,
        "evidence sufficient probability"
      );

      let semanticRiskScore: number | null = null;
      if (
        typeof riskAnswer?.score === "number" &&
        Number.isFinite(riskAnswer.score)
      ) {
        if (riskAnswer.score < 0 || riskAnswer.score > 3) {
          throw new Error("Jev returned an invalid semantic risk score.");
        }
        semanticRiskScore = riskAnswer.score / 3;
      }

      return {
        route: route as NqaJevRoute,
        routeConfidence,
        evidenceSufficientProbability,
        semanticRiskScore,
        modelVersion:
          typeof responseObject.model === "string"
            ? responseObject.model
            : this.modelVersion,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
