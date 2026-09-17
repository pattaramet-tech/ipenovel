import {
  GEMINI_STAGE_PROBE_ORDER,
  runWorkspaceAiQcGeminiStageProbe,
  WorkspaceAiQcGeminiStageProbeError,
} from "../server/workspace/aiQc.geminiStageProbe";
import type { GeminiInteractionsRequestStage } from "../server/workspace/aiQc.geminiInteractions";
import { WorkspaceAiQcExternalProviderError } from "../server/workspace/aiQc.provider";

const throughArg = process.argv
  .slice(2)
  .find(value => value.startsWith("--through="));
const through = throughArg?.slice("--through=".length) as
  GeminiInteractionsRequestStage | undefined;

if (!through || !GEMINI_STAGE_PROBE_ORDER.includes(through)) {
  console.error(
    `Usage: pnpm exec tsx scripts/workspace-ai-qc-gemini-stage-probe.ts --through=${GEMINI_STAGE_PROBE_ORDER.join("|")}`
  );
  process.exit(2);
}

try {
  const report = await runWorkspaceAiQcGeminiStageProbe({ through });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  if (
    error instanceof WorkspaceAiQcGeminiStageProbeError ||
    error instanceof WorkspaceAiQcExternalProviderError
  ) {
    console.error(
      JSON.stringify(
        { ok: false, error: { code: error.code, message: error.message } },
        null,
        2
      )
    );
    process.exit(1);
  }
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          code: "DIAGNOSTIC_FAILED",
          message: "Gemini diagnostic probe failed unexpectedly.",
        },
      },
      null,
      2
    )
  );
  process.exit(1);
}
