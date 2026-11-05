/**
 * R40R66/R66R1/R66R2/R66R3 — tick CLI unit tests (no real database).
 *
 * Module boundaries are mocked so the REAL CLI code under test keeps:
 *   - the REAL gates snapshot + kill switch (disabled exits 0 before any
 *     database access and before the deployment-identity gate),
 *   - the REAL deployment-identity gate (R40R66R2: production-staging |
 *     local-test; a missing/unknown context refuses - it never skips the
 *     check),
 *   - the REAL staging-isolation gate (fingerprints, collision, URL
 *     identity) via the production-staging channel cases,
 *   - the REAL channel routing (R40R66R3: local-test ->
 *     ensureVerifiedTestDb ONLY, never DATABASE_URL; production-staging ->
 *     getDb),
 *   - the REAL exit-code mapping (0/1/130), signal handling and error
 *     sanitization (safeErrorSummary + redactSensitiveText + JWT-shape
 *     redaction).
 *
 * Database-level delivery semantics (idempotency, leases, retry,
 * dead-letter) are qualified in the integration suites and the spawn E2E
 * (tickCliSpawn.integration.test.ts) and are intentionally not duplicated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import {
  runNotificationsTickCli,
  TICK_EXIT_CODES,
  type TickCliIo,
  type TickCliOptions,
} from "./tickCli";
import type { NotificationTickOutcome } from "./runtimeGate";

// --- module-boundary mocks -------------------------------------------------
const tickMock = vi.hoisted(() => vi.fn<() => Promise<NotificationTickOutcome>>());
const runtimeOptionsCaptured = vi.hoisted(() => [] as Array<{
  flags: { notificationsEnabled: boolean; deliveryEnabled: boolean };
  loadDatabase: () => Promise<unknown>;
}>);
const createRuntimeMock = vi.hoisted(() => vi.fn());
const getDbMock = vi.hoisted(() => vi.fn());
const ensureVerifiedTestDbMock = vi.hoisted(() => vi.fn());

vi.mock("./controlledRuntime", () => ({
  createControlledNotificationRuntime: (...args: unknown[]) => {
    runtimeOptionsCaptured.push(args[0] as (typeof runtimeOptionsCaptured)[number]);
    return createRuntimeMock(...args);
  },
}));
vi.mock("../db", () => ({ getDb: getDbMock }));
vi.mock("../test-helpers/testDb", () => ({
  ensureVerifiedTestDb: ensureVerifiedTestDbMock,
  getTestDb: vi.fn(),
}));

// createControlledNotificationRuntime must return a tick-able runtime.
createRuntimeMock.mockImplementation(() => ({ tick: tickMock }));

// --- helpers ---------------------------------------------------------------

type CompletedTickResult = Extract<NotificationTickOutcome, { status: "completed" }>["result"];

function completedOutcome(overrides: Partial<CompletedTickResult> = {}): NotificationTickOutcome {
  return {
    status: "completed",
    result: {
      claimed: 0, created: 0, alreadyExists: 0, dismissed: 0, ineligible: 0,
      completed: 0, partial: 0, retried: 0, deadLettered: 0,
      ...overrides,
    },
  };
}

function makeIo() {
  const exitCodes: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const signalHandlers: Array<() => void> = [];
  const io: TickCliIo = {
    log: m => logs.push(m),
    error: m => errors.push(m),
    exit: code => {
      exitCodes.push(code);
      // mimic process.exit: stop the async function by throwing a sentinel
      throw Object.assign(new Error(`exit ${code}`), { isExitCall: true });
    },
    onSignal: handler => {
      signalHandlers.push(handler);
      return () => undefined;
    },
  };
  return {
    io,
    exitCodes,
    logs,
    errors,
    signalHandlers,
    /** Run the CLI, capturing exit sentinels instead of letting them bubble. */
    run: async (options: TickCliOptions) => {
      try {
        await runNotificationsTickCli(options);
      } catch (error) {
        if (!((error as any)?.isExitCall)) throw error;
      }
    },
  };
}

function fakeDatabase() {
  // Only the shape loadStore() validates is needed; the runtime itself is
  // mocked, so no SQL ever runs against this object.
  return { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) };
}

const STAGING_DATABASE_URL = "mysql://staging-user:staging-pw@stagedb.internal:3306/ipenovel_test";
const PRODUCTION_DATABASE_URL = "mysql://prod-user:prod-pw@proddb.internal:3306/ipenovel_prod";
const STAGING_FINGERPRINT = databaseIdentityFingerprint(STAGING_DATABASE_URL);
const PRODUCTION_FINGERPRINT = databaseIdentityFingerprint(PRODUCTION_DATABASE_URL);

const ENABLED_LOCAL_TEST_ENV = {
  // A Production-shaped DATABASE_URL must be IGNORED on the local-test
  // channel (R40R66R3: no DATABASE_URL fallback).
  DATABASE_URL: PRODUCTION_DATABASE_URL,
  DEPLOYMENT_ENVIRONMENT: "local-test",
  TEST_DATABASE_URL: "mysql://fixture.internal:3306/ipenovel_test",
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_DELIVERY_ENABLED: "true",
};

const ENABLED_STAGING_ENV = {
  DATABASE_URL: STAGING_DATABASE_URL,
  DEPLOYMENT_ENVIRONMENT: "production-staging",
  PRODUCTION_STAGING_DB_FINGERPRINT: STAGING_FINGERPRINT,
  PRODUCTION_DB_FINGERPRINT: PRODUCTION_FINGERPRINT,
  NOTIFICATIONS_ENABLED: "true",
  NOTIFICATIONS_DELIVERY_ENABLED: "true",
};

beforeEach(() => {
  runtimeOptionsCaptured.length = 0;
  tickMock.mockReset();
  createRuntimeMock.mockReset();
  createRuntimeMock.mockImplementation(() => ({ tick: tickMock }));
  getDbMock.mockReset();
  ensureVerifiedTestDbMock.mockReset();
});

// --- tests -----------------------------------------------------------------

describe("R40R66 notifications tick CLI — kill switch and flags snapshot", () => {
  it("a disabled environment exits 0 BEFORE any database access or identity gate", async () => {
    // NOTIFICATIONS_ENABLED missing -> master gate off. No
    // DEPLOYMENT_ENVIRONMENT either: the kill switch precedes the identity
    // gate, so a disabled run needs no deployment context at all.
    const io = makeIo();
    await io.run({
      env: { NOTIFICATIONS_DELIVERY_ENABLED: "true" },
      io: io.io,
    });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.OK]);
    expect(getDbMock).not.toHaveBeenCalled();
    expect(ensureVerifiedTestDbMock).not.toHaveBeenCalled();
    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(io.logs.join(" ")).toContain('"status":"disabled"');
  });

  it("an enabled run hands the runtime a FIXED flags snapshot plus the channel opener", async () => {
    const io = makeIo();
    tickMock.mockResolvedValue(completedOutcome());
    ensureVerifiedTestDbMock.mockResolvedValue(fakeDatabase());
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(createRuntimeMock).toHaveBeenCalledTimes(1);
    expect(runtimeOptionsCaptured[0].flags).toEqual({
      notificationsEnabled: true,
      deliveryEnabled: true,
      checkinRemindersEnabled: false,
      catalogFanoutEnabled: false,
    });
    expect(typeof runtimeOptionsCaptured[0].loadDatabase).toBe("function");
    expect(tickMock).toHaveBeenCalledTimes(1);
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.OK]);
  });
});

describe("R40R66R3 channel routing", () => {
  it("local-test routes to ensureVerifiedTestDb and NEVER falls back to DATABASE_URL", async () => {
    const io = makeIo();
    const testDatabase = fakeDatabase();
    tickMock.mockResolvedValue(completedOutcome());
    ensureVerifiedTestDbMock.mockResolvedValue(testDatabase);
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    // The routing opener is invoked lazily by the runtime; drive it directly.
    const database = await runtimeOptionsCaptured[0].loadDatabase();
    expect(database).toBe(testDatabase);
    expect(ensureVerifiedTestDbMock).toHaveBeenCalledTimes(1);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("production-staging routes to getDb after the real staging-isolation gate passes", async () => {
    const io = makeIo();
    const stagingDatabase = fakeDatabase();
    tickMock.mockResolvedValue(completedOutcome());
    getDbMock.mockReturnValue(stagingDatabase);
    await io.run({ env: ENABLED_STAGING_ENV, io: io.io });
    const database = await runtimeOptionsCaptured[0].loadDatabase();
    expect(database).toBe(stagingDatabase);
    expect(getDbMock).toHaveBeenCalledTimes(1);
    expect(ensureVerifiedTestDbMock).not.toHaveBeenCalled();
    expect(io.logs.join(" ")).toContain('"status":"completed"');
  });
});

describe("R40R66 one-shot invocation semantics", () => {
  it("a completed tick logs the result JSON and exits 0 exactly once", async () => {
    const io = makeIo();
    tickMock.mockResolvedValue(completedOutcome({ claimed: 1, created: 1, completed: 1 }));
    ensureVerifiedTestDbMock.mockResolvedValue(fakeDatabase());
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.OK]);
    expect(tickMock).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(io.logs.find(l => l.startsWith("{")) ?? "{}") as Record<string, unknown>;
    expect(logged.status).toBe("completed");
    expect(logged.claimed).toBe(1);
    expect(logged.completed).toBe(1);
  });

  it("a busy outcome is reported and exits 0 (single-shot processes report, not retry)", async () => {
    const io = makeIo();
    tickMock.mockResolvedValue({ status: "busy" });
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.OK]);
    expect(io.logs.join(" ")).toContain('"status":"busy"');
  });

  it("a runtime failure exits 1 with a sanitized error and never a false success", async () => {
    const io = makeIo();
    tickMock.mockRejectedValue(new Error("connection refused"));
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.FAILURE]);
    expect(io.errors.join(" ")).toContain('"status":"failed"');
    expect(io.errors.join(" ")).toContain("connection refused");
  });
});

describe("R40R66R2 scheduler deployment-identity gate (negative matrix)", () => {
  async function expectEnvFailure(env: NodeJS.ProcessEnv, messagePattern: RegExp): Promise<void> {
    const io = makeIo();
    await io.run({ env, io: io.io });
    // Refusal happens BEFORE any database opener and BEFORE runtime creation.
    expect(getDbMock).not.toHaveBeenCalled();
    expect(ensureVerifiedTestDbMock).not.toHaveBeenCalled();
    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(runtimeOptionsCaptured.length).toBe(0);
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.FAILURE]);
    expect(io.errors.join(" ")).toMatch(messagePattern);
  }

  it("missing DEPLOYMENT_ENVIRONMENT -> refuse (a missing context must not skip the check)", async () => {
    const env = { ...ENABLED_LOCAL_TEST_ENV };
    delete (env as Record<string, unknown>).DEPLOYMENT_ENVIRONMENT;
    await expectEnvFailure(env, /DEPLOYMENT_ENVIRONMENT is required/);
  });

  it("unknown DEPLOYMENT_ENVIRONMENT value -> refuse", async () => {
    await expectEnvFailure(
      { ...ENABLED_LOCAL_TEST_ENV, DEPLOYMENT_ENVIRONMENT: "some-future-env" },
      /unknown DEPLOYMENT_ENVIRONMENT/
    );
  });

  it("a production channel is deliberately unreachable today (staging-first policy)", async () => {
    await expectEnvFailure(
      { ...ENABLED_LOCAL_TEST_ENV, DEPLOYMENT_ENVIRONMENT: "production" },
      /unknown DEPLOYMENT_ENVIRONMENT/
    );
  });

  it("local-test channel without TEST_DATABASE_URL -> refuse before any database access", async () => {
    const env = { ...ENABLED_LOCAL_TEST_ENV };
    delete (env as Record<string, unknown>).TEST_DATABASE_URL;
    await expectEnvFailure(env, /TEST_DATABASE_URL is required/);
  });

  it("production-staging channel with missing fingerprints -> refuse (real isolation gate)", async () => {
    const env = { ...ENABLED_STAGING_ENV };
    delete (env as Record<string, unknown>).PRODUCTION_STAGING_DB_FINGERPRINT;
    delete (env as Record<string, unknown>).PRODUCTION_DB_FINGERPRINT;
    await expectEnvFailure(env, /\[staging-safety\]/);
  });

  it("production-staging channel with IDENTICAL staging/production fingerprints -> refuse (collision)", async () => {
    await expectEnvFailure(
      {
        ...ENABLED_STAGING_ENV,
        PRODUCTION_STAGING_DB_FINGERPRINT: STAGING_FINGERPRINT,
        PRODUCTION_DB_FINGERPRINT: STAGING_FINGERPRINT,
      },
      /must differ/
    );
  });

  it("production-staging channel whose DATABASE_URL resolves to Production -> refuse", async () => {
    await expectEnvFailure(
      {
        ...ENABLED_STAGING_ENV,
        DATABASE_URL: PRODUCTION_DATABASE_URL,
      },
      /resolves to the Production database identity/
    );
  });
});

describe("R40R66R1 graceful shutdown (SIGTERM/SIGINT)", () => {
  it("a signal during an in-flight tick exits 130 — never downgraded by the sanitization catch", async () => {
    const io = makeIo();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    tickMock.mockImplementation(async () => {
      await gate;
      return completedOutcome();
    });
    ensureVerifiedTestDbMock.mockResolvedValue(fakeDatabase());
    const runPromise = io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.signalHandlers.length).toBe(1);
    io.signalHandlers[0]();
    release();
    await runPromise;
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.TERMINATED]);
    expect(io.logs.join(" ")).toContain('"status":"terminated"');
    expect(io.errors.join(" ")).not.toContain('"status":"failed"');
  });

  it("a completed one-shot run exits 0 with the signal handler registered", async () => {
    const io = makeIo();
    tickMock.mockResolvedValue(completedOutcome());
    ensureVerifiedTestDbMock.mockResolvedValue(fakeDatabase());
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.OK]);
    expect(tickMock).toHaveBeenCalledTimes(1);
  });
});

describe("R40R66R1 error sanitization (safeErrorSummary + redactSensitiveText + JWT redaction)", () => {
  const SECRETS = [
    "mysql://notifications:S3cr3tPassw0rd@10.20.30.40:3306/ipenovel_prod",
    "postgres://scheduler:p%4055w0rd@db-credentials.internal.example.com:5432/app",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "insert into `users` (`email`, `passwordHash`) values ('victim@example.com', '$2b$10$HashValue') params: 42",
    "'root'@'10.0.0.5' password=hunter2 api_key=AKIA1234567890ABCDEF",
  ];

  async function failingCli(throwable: unknown): Promise<string> {
    const io = makeIo();
    tickMock.mockRejectedValue(throwable);
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.exitCodes).toEqual([TICK_EXIT_CODES.FAILURE]);
    return io.errors.join("\n") + "\n" + io.logs.join("\n");
  }

  it.each(SECRETS.map(secret => [secret.slice(0, 44), secret] as const))(
    "never emits the raw secret into operator output (%s)",
    async (_label, secret) => {
      const output = await failingCli(new Error(`connection failed: ${secret}`));
      expect(output).not.toContain(secret);
      expect(output).toContain('"status":"failed"');
    }
  );

  it("a JWT-shaped secret is replaced by [redacted-token] by the CLI-level regex", async () => {
    const jwt = SECRETS[2];
    const output = await failingCli(new Error(`auth rejected: ${jwt}`));
    expect(output).not.toContain(jwt);
    expect(output).toContain("[redacted-token]");
  });

  it("drizzle-style SQL failures: SQL text and bound params are dropped, driver code survives", async () => {
    const drizzleError = new Error(
      "Failed query: insert into `users` (`email`) values ('victim@example.com') params: secretvalue,42"
    );
    (drizzleError as any).code = "ER_DUP_ENTRY";
    (drizzleError as any).errno = 1062;
    (drizzleError as any).sqlState = "23000";
    const output = await failingCli(drizzleError);
    expect(output).not.toContain("victim@example.com");
    expect(output).not.toContain("secretvalue");
    expect(output).not.toContain("insert into");
    expect(output).toContain("errno=1062");
    expect(output).toContain("ER_DUP_ENTRY");
  });

  it("a wrapped mysql2 driver error keeps only code/errno/sqlState and the sanitized driver message", async () => {
    const driverError = Object.assign(
      new Error("Table 'ipenovel_test.notificationEvents' doesn't exist"),
      { code: "ER_NO_SUCH_TABLE", errno: 1146, sqlState: "42S02" }
    );
    const wrapped = new Error("mysql://user:secretpw@host.internal/db - query failed", { cause: driverError });
    const output = await failingCli(wrapped);
    expect(output).not.toContain("secretpw");
    expect(output).not.toContain("mysql://user:secretpw@host.internal/db");
    expect(output).toContain("ER_NO_SUCH_TABLE");
    expect(output).toContain("errno=1146");
  });

  it("the failure note steers operators to the lease table without claiming a specific state", async () => {
    const io = makeIo();
    tickMock.mockRejectedValue(new Error("boom"));
    await io.run({ env: ENABLED_LOCAL_TEST_ENV, io: io.io });
    expect(io.errors.join(" ")).toContain("notificationOutbox");
  });
});
