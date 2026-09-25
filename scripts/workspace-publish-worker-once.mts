import { createIpeNovelWorkspacePublishProvider } from "../server/workspace/ipenovelPublish.provider";
import { requirePreviewPublishExecutionSafety, runScopedPublishWorkerOnce } from "../server/workspace/publishExecution.runtime";
import { resolvePendingPublishExecutionScope } from "../server/workspace/publishExecution.service";

const executionEnabled = process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true";
const externalProviderEnabled = process.env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";
if (!executionEnabled || !externalProviderEnabled) {
  throw new Error("Publish worker refused: both execution and external-provider flags must be explicitly true.");
}
const safety = requirePreviewPublishExecutionSafety();
const scope = await resolvePendingPublishExecutionScope();
if (!scope) {
  console.log(JSON.stringify({ safety, scope: null, result: { claimed: false }, events: [] }, null, 2));
  process.exit(0);
}
const events: unknown[] = [];
const result = await runScopedPublishWorkerOnce({
  scope,
  leaseOwner: `preview-once:${process.pid}`,
  provider: createIpeNovelWorkspacePublishProvider(),
  executionEnabled,
  allowExternalProvider: externalProviderEnabled,
  observer: event => events.push(event),
});
console.log(JSON.stringify({ safety, scope, result, events }, null, 2));
