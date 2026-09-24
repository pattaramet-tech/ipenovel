import type {
  NqaDecision,
  NqaReasonCode,
  QaEvidenceRef,
} from "../../contracts";
import type {
  NqaAdjudicationEvidencePack,
  NqaAdjudicationPolicy,
  NqaAdjudicationResult,
  NqaJevDecision,
  NqaJevProvider,
  NqaSmallLlmDecision,
  NqaSmallLlmProvider,
} from "./contracts";
import { buildJevState } from "./evidence";
import { mergeNqaAdjudicationPolicy } from "./policy";

function mergeReasons(
  ...groups: ReadonlyArray<readonly NqaReasonCode[]>
): NqaReasonCode[] {
  return Array.from(new Set(groups.flat()));
}

function evidenceRef(input: {
  route: NqaAdjudicationResult["route"];
  decision: NqaDecision;
  jev: NqaJevDecision | null;
  localLlm: NqaSmallLlmDecision | null;
}): QaEvidenceRef[] {
  return [
    {
      evidenceId: "semantic-adjudication",
      kind: "POLICY",
      boundedSummary: [
        "Adjudication.",
        "route=" + input.route,
        "decision=" + input.decision,
        "jevRoute=" + (input.jev?.route ?? "n/a"),
        "jevConfidence=" + (input.jev?.routeConfidence.toFixed(4) ?? "n/a"),
        "localDecision=" + (input.localLlm?.decision ?? "n/a"),
        "localConfidence=" + (input.localLlm?.confidence.toFixed(4) ?? "n/a"),
      ]
        .join(" ")
        .slice(0, 1000),
    },
  ];
}

function result(input: {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  applied: boolean;
  route: NqaAdjudicationResult["route"];
  jev: NqaJevDecision | null;
  localLlm: NqaSmallLlmDecision | null;
  policy: NqaAdjudicationPolicy;
  evidencePack: NqaAdjudicationEvidencePack;
}): NqaAdjudicationResult {
  return {
    decision: input.decision,
    reasonCodes: mergeReasons(input.reasonCodes),
    applied: input.applied,
    route: input.route,
    jev: input.jev,
    localLlm: input.localLlm,
    evidencePackVersion: input.evidencePack.version,
    policyVersion: input.policy.version,
    evidence: evidenceRef({
      route: input.route,
      decision: input.decision,
      jev: input.jev,
      localLlm: input.localLlm,
    }),
  };
}

export async function runNqaAdjudication(input: {
  evidencePack: NqaAdjudicationEvidencePack;
  jevProvider?: NqaJevProvider;
  smallLlmProvider?: NqaSmallLlmProvider;
  policy?: Partial<NqaAdjudicationPolicy>;
}): Promise<NqaAdjudicationResult> {
  const policy = mergeNqaAdjudicationPolicy(input.policy);
  const upstreamDecision = input.evidencePack.upstreamDecision;
  const upstreamReasons = input.evidencePack.upstreamReasonCodes;

  if (upstreamDecision !== "REVIEW") {
    return result({
      decision: upstreamDecision,
      reasonCodes: upstreamReasons,
      applied: false,
      route: "SKIPPED_UPSTREAM_FINAL",
      jev: null,
      localLlm: null,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  let jev: NqaJevDecision | null = null;
  if (input.jevProvider) {
    try {
      jev = await input.jevProvider.decide(buildJevState(input.evidencePack));
    } catch {
      jev = null;
    }
  }

  const jevHighConfidence =
    jev !== null && jev.routeConfidence >= policy.jevRouteConfidenceThreshold;

  if (jevHighConfidence && jev?.route === "human_review") {
    return result({
      decision: "REVIEW",
      reasonCodes: mergeReasons(upstreamReasons, ["HUMAN_REVIEW_REQUIRED"]),
      applied: true,
      route: "HUMAN_REVIEW",
      jev,
      localLlm: null,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  if (
    jevHighConfidence &&
    jev?.route === "accept_machine" &&
    jev.evidenceSufficientProbability >=
      policy.jevEvidenceSufficientThreshold &&
    !policy.allowJevFinalDecision
  ) {
    return result({
      decision: "REVIEW",
      reasonCodes: upstreamReasons,
      applied: true,
      route: "JEV_ACCEPT_MACHINE",
      jev,
      localLlm: null,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  if (!input.smallLlmProvider) {
    return result({
      decision: "REVIEW",
      reasonCodes: mergeReasons(upstreamReasons, ["HUMAN_REVIEW_REQUIRED"]),
      applied: true,
      route: "HUMAN_REVIEW",
      jev,
      localLlm: null,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  let localLlm: NqaSmallLlmDecision | null = null;
  try {
    localLlm = await input.smallLlmProvider.adjudicate(input.evidencePack);
  } catch {
    return result({
      decision: "REVIEW",
      reasonCodes: mergeReasons(upstreamReasons, ["HUMAN_REVIEW_REQUIRED"]),
      applied: true,
      route: "HUMAN_REVIEW",
      jev,
      localLlm: null,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  const sufficientlyConfident =
    localLlm.confidence >= policy.localLlmFinalConfidenceThreshold;
  const passAllowed = localLlm.decision !== "PASS" || policy.allowLocalLlmPass;
  const failAllowed = localLlm.decision !== "FAIL" || policy.allowLocalLlmFail;

  if (
    sufficientlyConfident &&
    localLlm.decision !== "REVIEW" &&
    passAllowed &&
    failAllowed
  ) {
    return result({
      decision: localLlm.decision,
      reasonCodes: mergeReasons(upstreamReasons, localLlm.reasonCodes),
      applied: true,
      route: "LOCAL_LLM",
      jev,
      localLlm,
      policy,
      evidencePack: input.evidencePack,
    });
  }

  return result({
    decision: "REVIEW",
    reasonCodes: mergeReasons(upstreamReasons, localLlm.reasonCodes, [
      "HUMAN_REVIEW_REQUIRED",
    ]),
    applied: true,
    route: "HUMAN_REVIEW",
    jev,
    localLlm,
    policy,
    evidencePack: input.evidencePack,
  });
}
