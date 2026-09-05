import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { platform } from "node:os";
import { types } from "node:util";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const LEGACY_SLIP_RELINK_PLAN_MAX_BYTES = 8 * 1024 * 1024;
const PRIVATE_TEMP_PARENT = "/tmp";
const PRIVATE_DIRECTORY_PREFIX = "/tmp/ipe-legacy-relink-";

export type RelinkOutputErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "UNSAFE_TEMP_DIRECTORY"
  | "DIRECTORY_CREATE_FAILED"
  | "UNSAFE_OUTPUT_DIRECTORY"
  | "INVALID_PLAN"
  | "PLAN_TOO_LARGE"
  | "OUTPUT_ALREADY_USED"
  | "OUTPUT_WRITE_FAILED"
  | "OUTPUT_PROMOTION_FAILED"
  | "UNSAFE_OUTPUT_FILE";

const OUTPUT_ERROR_CODES = new Set<RelinkOutputErrorCode>([
  "UNSUPPORTED_PLATFORM",
  "UNSAFE_TEMP_DIRECTORY",
  "DIRECTORY_CREATE_FAILED",
  "UNSAFE_OUTPUT_DIRECTORY",
  "INVALID_PLAN",
  "PLAN_TOO_LARGE",
  "OUTPUT_ALREADY_USED",
  "OUTPUT_WRITE_FAILED",
  "OUTPUT_PROMOTION_FAILED",
  "UNSAFE_OUTPUT_FILE",
]);

/** Never attach the underlying filesystem error, private path, or plan to errors. */
export class RelinkOutputError extends Error {
  constructor(readonly code: RelinkOutputErrorCode) {
    super("LEGACY_SLIP_RELINK_OUTPUT_FAILED");
    this.name = "RelinkOutputError";
    this.code = OUTPUT_ERROR_CODES.has(code) ? code : "OUTPUT_WRITE_FAILED";
  }
}

export interface PrivateRelinkOutput {
  directory: string;
  writePlan(plan: unknown): Promise<{ path: string; sha256: string }>;
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireParent(stat: Stats, uid: number): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
  ) {
    throw new RelinkOutputError("UNSAFE_TEMP_DIRECTORY");
  }
}

function requireDirectory(stat: Stats, uid: number): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o700
  ) {
    throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
  }
}

function requireFile(
  stat: Stats,
  uid: number,
  links: number,
  size?: number
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== links ||
    (size !== undefined && stat.size !== size)
  ) {
    throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
  }
}

/** Bounded plain-JSON encoding: no getters, toJSON hooks, ambient env, or clients.
 * The caller must supply an explicitly selected artifact schema, never config.
 * Reject unsupported data rather than silently dropping or coercing fields. */
function encodePlan(plan: unknown): Buffer {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let byteCount = 0;
  let nodeCount = 0;
  const append = (chunk: string) => {
    byteCount += Buffer.byteLength(chunk, "utf8");
    if (byteCount > LEGACY_SLIP_RELINK_PLAN_MAX_BYTES)
      throw new RelinkOutputError("PLAN_TOO_LARGE");
    chunks.push(chunk);
  };
  const encode = (value: unknown, depth: number): void => {
    if (++nodeCount > 100_000 || depth > 64)
      throw new RelinkOutputError("INVALID_PLAN");
    if (value === null) return append("null");
    if (typeof value === "string") return append(JSON.stringify(value));
    if (typeof value === "boolean") return append(value ? "true" : "false");
    if (typeof value === "number" && Number.isFinite(value))
      return append(JSON.stringify(value));
    if (
      typeof value !== "object" ||
      ancestors.has(value) ||
      types.isProxy(value)
    )
      throw new RelinkOutputError("INVALID_PLAN");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new RelinkOutputError("INVALID_PLAN");
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new RelinkOutputError("INVALID_PLAN");
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array) {
      append("[");
      for (let i = 0; i < value.length; i++) {
        const item = descriptors[String(i)];
        if (!item || !("value" in item))
          throw new RelinkOutputError("INVALID_PLAN");
        if (i > 0) append(",");
        encode(item.value, depth + 1);
      }
      append("]");
    } else {
      append("{");
      let count = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor))
          throw new RelinkOutputError("INVALID_PLAN");
        if (count++ > 0) append(",");
        append(JSON.stringify(key));
        append(":");
        encode(descriptor.value, depth + 1);
      }
      append("}");
    }
    ancestors.delete(value);
  };
  try {
    encode(plan, 0);
    append("\n");
    return Buffer.from(chunks.join(""), "utf8");
  } catch (error) {
    if (error instanceof RelinkOutputError) throw error;
    throw new RelinkOutputError("INVALID_PLAN");
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle) await handle.close().catch(() => undefined);
}

/** Linux Preview only. Pinned /tmp ignores TMPDIR/TMP/TEMP and caller paths.
 * One fresh 0700 directory, one single-use 0600 artifact, no replacement mode.
 * A failed run may leave an owned private directory/temp artifact for inspection.
 * Same-UID/root hostile processes are outside POSIX permission isolation. */
export async function createPrivateRelinkOutput(): Promise<PrivateRelinkOutput> {
  if (platform() !== "linux" || typeof process.geteuid !== "function")
    throw new RelinkOutputError("UNSUPPORTED_PLATFORM");
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0)
    throw new RelinkOutputError("UNSUPPORTED_PLATFORM");

  let directory: string;
  let parentSnapshot: Stats;
  let directorySnapshot: Stats;
  let handle: FileHandle | undefined;
  let stage: RelinkOutputErrorCode = "UNSAFE_TEMP_DIRECTORY";
  try {
    parentSnapshot = await fs.lstat(PRIVATE_TEMP_PARENT);
    requireParent(parentSnapshot, uid);
    stage = "DIRECTORY_CREATE_FAILED";
    directory = await fs.mkdtemp(PRIVATE_DIRECTORY_PREFIX);
    // Defend the returned path contract as well as the filesystem object.
    if (!/^\/tmp\/ipe-legacy-relink-[A-Za-z0-9]+$/.test(directory))
      throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
    stage = "UNSAFE_OUTPUT_DIRECTORY";
    handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const initial = await handle.stat();
    if (!initial.isDirectory() || initial.uid !== uid)
      throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
    await handle.chmod(0o700);
    directorySnapshot = await handle.stat();
    requireDirectory(directorySnapshot, uid);
    const pathStat = await fs.lstat(directory);
    requireDirectory(pathStat, uid);
    if (!sameInode(pathStat, directorySnapshot))
      throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
    const parentAfter = await fs.lstat(PRIVATE_TEMP_PARENT);
    requireParent(parentAfter, uid);
    if (!sameInode(parentSnapshot, parentAfter))
      throw new RelinkOutputError("UNSAFE_TEMP_DIRECTORY");
  } catch (error) {
    if (error instanceof RelinkOutputError) throw error;
    throw new RelinkOutputError(stage);
  } finally {
    await closeQuietly(handle);
  }

  let used = false;
  const verifyDirectory = async (): Promise<void> => {
    const parentNow = await fs.lstat(PRIVATE_TEMP_PARENT);
    requireParent(parentNow, uid);
    if (!sameInode(parentNow, parentSnapshot))
      throw new RelinkOutputError("UNSAFE_TEMP_DIRECTORY");
    const directoryNow = await fs.lstat(directory);
    requireDirectory(directoryNow, uid);
    if (!sameInode(directoryNow, directorySnapshot))
      throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
  };
  return {
    directory,
    async writePlan(plan) {
      if (used) throw new RelinkOutputError("OUTPUT_ALREADY_USED");
      used = true;
      const payload = encodePlan(plan);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const temporaryPath = `${directory}/.plan-${randomUUID()}.tmp`;
      const finalPath = `${directory}/plan.json`;
      let file: FileHandle | undefined;
      let directoryHandle: FileHandle | undefined;
      let createdFile: Stats | undefined;
      let stage: RelinkOutputErrorCode = "OUTPUT_WRITE_FAILED";
      try {
        await verifyDirectory();
        directoryHandle = await fs.open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        const openedDirectory = await directoryHandle.stat();
        requireDirectory(openedDirectory, uid);
        if (!sameInode(openedDirectory, directorySnapshot))
          throw new RelinkOutputError("UNSAFE_OUTPUT_DIRECTORY");
        file = await fs.open(
          temporaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600
        );
        const initial = await file.stat();
        if (!initial.isFile() || initial.uid !== uid || initial.nlink !== 1)
          throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
        await file.chmod(0o600);
        createdFile = await file.stat();
        requireFile(createdFile, uid, 1, 0);
        await file.writeFile(payload);
        await file.sync();
        const complete = await file.stat();
        requireFile(complete, uid, 1, payload.length);
        if (!sameInode(createdFile, complete))
          throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
        await file.close();
        file = undefined;
        await verifyDirectory();
        const temporaryStat = await fs.lstat(temporaryPath);
        requireFile(temporaryStat, uid, 1, payload.length);
        if (!sameInode(temporaryStat, createdFile))
          throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
        stage = "OUTPUT_PROMOTION_FAILED";
        // link() fails if plan.json already exists, unlike rename() on POSIX.
        await fs.link(temporaryPath, finalPath);
        const linkedStat = await fs.lstat(finalPath);
        requireFile(linkedStat, uid, 2, payload.length);
        if (!sameInode(linkedStat, createdFile))
          throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
        await fs.unlink(temporaryPath);
        const finalStat = await fs.lstat(finalPath);
        requireFile(finalStat, uid, 1, payload.length);
        if (!sameInode(finalStat, createdFile))
          throw new RelinkOutputError("UNSAFE_OUTPUT_FILE");
        await directoryHandle.sync();
        await verifyDirectory();
        return { path: finalPath, sha256 };
      } catch (error) {
        if (error instanceof RelinkOutputError) throw error;
        throw new RelinkOutputError(stage);
      } finally {
        await closeQuietly(file);
        await closeQuietly(directoryHandle);
        // Never delete a final artifact or an object whose identity changed.
        if (createdFile) {
          try {
            const leftover = await fs.lstat(temporaryPath);
            if (leftover.isFile() && sameInode(leftover, createdFile))
              await fs.unlink(temporaryPath);
          } catch {
            // Private leftovers are preferable to following an unsafe path.
          }
        }
      }
    },
  };
}
