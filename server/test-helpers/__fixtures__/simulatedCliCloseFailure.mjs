// A minimal, standalone mirror of scripts/test-db-prepare.ts's top-level
// execution pattern (top-level await + try/catch, process.exitCode = 1 on
// failure, never process.exit()) - used by
// server/test-helpers/testDbPrepareCliExitCode.subprocess.test.ts to prove,
// via a real child process, that this exact pattern produces a nonzero
// exit code when the awaited operation fails. Deliberately has NO
// dependency on TEST_DATABASE_URL, mysql2, or any database - it simulates
// a close failure by simply throwing, the same shape of error
// closeMysqlConnectionSafely() would throw for a real close failure.
async function simulateFailingClose() {
  throw new Error("closeMysqlConnectionSafely: connection.end() failed: simulated failure for CLI exit-code test");
}

try {
  await simulateFailingClose();
  console.log("[fixture] unexpectedly succeeded");
} catch (error) {
  console.error(`[fixture] ${error?.message || error}`);
  process.exitCode = 1;
}
