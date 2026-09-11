import { createIpeNovelWorkspacePublishProvider } from "../server/workspace/ipenovelPublish.provider";
import { parseWorkspacePublishExecutionScope, runScopedPublishWorkerOnce } from "../server/workspace/publishExecution.runtime";

const executionEnabled = process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true";
const externalProviderEnabled = process.env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";
if (!executionEnabled || !externalProviderEnabled) {
  throw new Error("Publish worker refused: both execution and external-provider flags must be explicitly true.");
}
const scope = parseWorkspacePublishExecutionScope(process.env.WORKSPACE_PUBLISH_EXECUTION_SCOPE);
const events: unknown[] = [];
const result = await runScopedPublishWorkerOnce({
  scope,
  leaseOwner: `preview-once:${process.pid}`,
  provider: createIpeNovelWorkspacePublishProvider(),
  executionEnabled,
  allowExternalProvider: externalProviderEnabled,
  observer: event => events.push(event),
});
console.log(JSON.stringify({ scope, result, events }, null, 2));
