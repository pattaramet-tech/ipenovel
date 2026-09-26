import { validateNqaSidecarEndpoint } from "../sidecarEndpoint";
import { NqaReasonCodeSchema, type NqaReasonCode } from "../../contracts";
import type {
  NqaAdjudicationEvidencePack,
  NqaSmallLlmDecision,
  NqaSmallLlmProvider,
} from "./contracts";

export class LocalHttpSmallLlmProvider implements NqaSmallLlmProvider {
  readonly providerId = "local-http-small-llm";

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

  async adjudicate(
    evidence: NqaAdjudicationEvidencePack
  ): Promise<NqaSmallLlmDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, this.input.timeoutMs ?? 120_000)
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
            evidence,
          }),
          signal: controller.signal,
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          "Local small-LLM request failed with status " + response.status + "."
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error("Local small-LLM returned malformed JSON.");
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error("Local small-LLM response is invalid.");
      }

      const object = parsed as {
        decision?: unknown;
        reasonCodes?: unknown;
        confidence?: unknown;
        boundedRationale?: unknown;
        modelVersion?: unknown;
      };

      if (
        object.decision !== "PASS" &&
        object.decision !== "REVIEW" &&
        object.decision !== "FAIL"
      ) {
        throw new Error("Local small-LLM returned an invalid decision.");
      }

      if (
        typeof object.confidence !== "number" ||
        !Number.isFinite(object.confidence) ||
        object.confidence < 0 ||
        object.confidence > 1
      ) {
        throw new Error("Local small-LLM returned invalid confidence.");
      }

      if (!Array.isArray(object.reasonCodes)) {
        throw new Error("Local small-LLM returned invalid reason codes.");
      }

      const reasonCodes: NqaReasonCode[] = [];
      for (const reason of object.reasonCodes) {
        const parsedReason = NqaReasonCodeSchema.safeParse(reason);
        if (!parsedReason.success) {
          throw new Error("Local small-LLM returned an unknown reason code.");
        }
        if (!reasonCodes.includes(parsedReason.data)) {
          reasonCodes.push(parsedReason.data);
        }
      }

      if (
        typeof object.boundedRationale !== "string" ||
        object.boundedRationale.length > 1000
      ) {
        throw new Error("Local small-LLM returned invalid rationale.");
      }

      return {
        decision: object.decision,
        reasonCodes,
        confidence: object.confidence,
        boundedRationale: object.boundedRationale,
        modelVersion:
          typeof object.modelVersion === "string"
            ? object.modelVersion
            : this.modelVersion,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
