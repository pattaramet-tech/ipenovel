import { performance } from "node:perf_hooks";

import type { NqaAdjudicationEvidencePack } from "../adjudication/contracts";
import { runNqaAdjudication } from "../adjudication/engine";
import { LocalHttpSmallLlmProvider } from "../adjudication/smallLlm";

const provider = new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
  endpoint: "http://127.0.0.1:8767/adjudicate",
  timeoutMs: 180_000,
});

function pack(input: {
  sourceText: string;
  translationText: string;
  rerankScore: number;
  sourceCoverage: number;
  translationCoverage: number;
}): NqaAdjudicationEvidencePack {
  return {
    version: "nqa-adjudication-evidence-v1",
    upstreamDecision: "REVIEW",
    upstreamReasonCodes: ["ALIGNMENT_UNCERTAIN"],
    globalSearch: {
      expectedRank: 1,
      expectedSimilarity: 0.7,
      expectedLeadOverAlternate: 0.01,
      bestAlternateChapter: 196,
    },
    alignment: {
      sourceCoverage: input.sourceCoverage,
      translationCoverage: input.translationCoverage,
      meanRerankScore: input.rerankScore,
      minRerankScore: input.rerankScore,
      lowScoreFraction: input.rerankScore < 0.45 ? 1 : 0,
      sourceGapFraction: 1 - input.sourceCoverage,
      translationGapFraction: 1 - input.translationCoverage,
      alignedPairCount: 1,
      sourceChunkCount: 1,
      translationChunkCount: 1,
    },
    snippets: [
      {
        evidenceId: "synthetic-pair-0",
        kind: "ALIGNED_PAIR",
        sourceHash: "a".repeat(64),
        translationHash: "b".repeat(64),
        sourceStartIndex: 1,
        sourceEndIndex: 100,
        translationStartIndex: 1,
        translationEndIndex: 100,
        rerankScore: input.rerankScore,
        sourceText: input.sourceText,
        translationText: input.translationText,
      },
    ],
  };
}

async function run(label: string, evidence: NqaAdjudicationEvidencePack) {
  const started = performance.now();
  const result = await runNqaAdjudication({
    evidencePack: evidence,
    smallLlmProvider: provider,
  });
  return {
    label,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    result,
  };
}

async function main() {
  const faithful = await run(
    "faithful",
    pack({
      sourceText:
        "Sabo entered the room, spoke to Kurama, and asked what had happened.",
      translationText:
        "ซาโบเดินเข้ามาในห้อง พูดกับคุรามะ และถามว่าเกิดอะไรขึ้น",
      rerankScore: 0.78,
      sourceCoverage: 0.96,
      translationCoverage: 0.98,
    })
  );

  const divergent = await run(
    "divergent",
    pack({
      sourceText:
        "Sabo entered the room, spoke to Kurama, and asked what had happened.",
      translationText:
        "เดวอนอยู่ในห้องทดลองและเริ่มผ่าตัดเพื่อสร้างผลปีศาจเทียม",
      rerankScore: 0.18,
      sourceCoverage: 0.35,
      translationCoverage: 0.3,
    })
  );

  process.stdout.write(JSON.stringify({ faithful, divergent }, null, 2) + "\n");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
