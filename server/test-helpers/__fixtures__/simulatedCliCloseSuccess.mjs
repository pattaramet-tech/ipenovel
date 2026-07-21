// The successful-close counterpart to simulatedCliCloseFailure.mjs - same
// top-level await + try/catch pattern, but the awaited operation resolves
// cleanly. Proves the pattern does not always report failure and exits 0
// (Node's default) when nothing actually goes wrong.
async function simulateSuccessfulClose() {
  return undefined;
}

try {
  await simulateSuccessfulClose();
  console.log("[fixture] succeeded");
} catch (error) {
  console.error(`[fixture] ${error?.message || error}`);
  process.exitCode = 1;
}
