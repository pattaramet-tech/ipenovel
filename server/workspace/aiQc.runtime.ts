import { executeReadOnlyAiQcAttempt } from "./aiQc.service";
import { createConfiguredWorkspaceAiQcProvider } from "./aiQc.provider";

export type WorkspaceAiQcConfiguredExecutionInput = Omit<
  Parameters<typeof executeReadOnlyAiQcAttempt>[0],
  "provider" | "allowExternalProvider"
> & {
  fetchImpl?: typeof fetch;
};

/**
 * Explicit runtime bridge from ENV-backed provider configuration to the
 * provider-neutral M04-B execution service. It is intentionally not attached
 * to server startup, a scheduler, or the public Workspace router.
 */
export async function executeConfiguredWorkspaceAiQcAttempt(
  input: WorkspaceAiQcConfiguredExecutionInput
) {
  const { fetchImpl, ...attempt } = input;
  const provider = createConfiguredWorkspaceAiQcProvider(fetchImpl);
  return executeReadOnlyAiQcAttempt({
    ...attempt,
    provider,
    allowExternalProvider: true,
  });
}
