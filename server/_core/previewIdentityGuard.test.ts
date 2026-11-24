import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import mysqlPromise from "mysql2/promise";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import {
  evaluatePreviewIdentityConfig,
  isApprovedPreviewMysqlHost,
  PREVIEW_DB_FINGERPRINT_ENV,
  PREVIEW_EXPECTED_DATABASE,
  PREVIEW_MYSQL_CONTAINER_HOST,
  PreviewIdentityGuardError,
  runPreviewIdentityGuard,
  type PreviewLiveConnection,
} from "./previewIdentityGuard";

/**
 * IPE-135-R14/R15 — unit coverage for the preview database identity guard.
 *
 * The guard must be inert for every non-preview environment (Production and
 * Production-Staging boot exactly as before) and fail closed for preview on
 * any misconfiguration, with no connection attempted before the
 * configuration is proven and no credential in any message.
 *
 * Most cases drive the guard with an injected connection factory. The
 * "default driver" block deliberately does NOT: it spies on the real
 * `mysql2/promise` module object and, in one test, runs the real driver
 * against a closed loopback port - so the production code path that connects
 * is exercised too, not only the injected fakes. No database is ever
 * reached: the only network activity is one refused loopback TCP connect.
 */

// The callback API ("mysql2") must never be pulled in by the guard: its
// query() is not awaitable, and a regression to it would start a real dial
// to the container hostname from this unit file. Importing it fails loudly.
vi.mock("mysql2", () => {
  throw new Error("previewIdentityGuard must use mysql2/promise, never the callback API");
});

type Env = Record<string, string | undefined>;
type GuardDeps = Parameters<typeof runPreviewIdentityGuard>[1];

const USER = "ipe_preview";
const PASSWORD = "supersecret123";
const CONTAINER_URL = `mysql://${USER}:${PASSWORD}@${PREVIEW_MYSQL_CONTAINER_HOST}:3306/${PREVIEW_EXPECTED_DATABASE}`;

function loopbackUrl(port = 13307, database = PREVIEW_EXPECTED_DATABASE): string {
  return `mysql://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
}

/** A preview environment whose approved fingerprint matches `databaseUrl`. */
function previewEnv(overrides: Env = {}, databaseUrl: string = CONTAINER_URL): Env {
  return {
    DEPLOYMENT_ENVIRONMENT: "preview",
    DATABASE_URL: databaseUrl,
    [PREVIEW_DB_FINGERPRINT_ENV]: databaseIdentityFingerprint(databaseUrl),
    ...overrides,
  };
}

function expectSecretFree(message: string): void {
  for (const secret of [PASSWORD, USER, "mysql://", "supersecret"]) {
    expect(message, `message must not contain ${JSON.stringify(secret)}`).not.toContain(secret);
  }
}

/** Runs the guard, requires it to reject with a PreviewIdentityGuardError. */
async function guardError(env: Env, deps: GuardDeps = {}): Promise<PreviewIdentityGuardError> {
  const reason: unknown = await runPreviewIdentityGuard(env, deps).then(
    () => {
      throw new Error("expected the guard to reject, but it resolved");
    },
    (error: unknown) => error
  );
  expect(reason).toBeInstanceOf(PreviewIdentityGuardError);
  return reason as PreviewIdentityGuardError;
}

interface FakeConnection extends PreviewLiveConnection {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const OK_ROWS = [
  [{ current_database: PREVIEW_EXPECTED_DATABASE, server_version: "8.0.46" }],
  [],
];

/** mysql2/promise shape: query() resolves `[rows, fields]`. */
function fakeConnection(raw: unknown = OK_ROWS): FakeConnection {
  return { query: vi.fn(async () => raw), end: vi.fn(async () => {}), destroy: vi.fn() };
}

function resolvedFactory(connection: FakeConnection) {
  return vi.fn(async () => connection);
}

function rejectedFactory(error: unknown) {
  return vi.fn(async (): Promise<PreviewLiveConnection> => {
    throw error;
  });
}

function hangingFactory() {
  return vi.fn(() => new Promise<PreviewLiveConnection>(() => {}));
}

afterEach(() => {
  // Restores the spies on the real mysql2/promise module object, so the
  // real-driver test always sees the untouched driver.
  vi.restoreAllMocks();
});

describe("activation - non-preview environments are untouched", () => {
  it.each(["production", "production-staging", "development", "localTest", undefined, ""])(
    "does nothing for DEPLOYMENT_ENVIRONMENT=%s: no checks, no fingerprint needed, no connection",
    async (environment) => {
      const createConnection = rejectedFactory(new Error("must not be called"));
      await expect(
        runPreviewIdentityGuard(
          { DEPLOYMENT_ENVIRONMENT: environment, DATABASE_URL: "garbage, not a url" },
          { createConnection }
        )
      ).resolves.toBeUndefined();
      expect(createConnection).not.toHaveBeenCalled();
    }
  );

  it("activates only for the exact preview environment value (after trim/lowercase)", () => {
    expect(evaluatePreviewIdentityConfig(previewEnv()).active).toBe(true);
    expect(evaluatePreviewIdentityConfig(previewEnv({ DEPLOYMENT_ENVIRONMENT: " PREVIEW " })).active).toBe(true);
    expect(evaluatePreviewIdentityConfig(previewEnv({ DEPLOYMENT_ENVIRONMENT: "prevew" })).active).toBe(false);
  });
});

describe("configuration checks - fail closed BEFORE any connection", () => {
  it("missing DATABASE_URL", async () => {
    const createConnection = rejectedFactory(new Error("must not be called"));
    const error = await guardError({ DEPLOYMENT_ENVIRONMENT: "preview" }, { createConnection });
    expect(error.message).toMatch(/preview configuration failed closed.*DATABASE_URL is missing/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["not a URL", "not a url with password=hunter2"],
    ["a non-MySQL protocol", "postgres://u:hunter2@127.0.0.1/ipenovel_preview_pr135"],
    ["no database name", "mysql://u:hunter2@127.0.0.1:3306/"],
    ["malformed percent-encoding", "mysql://u:h%ZZunter2@127.0.0.1:3306/ipenovel_preview_pr135"],
  ])("DATABASE_URL that is %s", async (_label, databaseUrl) => {
    const createConnection = rejectedFactory(new Error("must not be called"));
    const error = await guardError(previewEnv({ DATABASE_URL: databaseUrl }), { createConnection });
    expect(error.message).toMatch(/not a parseable MySQL URL/);
    expect(createConnection).not.toHaveBeenCalled();
    expectSecretFree(error.message);
    expect(error.message).not.toContain("hunter2");
  });

  it.each(["ipenovel_staging", "ipenovel_test", "ipenovel_preview", "ipenovel_preview_pr135_prod"])(
    "database name %s is not the preview database, even with a matching fingerprint",
    async (database) => {
      const createConnection = rejectedFactory(new Error("must not be called"));
      const error = await guardError(previewEnv({}, loopbackUrl(13307, database)), { createConnection });
      expect(error.message).toMatch(
        new RegExp(`targets database "${database}" but preview deployments require`)
      );
      expect(createConnection).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["any other single-label container", "mysql"],
    ["the integration-test MySQL", "ipenovel-test-mysql8"],
    ["a sibling preview's MySQL", "ipenovel-preview-pr138-mysql8"],
    ["a lookalike of the approved container", "ipenovel-preview-pr135-mysql81"],
    ["a suffix of the approved container", `${PREVIEW_MYSQL_CONTAINER_HOST}.evil.example`],
    ["a wildcard address", "0.0.0.0"],
    ["the production-staging host", "production-staging.ipenovel.com"],
    ["a loopback lookalike", "127.0.0.1.nip.io"],
    ["a localhost lookalike", "localhost.example.com"],
  ])("host %s is outside the approved topology, even with a matching fingerprint", async (_label, host) => {
    const createConnection = rejectedFactory(new Error("must not be called"));
    const databaseUrl = `mysql://${USER}:${PASSWORD}@${host}:3306/${PREVIEW_EXPECTED_DATABASE}`;
    const error = await guardError(previewEnv({}, databaseUrl), { createConnection });
    expect(error.message).toMatch(/outside the approved preview topology/);
    expectSecretFree(error.message);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["the approved container", CONTAINER_URL],
    ["IPv4 loopback", loopbackUrl()],
    ["localhost", `mysql://${USER}:${PASSWORD}@localhost:3306/${PREVIEW_EXPECTED_DATABASE}`],
    ["IPv6 loopback", `mysql://${USER}:${PASSWORD}@[::1]:3306/${PREVIEW_EXPECTED_DATABASE}`],
  ])("accepts %s at the configuration level", (_label, databaseUrl) => {
    expect(evaluatePreviewIdentityConfig(previewEnv({}, databaseUrl)).problems).toEqual([]);
  });

  it("isApprovedPreviewMysqlHost is an exact match, not a pattern", () => {
    expect(isApprovedPreviewMysqlHost(PREVIEW_MYSQL_CONTAINER_HOST)).toBe(true);
    expect(isApprovedPreviewMysqlHost("[::1]")).toBe(true);
    expect(isApprovedPreviewMysqlHost("MySQL")).toBe(false);
  });

  it("the fingerprint pins the port: same host and database on another port is rejected", async () => {
    const createConnection = rejectedFactory(new Error("must not be called"));
    // Approved fingerprint = loopback:13307; URL now points at loopback:13306.
    const error = await guardError(
      previewEnv({ DATABASE_URL: loopbackUrl(3306) }, loopbackUrl(13307)),
      { createConnection }
    );
    expect(error.message).toMatch(/does not match the approved preview database fingerprint/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("the fingerprint pins the host: the container's fingerprint does not approve a loopback URL", async () => {
    const createConnection = rejectedFactory(new Error("must not be called"));
    const error = await guardError(
      previewEnv({ DATABASE_URL: loopbackUrl(3306) }, CONTAINER_URL),
      { createConnection }
    );
    expect(error.message).toMatch(/does not match the approved preview database fingerprint/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, /PREVIEW_DB_FINGERPRINT is missing for a preview deployment/],
    ["blank", "   ", /PREVIEW_DB_FINGERPRINT is missing for a preview deployment/],
    ["not a digest", "approve-this-please", /PREVIEW_DB_FINGERPRINT is malformed/],
    ["one character short", "a".repeat(63), /PREVIEW_DB_FINGERPRINT is malformed/],
    ["not hexadecimal", "z".repeat(64), /PREVIEW_DB_FINGERPRINT is malformed/],
    [
      "another database's digest",
      databaseIdentityFingerprint(`mysql://${USER}:${PASSWORD}@127.0.0.1:3306/ipenovel_staging`),
      /does not match the approved preview database fingerprint/,
    ],
  ])(
    "fails closed before connecting when the approved fingerprint is %s",
    async (_label, fingerprint, expected) => {
      const createConnection = rejectedFactory(new Error("must not be called"));
      const error = await guardError(
        previewEnv({ [PREVIEW_DB_FINGERPRINT_ENV]: fingerprint }),
        { createConnection }
      );
      expect(error.message).toMatch(expected);
      expectSecretFree(error.message);
      expect(createConnection).not.toHaveBeenCalled();
    }
  );

  it("a digest in uppercase is the same approved identity (normalized like the staging guard)", () => {
    const fingerprint = databaseIdentityFingerprint(CONTAINER_URL).toUpperCase();
    expect(evaluatePreviewIdentityConfig(previewEnv({ [PREVIEW_DB_FINGERPRINT_ENV]: fingerprint })).problems).toEqual([]);
  });
});

describe("live verification - server-side identity and version", () => {
  it("resolves for the preview database on MySQL 8 and tears the connection down", async () => {
    const connection = fakeConnection();
    await expect(
      runPreviewIdentityGuard(previewEnv(), { createConnection: resolvedFactory(connection) })
    ).resolves.toBeUndefined();
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.query.mock.calls[0][0]).toContain("SELECT DATABASE()");
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["ipenovel_staging", "ipenovel_test", "ipenovel_preview"])(
    "rejects when the live session database is %s",
    async (database) => {
      const connection = fakeConnection([[{ current_database: database, server_version: "8.0.46" }], []]);
      const error = await guardError(previewEnv(), { createConnection: resolvedFactory(connection) });
      expect(error.message).toMatch(new RegExp(`live session database "${database}" does not match`));
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["5.7.40", "5.7.25-TiDB-v7.5.0", "eight", ""])(
    "rejects when the server version is %j (below major 8 or unreadable)",
    async (server_version) => {
      const connection = fakeConnection([[{ current_database: PREVIEW_EXPECTED_DATABASE, server_version }], []]);
      const error = await guardError(previewEnv(), { createConnection: resolvedFactory(connection) });
      expect(error.message).toMatch(/is below the required major version 8/);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    }
  );

  // A thunk per case: a bare `undefined` row would otherwise fall back to
  // fakeConnection()'s default (the healthy row) instead of being tested.
  it.each([
    ["an empty rowset", (): unknown => [[]]],
    ["no tuple at all", (): unknown => []],
    ["undefined", (): unknown => undefined],
    ["an object instead of a tuple", (): unknown => ({ rows: OK_ROWS })],
  ])("rejects an unexpected query result shape: %s (never treated as a match)", async (_label, produce) => {
    const connection = Object.assign(fakeConnection(), { query: vi.fn(async () => produce()) });
    const error = await guardError(previewEnv(), { createConnection: resolvedFactory(connection) });
    // No readable database name comes back, so the guard prints neither a
    // guess nor an empty quote but the redaction marker.
    expect(error.message).toMatch(/live session database "<redacted>" does not match/);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("a loopback topology is verified the same way - container DNS is not a precondition", async () => {
    const connection = fakeConnection();
    const createConnection = resolvedFactory(connection);
    await expect(
      runPreviewIdentityGuard(previewEnv({}, loopbackUrl(13307)), { createConnection })
    ).resolves.toBeUndefined();
    expect(createConnection).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 13307,
      user: USER,
      password: PASSWORD,
      database: PREVIEW_EXPECTED_DATABASE,
      connectTimeout: 10_000,
    });
  });
});

describe("secret hygiene - driver errors are reported by code only", () => {
  it("an access-denied error never quotes the account, host or address", async () => {
    const error = await guardError(
      previewEnv(),
      {
        createConnection: rejectedFactory(
          Object.assign(
            new Error(`Access denied for user '${USER}'@'172.18.0.5' (using password: YES)`),
            {
              code: "ER_ACCESS_DENIED_ERROR",
              sqlMessage: `Access denied for user '${USER}'@'172.18.0.5'`,
              host: PREVIEW_MYSQL_CONTAINER_HOST,
              address: "172.18.0.5",
              config: { password: PASSWORD },
            }
          )
        ),
      }
    );
    expect(error.message).toMatch(/live connection failed \(driver error code ER_ACCESS_DENIED_ERROR\)\.$/);
    expectSecretFree(error.message);
    expect(error.message).not.toMatch(/Access denied|172\.18\.0\.5/);
    expect(error.message).not.toContain(PREVIEW_MYSQL_CONTAINER_HOST);
  });

  it("an unresolvable container name fails closed without echoing the name", async () => {
    const error = await guardError(
      previewEnv(),
      {
        createConnection: rejectedFactory(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${PREVIEW_MYSQL_CONTAINER_HOST}`), {
            code: "ENOTFOUND",
            hostname: PREVIEW_MYSQL_CONTAINER_HOST,
          })
        ),
      }
    );
    expect(error.message).toMatch(/live connection failed \(driver error code ENOTFOUND\)\.$/);
    expect(error.message).not.toContain(PREVIEW_MYSQL_CONTAINER_HOST);
  });

  it("a query-phase error is sanitized and the connection is still destroyed", async () => {
    const connection = fakeConnection();
    connection.query.mockRejectedValue(
      Object.assign(new Error(`Lost connection to MySQL server at '${USER}:${PASSWORD}'`), {
        code: "PROTOCOL_CONNECTION_LOST",
      })
    );
    const error = await guardError(previewEnv(), { createConnection: resolvedFactory(connection) });
    expect(error.message).toMatch(/live identity query failed \(driver error code PROTOCOL_CONNECTION_LOST\)\.$/);
    expectSecretFree(error.message);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a code carrying free text", { code: "secret: supersecret123", message: "x" }],
    ["a code with a second line", { code: `ER_ACCESS_DENIED_ERROR\npassword=${PASSWORD}`, message: "x" }],
    ["no code at all", new Error(`connect ${PASSWORD} refused for ${USER}`)],
    ["a non-Error rejection", `mysql://${USER}:${PASSWORD}@127.0.0.1/ipenovel_preview_pr135`],
  ])("never forwards $1", async (_label, driverError) => {
    const error = await guardError(previewEnv(), { createConnection: rejectedFactory(driverError) });
    expect(error.message).toMatch(/live connection failed \(unknown driver error\)\.$/);
    expectSecretFree(error.message);
  });

  it("a factory that throws synchronously is a sanitized connection failure", async () => {
    const createConnection = vi.fn((): Promise<PreviewLiveConnection> => {
      throw new Error(`boom ${PASSWORD}`);
    });
    const error = await guardError(previewEnv(), { createConnection });
    expect(error.message).toMatch(/live connection failed \(unknown driver error\)\.$/);
    expectSecretFree(error.message);
  });
});

describe("timeouts, late resolution and cleanup", () => {
  it("a connect that never settles times out", async () => {
    const createConnection = hangingFactory();
    const startedAt = Date.now();
    const error = await guardError(previewEnv(), { createConnection, timeoutMs: 20 });
    expect(error.message).toMatch(/connection timed out after 20ms\.$/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("an identity query that never settles times out and the connection is destroyed", async () => {
    const connection = fakeConnection();
    connection.query.mockImplementation(() => new Promise(() => {}));
    const error = await guardError(previewEnv(), {
      createConnection: resolvedFactory(connection),
      timeoutMs: 20,
    });
    expect(error.message).toMatch(/identity query timed out after 20ms\.$/);
    expect(connection.destroy).toHaveBeenCalledTimes(1);

    // A rejection that arrives after the timeout must not surface later as
    // an unhandled rejection (vitest fails the run on one).
    connection.query.mockRejectedValue(new Error("late query failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("a connection that resolves AFTER the connect timeout is destroyed instead of leaking", async () => {
    let release!: (connection: FakeConnection) => void;
    const createConnection = vi.fn(
      () => new Promise<FakeConnection>((resolve) => (release = resolve))
    );
    const error = await guardError(previewEnv(), { createConnection, timeoutMs: 20 });
    expect(error.message).toMatch(/connection timed out after 20ms\.$/);

    const late = fakeConnection();
    release(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledTimes(1));
    expect(late.query).not.toHaveBeenCalled();
  });

  it("a connection promise that REJECTS after the connect timeout leaves nothing unhandled", async () => {
    let fail!: (reason: unknown) => void;
    const createConnection = vi.fn(
      () => new Promise<PreviewLiveConnection>((_resolve, reject) => (fail = reject))
    );
    await guardError(previewEnv(), { createConnection, timeoutMs: 20 });
    fail(new Error(`late ${PASSWORD}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("a connection without destroy() is closed with a bounded end()", async () => {
    const end = vi.fn(async () => {});
    const query = vi.fn(async () => OK_ROWS);
    const startedAt = Date.now();
    await expect(
      runPreviewIdentityGuard(previewEnv(), { createConnection: async () => ({ query, end }) })
    ).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("a hanging end() on a connection without destroy() cannot block startup", async () => {
    const query = vi.fn(async () => OK_ROWS);
    const end = vi.fn(() => new Promise<void>(() => {}));
    const startedAt = Date.now();
    await expect(
      runPreviewIdentityGuard(previewEnv(), {
        createConnection: async () => ({ query, end }),
        timeoutMs: 20,
      })
    ).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("a failing destroy() never masks the verification outcome", async () => {
    const mismatch = fakeConnection([[{ current_database: "ipenovel_staging", server_version: "8.0.46" }], []]);
    mismatch.destroy.mockImplementation(() => {
      throw new Error("destroy failed");
    });
    const failure = await guardError(previewEnv(), { createConnection: resolvedFactory(mismatch) });
    expect(failure.message).toMatch(/live session database "ipenovel_staging" does not match/);

    const healthy = fakeConnection();
    healthy.destroy.mockImplementation(() => {
      throw new Error("destroy failed");
    });
    await expect(
      runPreviewIdentityGuard(previewEnv(), { createConnection: resolvedFactory(healthy) })
    ).resolves.toBeUndefined();
  });
});

describe("default driver factory - the production connection path, no injected factory", () => {
  it("connects through the real mysql2/promise module with the URL's decoded options", async () => {
    const connection = fakeConnection();
    const spy = vi
      .spyOn(mysqlPromise, "createConnection")
      .mockResolvedValue(connection as unknown as mysqlPromise.Connection);

    // "%40" decodes to "@" - the credential handed to the driver must be decoded.
    const url = `mysql://${USER}:p%40ss@127.0.0.1:13307/${PREVIEW_EXPECTED_DATABASE}`;
    await expect(runPreviewIdentityGuard(previewEnv({}, url), { timeoutMs: 5_000 })).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 13307,
      user: USER,
      password: "p@ss",
      database: PREVIEW_EXPECTED_DATABASE,
      connectTimeout: 5_000,
    });
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports a real-driver rejection by its code, never its message", async () => {
    vi.spyOn(mysqlPromise, "createConnection").mockRejectedValue(
      Object.assign(new Error(`Access denied for user '${USER}'@'10.0.0.5' (using password: YES)`), {
        code: "ER_ACCESS_DENIED_ERROR",
      })
    );
    const error = await guardError(previewEnv({}, loopbackUrl()));
    expect(error.message).toMatch(/live connection failed \(driver error code ER_ACCESS_DENIED_ERROR\)\.$/);
    expectSecretFree(error.message);
  });

  /**
   * The untouched `mysql2/promise` driver, end to end. The port was bound a
   * moment ago and released, so nothing listens there: the driver gets a real
   * ECONNREFUSED (or, on a host that blackholes loopback, a real timeout) -
   * both must surface as ONE sanitized fail-closed error. No database and no
   * remote host is ever contacted.
   */
  it("the untouched mysql2/promise driver fails closed against a closed loopback port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(port).toBeGreaterThan(0);

    const startedAt = Date.now();
    const error = await guardError(previewEnv({}, loopbackUrl(port)), { timeoutMs: 3_000 });
    expect(error.message).toMatch(/live connection failed \((driver error code [A-Z_]+|unknown driver error)\)\.$/);
    expect(error.message).not.toContain("ECONNREFUSED 127.0.0.1");
    expectSecretFree(error.message);
    expect(error.message).not.toContain(String(port));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);
});

describe("boot wiring in server/_core/index.ts", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const startServer = source.slice(source.indexOf("async function startServer("));

  it("imports the guard from this module", () => {
    expect(source).toContain('from "./previewIdentityGuard";');
  });

  it("awaits the guard exactly once, before ensureDatabaseMigrated()", () => {
    expect([...startServer.matchAll(/runPreviewIdentityGuard\(\)/g)]).toHaveLength(1);
    // "await" is what makes a guard rejection stop startup: a bare call
    // would let the rejection slip past while migrations start running.
    const guardAt = startServer.indexOf("await runPreviewIdentityGuard();");
    expect(guardAt).toBeGreaterThan(0);
    const migrateAt = startServer.indexOf("await ensureDatabaseMigrated();");
    expect(migrateAt).toBeGreaterThan(guardAt);
  });
});
