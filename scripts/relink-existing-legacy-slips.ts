#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import mysql, { type Connection } from "mysql2/promise";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { validatePrivateR2Config } from "../server/services/r2PrivateConfigValidator";
import {
  chooseVerifiedCandidate,
  classifyBulkRelinkObject,
  isTrustedLegacySlipUrl,
  parseBulkRelinkArgs,
  privateReference,
  sha256,
  type BulkRelinkObject,
  type BulkRelinkRow,
  type BulkRelinkSourceType,
} from "./lib/bulkLegacySlipRelink";

const PREVIEW_DB_HOST = "z71vl8sxkolha3jf644qgsgr";
const PREVIEW_DB_NAME = "ipenovel";
const PREVIEW_BUCKET = "ipenovel-staging-private";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface RuntimeConfig {
  db: mysql.ConnectionOptions;
  r2: ConstructorParameters<typeof S3Client>[0];
  bucket: string;
}

function runtimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const databaseUrl = new URL(env.DATABASE_URL ?? "");
  const database = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (
    databaseUrl.protocol !== "mysql:" ||
    databaseUrl.hostname !== PREVIEW_DB_HOST ||
    (databaseUrl.port && databaseUrl.port !== "3306") ||
    database !== PREVIEW_DB_NAME ||
    !databaseUrl.username ||
    !databaseUrl.password
  )
    throw new Error("PREVIEW_DATABASE_TARGET_MISMATCH");
  const accountId = env.R2_PRIVATE_ACCOUNT_ID?.trim() ?? "";
  const accessKeyId = env.R2_PRIVATE_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.R2_PRIVATE_SECRET_ACCESS_KEY?.trim() ?? "";
  const endpoint = env.R2_PRIVATE_ENDPOINT?.trim() ?? "";
  const bucket = env.R2_PRIVATE_BUCKET_NAME?.trim() ?? "";
  const r2Problem = validatePrivateR2Config({
    accountId,
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucketName: bucket,
    signedUrlExpiresSeconds: 900,
  });
  if (r2Problem || bucket !== PREVIEW_BUCKET)
    throw new Error("PREVIEW_R2_TARGET_MISMATCH");
  return {
    db: {
      host: databaseUrl.hostname,
      port: 3306,
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database,
      connectTimeout: 5_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    },
    r2: {
      endpoint,
      region: "auto",
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId, secretAccessKey },
    },
    bucket,
  };
}

function prefix(sourceType: BulkRelinkSourceType): string {
  return sourceType === "payments"
    ? "payment-slips/legacy/payments/"
    : "payment-slips/legacy/wallet-topups/";
}

async function listObjects(
  client: S3Client,
  bucket: string,
  sourceType: BulkRelinkSourceType
): Promise<{
  byId: Map<number, BulkRelinkObject[]>;
  invalidById: Set<number>;
  invalidGlobal: number;
}> {
  const byId = new Map<number, BulkRelinkObject[]>();
  const invalidById = new Set<number>();
  let invalidGlobal = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix(sourceType),
        MaxKeys: 1_000,
        ...(token ? { ContinuationToken: token } : {}),
      })
    );
    for (const raw of page.Contents ?? []) {
      const result = classifyBulkRelinkObject(sourceType, {
        key: raw.Key,
        etag: raw.ETag,
        size: raw.Size,
      });
      if (result.kind === "candidate") {
        const current = byId.get(result.sourceId) ?? [];
        current.push(result.object);
        byId.set(result.sourceId, current);
      } else if (result.kind === "invalid") {
        if (result.sourceId === undefined) invalidGlobal++;
        else invalidById.add(result.sourceId);
      }
    }
    if (page.IsTruncated && !page.NextContinuationToken)
      throw new Error("INCOMPLETE_R2_LISTING");
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { byId, invalidById, invalidGlobal };
}

async function readObjectHash(
  client: S3Client,
  bucket: string,
  object: BulkRelinkObject
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  let body: any;
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: object.key,
        IfMatch: object.etag,
      }),
      { abortSignal: abort.signal }
    );
    body = response.Body;
    if (
      response.ETag !== object.etag ||
      response.ContentLength !== object.size ||
      !body ||
      object.size > MAX_BODY_BYTES
    )
      throw new Error("R2_OBJECT_CHANGED");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of body as AsyncIterable<Uint8Array>) {
      if (abort.signal.aborted) throw new Error("R2_OBJECT_TIMEOUT");
      const chunk = Buffer.from(raw);
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES || total > object.size)
        throw new Error("R2_OBJECT_TOO_LARGE");
      chunks.push(chunk);
    }
    if (total !== object.size) throw new Error("R2_OBJECT_CHANGED");
    const bytes = Buffer.concat(chunks, total);
    const isJpeg =
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    const isPng =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const isPdf =
      bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    if (!isJpeg && !isPng && !isPdf) throw new Error("UNSUPPORTED_SLIP_BYTES");
    return sha256(bytes);
  } finally {
    clearTimeout(timer);
    try {
      body?.destroy?.();
    } catch {
      // The caller reports a fixed unreadable count; never expose R2 details.
    }
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]);
      }
    })
  );
  return results;
}

async function readRows(
  connection: Connection,
  type: BulkRelinkSourceType | "all"
) {
  const selected: BulkRelinkSourceType[] =
    type === "all" ? ["payments", "wallet"] : [type];
  const rows: BulkRelinkRow[] = [];
  let alreadyPrivate = 0;
  let outOfScope = 0;
  for (const sourceType of selected) {
    const table = sourceType === "payments" ? "payments" : "walletTopups";
    const [raw] = await connection.query<any[]>({
      sql: `SELECT id, slipImageUrl FROM ${table} WHERE slipImageUrl IS NOT NULL AND slipImageUrl <> '' ORDER BY id`,
      timeout: 15_000,
    });
    for (const item of raw) {
      const id = Number(item.id);
      const value = item.slipImageUrl;
      if (!Number.isSafeInteger(id) || id <= 0 || typeof value !== "string")
        throw new Error("INVALID_DATABASE_ROW");
      if (value.startsWith("r2p:")) alreadyPrivate++;
      else if (isTrustedLegacySlipUrl(value))
        rows.push({ sourceType, id, currentValue: value });
      else outOfScope++;
    }
  }
  return { rows, alreadyPrivate, outOfScope };
}

async function updateOne(
  connection: Connection,
  row: BulkRelinkRow,
  nextValue: string
) {
  const table = row.sourceType === "payments" ? "payments" : "walletTopups";
  const [result] = await connection.query<any>({
    sql: `UPDATE ${table} SET slipImageUrl = ? WHERE id = ? AND BINARY slipImageUrl = BINARY ?`,
    values: [nextValue, row.id, row.currentValue],
    timeout: 5_000,
  });
  return Number(result?.affectedRows) === 1;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env
): Promise<number> {
  let args;
  try {
    args = parseBulkRelinkArgs(argv);
  } catch {
    console.error(
      "Usage: --dry-run|--apply --confirm-preview --type=payments|wallet|all " +
        "[--confirm-bulk-relink-all-legacy-slips (required for --apply)]"
    );
    return 2;
  }
  const config = runtimeConfig(env);
  const connection = await mysql.createConnection(config.db);
  const client = new S3Client(config.r2);
  try {
    const inventory = await readRows(connection, args.type);
    const selectedTypes: BulkRelinkSourceType[] =
      args.type === "all" ? ["payments", "wallet"] : [args.type];
    const listings = new Map<
      BulkRelinkSourceType,
      Awaited<ReturnType<typeof listObjects>>
    >();
    for (const sourceType of selectedTypes)
      listings.set(
        sourceType,
        await listObjects(client, config.bucket, sourceType)
      );

    let missing = 0;
    let ambiguous = 0;
    let unreadable = 0;
    let sourceChanged = 0;
    let updated = 0;
    const ready: Array<{ row: BulkRelinkRow; object: BulkRelinkObject }> = [];

    const checked = await mapLimit(inventory.rows, 8, async row => {
      const listing = listings.get(row.sourceType)!;
      if (listing.invalidById.has(row.id))
        return { row, status: "ambiguous" as const };
      const objects = listing.byId.get(row.id) ?? [];
      if (objects.length === 0) return { row, status: "missing" as const };
      try {
        const hashed = await mapLimit(objects, 2, async object => ({
          object,
          hash: await readObjectHash(client, config.bucket, object),
        }));
        const choice = chooseVerifiedCandidate(hashed);
        return choice.status === "ready"
          ? { row, status: "ready" as const, object: choice.object }
          : { row, status: choice.status };
      } catch {
        return { row, status: "unreadable" as const };
      }
    });

    for (const result of checked) {
      if (result.status === "ready")
        ready.push({ row: result.row, object: result.object });
      else if (result.status === "missing") missing++;
      else if (result.status === "ambiguous") ambiguous++;
      else unreadable++;
    }

    if (args.mode === "apply") {
      for (const item of ready) {
        const won = await updateOne(
          connection,
          item.row,
          privateReference(item.object)
        );
        if (won) updated++;
        else sourceChanged++;
      }
    }

    const invalidGlobal = [...listings.values()].reduce(
      (sum, listing) => sum + listing.invalidGlobal,
      0
    );
    console.log(
      JSON.stringify({
        type: "summary",
        mode: args.mode,
        target: "PREVIEW_ALL_LEGACY_SLIPS",
        sourceTypes: selectedTypes,
        legacyRows: inventory.rows.length,
        alreadyPrivate: inventory.alreadyPrivate,
        outOfScope: inventory.outOfScope,
        ready: ready.length,
        missing,
        ambiguous,
        unreadable,
        invalidGlobalObjects: invalidGlobal,
        databaseWrites: args.mode === "apply" ? updated : 0,
        sourceChanged,
        r2Writes: 0,
        r2Deletes: 0,
        nextAction:
          args.mode === "dry-run"
            ? "REVIEW_COUNTS_THEN_APPLY_SAME_SCOPE"
            : "RERUN_SLIP_CLAIMS_BACKFILL_DRY_RUN",
      })
    );
    return missing || ambiguous || unreadable || invalidGlobal || sourceChanged
      ? 1
      : 0;
  } finally {
    client.destroy();
    connection.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    code => {
      process.exitCode = code;
    },
    () => {
      console.error(
        JSON.stringify({ type: "fatal", code: "BULK_RELINK_FAILED" })
      );
      process.exitCode = 2;
    }
  );
}
