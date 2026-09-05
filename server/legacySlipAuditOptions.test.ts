import { describe, expect, it, vi } from "vitest";
import {
  AuditOptionsError,
  parseLegacySlipAuditArgs,
  PREVIEW_AUDIT_TARGETS,
  validateLegacySlipAuditEnvironment,
} from "../scripts/lib/legacySlipAuditOptions";

const HOST = "z71vl8sxkolha3jf644qgsgr";
function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: `mysql://audit-user:private-db-password@${HOST}/ipenovel`,
    R2_PRIVATE_ACCOUNT_ID: "auditaccount",
    R2_PRIVATE_ACCESS_KEY_ID: "private-access-key",
    R2_PRIVATE_SECRET_ACCESS_KEY: "private-secret-key",
    R2_PRIVATE_ENDPOINT: "https://auditaccount.r2.cloudflarestorage.com",
    R2_PRIVATE_BUCKET_NAME: "ipenovel-staging-private",
    ...overrides,
  };
}

describe("legacy slip read-only audit arguments", () => {
  it("accepts standalone help without consulting the environment", () => {
    expect(parseLegacySlipAuditArgs(["--help"])).toBe("help");
  });

  it.each([
    ["--dry-run", "--confirm-preview"],
    ["--confirm-preview", "--dry-run"],
  ])("accepts exactly the two mandatory audit flags (%j)", (...args) => {
    expect(parseLegacySlipAuditArgs(args)).toBe("audit");
  });

  it.each([
    [],
    ["--dry-run"],
    ["--confirm-preview"],
    ["--help", "--dry-run"],
    ["--help", "--help"],
    ["--dry-run", "--dry-run"],
    ["--confirm-preview", "--confirm-preview"],
    ["--dry-run", "--confirm-preview", "--dry-run"],
    ["--dry-run", "--confirm-preview", "--live"],
    ["--dry-run", "--confirm-preview", "--apply"],
    ["--dry-run", "--confirm-preview", "--limit", "10"],
    ["--dry-run", "--confirm-preview", "--unknown"],
    ["--dry-run=true", "--confirm-preview"],
    ["--live", "--confirm-preview"],
    ["--apply", "--confirm-preview"],
    ["--dry-run", "--confirm-preview", "secret-option-value"],
  ])("rejects every other argument set (%j)", (...args) => {
    try {
      parseLegacySlipAuditArgs(args);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AuditOptionsError);
      expect(error).toMatchObject({
        code: "INVALID_ARGUMENTS",
        message: "INVALID_ARGUMENTS",
      });
    }
  });
});

describe("legacy slip exact Preview environment", () => {
  it("returns constrained connection options with defaults", () => {
    expect(validateLegacySlipAuditEnvironment(validEnv())).toEqual({
      db: {
        host: HOST,
        port: 3306,
        user: "audit-user",
        password: "private-db-password",
        database: "ipenovel",
        connectTimeout: 5000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
      },
      r2: {
        endpoint: "https://auditaccount.r2.cloudflarestorage.com",
        region: "auto",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: "private-access-key",
          secretAccessKey: "private-secret-key",
        },
        bucket: "ipenovel-staging-private",
      },
    });
  });

  it("decodes credentials/database and permits explicit port3306", () => {
    const result = validateLegacySlipAuditEnvironment(
      validEnv({
        DATABASE_URL: `mysql://audit%40user:p%40ss%3Aword%23%3F@${HOST}:3306/%69penovel`,
      })
    );
    expect(result.db).toMatchObject({
      user: "audit@user",
      password: "p@ss:word#?",
      database: "ipenovel",
      port: 3306,
    });
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    `postgres://user:pass@${HOST}/ipenovel`,
    `mysql://user@${HOST}/ipenovel`,
    `mysql://:pass@${HOST}/ipenovel`,
    `mysql://user:pass@${HOST}/ipenovel?ssl=true`,
    `mysql://user:pass@${HOST}/ipenovel#fragment`,
    `mysql://user:pass@${HOST}/ipenovel?`,
    `mysql://user:pass@${HOST}/ipenovel#`,
    `mysql://bad%ZZ:pass@${HOST}/ipenovel`,
    `mysql://user:bad%ZZ@${HOST}/ipenovel`,
    `mysql://user:pass@${HOST}/ipenovel%ZZ`,
  ])(
    "rejects invalid database configuration without exposing it (%s)",
    DATABASE_URL => {
      expect(() =>
        validateLegacySlipAuditEnvironment(validEnv({ DATABASE_URL }))
      ).toThrowError("INVALID_DATABASE_CONFIG");
    }
  );

  it.each([
    "mysql://user:pass@localhost/ipenovel",
    "mysql://user:pass@production-db/ipenovel",
    `mysql://user:pass@${HOST}:3307/ipenovel`,
    `mysql://user:pass@${HOST}/ipenovel_test`,
    `mysql://user:pass@${HOST}/ipenovel/other`,
    `mysql://user:pass@${HOST}/`,
  ])("rejects another database target (%s)", DATABASE_URL => {
    expect(() =>
      validateLegacySlipAuditEnvironment(validEnv({ DATABASE_URL }))
    ).toThrowError("PREVIEW_TARGET_MISMATCH");
  });

  it.each([
    "R2_PRIVATE_ACCOUNT_ID",
    "R2_PRIVATE_ACCESS_KEY_ID",
    "R2_PRIVATE_SECRET_ACCESS_KEY",
    "R2_PRIVATE_ENDPOINT",
    "R2_PRIVATE_BUCKET_NAME",
  ])(
    "requires the actual private variable %s with no public fallback",
    missingKey => {
      const env = validEnv({
        [missingKey]: undefined,
        R2_ACCOUNT_ID: "auditaccount",
        R2_ACCESS_KEY_ID: "public-access",
        R2_SECRET_ACCESS_KEY: "public-secret",
        R2_ENDPOINT: "https://auditaccount.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "ipenovel-staging-private",
      });
      expect(() => validateLegacySlipAuditEnvironment(env)).toThrowError(
        "INVALID_PRIVATE_R2_CONFIG"
      );
    }
  );

  it.each([
    { R2_PRIVATE_ENDPOINT: "http://auditaccount.r2.cloudflarestorage.com" },
    { R2_PRIVATE_ENDPOINT: "https://attacker.invalid" },
    { R2_PRIVATE_ENDPOINT: "https://otheraccount.r2.cloudflarestorage.com" },
    {
      R2_PRIVATE_ENDPOINT:
        "https://auditaccount.r2.cloudflarestorage.com/bucket",
    },
    {
      R2_PRIVATE_ENDPOINT:
        "https://auditaccount.r2.cloudflarestorage.com?secret=query",
    },
    {
      R2_PRIVATE_ENDPOINT:
        "https://user:pass@auditaccount.r2.cloudflarestorage.com",
    },
    { R2_PRIVATE_BUCKET_NAME: "https://invalid-bucket" },
    { R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "0" },
    { R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "" },
    { R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "not-a-number" },
    { R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "604801" },
  ])("uses the existing private-R2 structural validator (%j)", overrides => {
    expect(() =>
      validateLegacySlipAuditEnvironment(validEnv(overrides))
    ).toThrowError("INVALID_PRIVATE_R2_CONFIG");
  });

  it("refuses a valid non-Preview bucket", () => {
    expect(() =>
      validateLegacySlipAuditEnvironment(
        validEnv({ R2_PRIVATE_BUCKET_NAME: "ipenovel-production-private" })
      )
    ).toThrowError("PREVIEW_TARGET_MISMATCH");
  });

  it("trims private values consistently with the private storage client", () => {
    const result = validateLegacySlipAuditEnvironment(
      validEnv({
        R2_PRIVATE_ACCOUNT_ID: " auditaccount ",
        R2_PRIVATE_ACCESS_KEY_ID: " access ",
        R2_PRIVATE_SECRET_ACCESS_KEY: " secret ",
        R2_PRIVATE_ENDPOINT: " https://auditaccount.r2.cloudflarestorage.com ",
        R2_PRIVATE_BUCKET_NAME: " ipenovel-staging-private ",
        R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "900",
      })
    );
    expect(result.r2.credentials).toEqual({
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
    expect(result.r2.bucket).toBe("ipenovel-staging-private");
  });

  it("never logs config or carries source errors/secret values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = validEnv({
        DATABASE_URL:
          "mysql://secret-user:super-secret-password@production-db/ipenovel",
      });
      const error = (() => {
        try {
          validateLegacySlipAuditEnvironment(config);
        } catch (value) {
          return value as AuditOptionsError;
        }
        throw new Error("expected rejection");
      })();
      expect(error.message).toBe("PREVIEW_TARGET_MISMATCH");
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("production-db");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
});

describe("legacy slip audit immutable ten-row scope", () => {
  it("contains only the ten authorized source/id pairs", () => {
    expect(PREVIEW_AUDIT_TARGETS).toEqual([
      { sourceType: "order_payment", sourceId: 11280001 },
      { sourceType: "order_payment", sourceId: 11310001 },
      { sourceType: "order_payment", sourceId: 11340002 },
      { sourceType: "order_payment", sourceId: 11340004 },
      { sourceType: "order_payment", sourceId: 11370001 },
      { sourceType: "wallet_topup", sourceId: 180001 },
      { sourceType: "wallet_topup", sourceId: 210001 },
      { sourceType: "wallet_topup", sourceId: 240001 },
      { sourceType: "wallet_topup", sourceId: 270001 },
      { sourceType: "wallet_topup", sourceId: 300001 },
    ]);
    expect(
      new Set(
        PREVIEW_AUDIT_TARGETS.map(
          target => `${target.sourceType}:${target.sourceId}`
        )
      ).size
    ).toBe(10);
  });

  it("freezes the array and every target object at runtime", () => {
    expect(Object.isFrozen(PREVIEW_AUDIT_TARGETS)).toBe(true);
    for (const target of PREVIEW_AUDIT_TARGETS)
      expect(Object.isFrozen(target)).toBe(true);
  });
});
