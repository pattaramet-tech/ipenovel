// Shared, DB-independent diagnostics for scripts/test-db-prepare.ts and
// scripts/migrate-test-db.ts. Opt-in only via IPENOVEL_TEST_DB_DIAGNOSTICS=1
// - every function here is a no-op when that flag is unset. Even when
// enabled, output is restricted to: fixed lifecycle marker strings, and
// resource TYPE names/counts from the public, documented
// process.getActiveResourcesInfo() API. Never
// process._getActiveHandles()/_getActiveRequests() (private, undocumented
// Node APIs), never raw socket/connection/handle objects, never
// environment values, hostnames, or IP addresses, and never a caught
// error's message/String()/stack/cause - a diagnostics failure always logs
// one fixed string (optionally with a fixed, caller-supplied label, never
// anything derived from the exception itself).
export function isDiagnosticsEnabled(): boolean {
  return process.env.IPENOVEL_TEST_DB_DIAGNOSTICS === "1";
}

export type DiagnosticLogger = (marker: string) => void;

/** Returns a logger that no-ops unless diagnostics are enabled, prefixing every marker with `prefix`. */
export function createDiagnosticLogger(prefix: string): DiagnosticLogger {
  return function logDiagnostic(marker: string): void {
    if (!isDiagnosticsEnabled()) return;
    console.log(`${prefix}[diagnostics] ${marker}`);
  };
}

/**
 * Tallies resource TYPE counts from process.getActiveResourcesInfo() (e.g.
 * `{"TCPSOCKETWRAP": 2, "PipeWrap": 2, "Immediate": 1}`, matching the exact
 * class of evidence a real Gate A run reported) - never
 * process._getActiveHandles()/_getActiveRequests(), and never anything
 * beyond the bare type-name strings that public API already returns.
 */
export function getActiveResourceTypeCounts(): Record<string, number> {
  const infoFn = (process as any).getActiveResourcesInfo;
  const resourceTypes: string[] = typeof infoFn === "function" ? infoFn.call(process) : [];
  const counts: Record<string, number> = {};
  for (const type of resourceTypes) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Logs one resource-count snapshot labeled `label` (a fixed, caller-supplied
 * string, e.g. "after migration connection close" - never derived from a
 * caught error or any runtime value). If reading the snapshot itself fails,
 * logs one fixed failure message that still includes only that same fixed
 * label - never the caught error's message, String(error), stack, or cause.
 */
export function logActiveResourceSnapshot(logDiagnostic: DiagnosticLogger, label: string): void {
  if (!isDiagnosticsEnabled()) return;
  try {
    const counts = getActiveResourceTypeCounts();
    logDiagnostic(`active resource snapshot (${label}): ${JSON.stringify(counts)}`);
  } catch {
    logDiagnostic(`failed to read active resource types (${label})`);
  }
}

/** Resolves after exactly one full event-loop turn (via setImmediate) - used only to take one additional diagnostic snapshot slightly later, never to gate normal control flow. */
export function waitOneEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export const DEFAULT_DIAGNOSTIC_SETTLEMENT_DELAY_MS = 250;

/**
 * Resolves after a short, bounded delay (DEFAULT_DIAGNOSTIC_SETTLEMENT_DELAY_MS
 * by default) - purely to allow one more diagnostic resource snapshot to
 * observe whether handles are STILL active slightly after main() resolves.
 * Callers must gate calling this behind isDiagnosticsEnabled() themselves -
 * this function does not check the flag, since unconditionally adding even
 * a short delay to every normal run would be a real behavior regression.
 *
 * The timer is deliberately left referenced (never `.unref()`'d - an
 * unref'd timer could let Node exit before it ever fires in a process with
 * nothing else keeping it alive, silently skipping this diagnostic
 * entirely) and is always cleared in `finally`. This never conceals a
 * persistent leak: it only adds one more observation point, it never waits
 * out or suppresses a real leak before allowing the process to exit
 * naturally afterward, and it never calls process.exit().
 */
export async function waitForDiagnosticSettlement(
  delayMs: number = DEFAULT_DIAGNOSTIC_SETTLEMENT_DELAY_MS
): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => {
      handle = setTimeout(resolve, delayMs);
    });
  } finally {
    clearTimeout(handle);
  }
}
