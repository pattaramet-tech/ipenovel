import { defineWorkspace } from "vitest/config";

// Named projects for `vitest --project=unit` / `--project=integration` if
// ever run directly through the workspace. The package.json scripts
// (test:unit, test:integration) invoke each config file directly instead -
// simpler to reason about and to keep test:unit's behavior (and therefore
// docs/test-baseline-snapshot.json/pnpm test:gate) completely unaffected
// by anything integration-project-specific. This file exists so both
// projects are still discoverable/runnable as a Vitest workspace, per
// docs/TEST_INFRASTRUCTURE.md's "considered, not guessed" config choices.
export default defineWorkspace(["./vitest.config.ts", "./vitest.integration.config.ts"]);
