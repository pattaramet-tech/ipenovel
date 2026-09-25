import { createIpeNovelWorkspacePublishProvider } from "../server/workspace/ipenovelPublish.provider";
import { requireWorkspacePublishRequestPolicy, runScopedPublishWorkerOnce } from "../server/workspace/publishExecution.runtime";
import { resolvePendingPublishExecutionScope } from "../server/workspace/publishExecution.service";

const publishPolicy = requireWorkspacePublishRequestPolicy();
const safety = publishPolicy.safety!;
const scope = await resolvePendingPublishExecutionScope();
if (!scope) {
  console.log(JSON.stringify({ safety, scope: null, result: { claimed: false }, events: [] }, null, 2));
  process.exit(0);
}
const events: unknown[] = [];
const result = await runScopedPublishWorkerOnce({
  scope,
  leaseOwner: `${publishPolicy.mode}-once:${process.pid}`,
  provider: createIpeNovelWorkspacePublishProvider(),
  executionEnabled: publishPolicy.executionEnabled,
  allowExternalProvider: publishPolicy.externalProviderEnabled,
  observer: event => events.push(event),
});
console.log(JSON.stringify({ safety, scope, result, events }, null, 2));
