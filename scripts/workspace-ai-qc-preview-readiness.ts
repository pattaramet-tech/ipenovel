import { buildWorkspaceAiQcPreviewReadiness } from "../server/workspace/aiQc.previewReadiness";

const args = new Set(process.argv.slice(2));
const report = buildWorkspaceAiQcPreviewReadiness(process.env);

const printable = {
  runtimeTarget: report.runtimeTarget,
  provider: report.provider,
  reconciliation: report.reconciliation,
  artifactStore: report.artifactStore,
  execution: report.execution,
  readyForDisarmedPreview: report.readyForDisarmedPreview,
  readyForControlledExecution: report.readyForControlledExecution,
  blockers: report.blockers,
};

console.log(JSON.stringify(printable, null, 2));

if (args.has("--require-disarmed-ready")) {
  process.exitCode = report.readyForDisarmedPreview ? 0 : 1;
} else if (args.has("--require-controlled-ready")) {
  process.exitCode = report.readyForControlledExecution ? 0 : 1;
}
