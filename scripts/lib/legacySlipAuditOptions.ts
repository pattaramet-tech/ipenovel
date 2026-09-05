import { validatePrivateR2Config } from "../../server/services/r2PrivateConfigValidator.ts";

export type AuditOptionsErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_DATABASE_CONFIG"
  | "PREVIEW_TARGET_MISMATCH"
  | "INVALID_PRIVATE_R2_CONFIG";

/** Fixed codes only; config values and credentials must never enter errors. */
export class AuditOptionsError extends Error {
  constructor(readonly code: AuditOptionsErrorCode) {
    super(code);
    this.name = "AuditOptionsError";
  }
}

export function parseLegacySlipAuditArgs(
  argv: readonly string[]
): "help" | "audit" {
  if (argv.length === 1 && argv[0] === "--help") return "help";
  if (
    argv.length === 2 &&
    new Set(argv).size === 2 &&
    argv.includes("--dry-run") &&
    argv.includes("--confirm-preview")
  )
    return "audit";
  throw new AuditOptionsError("INVALID_ARGUMENTS");
}

const EXACT_TARGETS = [
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
] as const;

export const PREVIEW_AUDIT_TARGETS = Object.freeze(
  EXACT_TARGETS.map(target => Object.freeze(target))
);

export interface LegacySlipAuditEnvironment {
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectTimeout: 5000;
    supportBigNumbers: true;
    bigNumberStrings: true;
    multipleStatements: false;
  };
  r2: {
    endpoint: string;
    region: "auto";
    forcePathStyle: true;
    maxAttempts: 1;
    credentials: { accessKeyId: string; secretAccessKey: string };
    bucket: string;
  };
}

/** Pure preflight only: no dotenv, client construction, database or network. */
export function validateLegacySlipAuditEnvironment(
  env: NodeJS.ProcessEnv
): LegacySlipAuditEnvironment {
  let databaseUrl: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    const raw = env.DATABASE_URL;
    if (!raw || /[?#]/.test(raw)) throw new Error();
    databaseUrl = new URL(raw);
    if (databaseUrl.protocol !== "mysql:") throw new Error();
    user = decodeURIComponent(databaseUrl.username);
    password = decodeURIComponent(databaseUrl.password);
    database = decodeURIComponent(databaseUrl.pathname.slice(1));
    if (!user || !password) throw new Error();
  } catch {
    throw new AuditOptionsError("INVALID_DATABASE_CONFIG");
  }

  if (
    databaseUrl.hostname !== "z71vl8sxkolha3jf644qgsgr" ||
    (databaseUrl.port !== "" && databaseUrl.port !== "3306") ||
    database !== "ipenovel"
  ) {
    throw new AuditOptionsError("PREVIEW_TARGET_MISMATCH");
  }

  // These PRIVATE names match server/_core/env.ts. Public R2_* credentials
  // are deliberately not fallbacks, even when they appear well-formed.
  const r2 = {
    accountId: (env.R2_PRIVATE_ACCOUNT_ID ?? "").trim(),
    accessKeyId: (env.R2_PRIVATE_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: (env.R2_PRIVATE_SECRET_ACCESS_KEY ?? "").trim(),
    endpoint: (env.R2_PRIVATE_ENDPOINT ?? "").trim(),
    bucketName: (env.R2_PRIVATE_BUCKET_NAME ?? "").trim(),
    signedUrlExpiresSeconds:
      env.R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS === undefined
        ? 900
        : Number(env.R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS),
  };
  if (validatePrivateR2Config(r2))
    throw new AuditOptionsError("INVALID_PRIVATE_R2_CONFIG");
  if (r2.bucketName !== "ipenovel-staging-private")
    throw new AuditOptionsError("PREVIEW_TARGET_MISMATCH");

  return {
    db: {
      host: databaseUrl.hostname,
      port: 3306,
      user,
      password,
      database,
      connectTimeout: 5000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    },
    r2: {
      endpoint: r2.endpoint,
      region: "auto",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
      bucket: r2.bucketName,
    },
  };
}
