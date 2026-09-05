import { createHash } from "node:crypto";

export type BulkRelinkSourceType = "payments" | "wallet";

export interface BulkRelinkRow {
  sourceType: BulkRelinkSourceType;
  id: number;
  currentValue: string;
}

export interface BulkRelinkObject {
  key: string;
  etag: string;
  size: number;
}

export interface BulkRelinkArgs {
  mode: "dry-run" | "apply";
  type: BulkRelinkSourceType | "all";
}

const APPLY_CONFIRMATION = "--confirm-bulk-relink-all-legacy-slips";

export function parseBulkRelinkArgs(argv: readonly string[]): BulkRelinkArgs {
  const flags = new Set(argv);
  if (flags.size !== argv.length) throw new Error("INVALID_ARGUMENTS");
  const dryRun = flags.has("--dry-run");
  const apply = flags.has("--apply");
  if (dryRun === apply || !flags.has("--confirm-preview"))
    throw new Error("INVALID_ARGUMENTS");
  const typeFlag = argv.find(value => value.startsWith("--type="));
  const type = typeFlag?.slice("--type=".length);
  if (!type || !["payments", "wallet", "all"].includes(type))
    throw new Error("INVALID_ARGUMENTS");
  const allowed = new Set([
    dryRun ? "--dry-run" : "--apply",
    "--confirm-preview",
    typeFlag,
    ...(apply ? [APPLY_CONFIRMATION] : []),
  ]);
  if (
    argv.some(value => !allowed.has(value)) ||
    (apply && !flags.has(APPLY_CONFIRMATION)) ||
    (!apply && flags.has(APPLY_CONFIRMATION))
  )
    throw new Error("INVALID_ARGUMENTS");
  return {
    mode: dryRun ? "dry-run" : "apply",
    type: type as BulkRelinkArgs["type"],
  };
}

export function isTrustedLegacySlipUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "d2xsxph8kpxj0f.cloudfront.net" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function rootPrefix(sourceType: BulkRelinkSourceType): string {
  return sourceType === "payments"
    ? "payment-slips/legacy/payments/"
    : "payment-slips/legacy/wallet-topups/";
}

export function classifyBulkRelinkObject(
  sourceType: BulkRelinkSourceType,
  input: { key?: unknown; etag?: unknown; size?: unknown }
):
  | { kind: "directory" }
  | { kind: "invalid"; sourceId?: number }
  | { kind: "candidate"; sourceId: number; object: BulkRelinkObject } {
  const prefix = rootPrefix(sourceType);
  const key = input.key;
  const size = input.size;
  if (key === prefix && size === 0) return { kind: "directory" };
  if (typeof key !== "string" || !key.startsWith(prefix))
    return { kind: "invalid" };
  const relative = key.slice(prefix.length);
  const firstSlash = relative.indexOf("/");
  const rawId = firstSlash < 0 ? relative : relative.slice(0, firstSlash);
  const parsedId = /^(?:[1-9][0-9]*)$/.test(rawId) ? Number(rawId) : NaN;
  const sourceId = Number.isSafeInteger(parsedId) ? parsedId : undefined;
  const fileName = firstSlash < 0 ? "" : relative.slice(firstSlash + 1);
  if (
    sourceId === undefined ||
    !/^\d+-[a-z0-9]+\.(?:jpg|png|pdf)$/.test(fileName) ||
    typeof input.etag !== "string" ||
    !/^"[A-Za-z0-9._-]+"$/.test(input.etag) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 8 * 1024 * 1024
  )
    return { kind: "invalid", ...(sourceId === undefined ? {} : { sourceId }) };
  return {
    kind: "candidate",
    sourceId,
    object: { key, etag: input.etag, size },
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function chooseVerifiedCandidate(
  candidates: readonly { object: BulkRelinkObject; hash: string }[]
):
  | { status: "ready"; object: BulkRelinkObject }
  | { status: "missing" | "ambiguous" } {
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.some(value => !/^[a-f0-9]{64}$/.test(value.hash)))
    return { status: "ambiguous" };
  if (new Set(candidates.map(value => value.hash)).size !== 1)
    return { status: "ambiguous" };
  const selected = [...candidates]
    .sort((left, right) =>
      left.object.key.localeCompare(right.object.key, "en")
    )
    .at(-1)!;
  return { status: "ready", object: selected.object };
}

export function privateReference(object: BulkRelinkObject): string {
  return `r2p:${object.key}`;
}
