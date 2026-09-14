import { executeReadOnlyAiQcAttempt } from "./aiQc.service";
import { createRuntimeWorkspaceAiQcProvider } from "./aiProviderRuntime";

export type WorkspaceAiQcConfiguredExecutionInput = Omit<
  Parameters<typeof executeReadOnlyAiQcAttempt>[0],
  "provider" | "allowExternalProvider"
> & {
  fetchImpl?: typeof fetch;
};

/**
 * Explicit runtime bridge from the admin-managed provider profile (with legacy ENV fallback) to the
 * provider-neutral M04-B execution service. It is intentionally not attached
 * to server startup, a scheduler, or the public Workspace router.
 */
export async function executeConfiguredWorkspaceAiQcAttempt(
  input: WorkspaceAiQcConfiguredExecutionInput
) {
  const { fetchImpl, ...attempt } = input;
  const provider = await createRuntimeWorkspaceAiQcProvider(fetchImpl);
  return executeReadOnlyAiQcAttempt({
    ...attempt,
    provider,
    allowExternalProvider: true,
  });
}
