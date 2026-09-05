import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { posix } from "node:path";
import { platform } from "node:os";

export class RepairInputError extends Error {
  constructor(
    readonly code:
      | "INVALID_REPAIR_ARGUMENTS"
      | "PRIVATE_INPUT_UNSAFE"
      | "PRIVATE_INPUT_FAILED"
      | "PRIVATE_INPUT_TOO_LARGE"
      | "UNSUPPORTED_PLATFORM"
  ) {
    super(code);
  }
}

export function requirePrivateLinux(): number {
  if (platform() !== "linux" || typeof process.geteuid !== "function")
    throw new RepairInputError("UNSUPPORTED_PLATFORM");
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0)
    throw new RepairInputError("UNSUPPORTED_PLATFORM");
  return uid;
}

export function isPrivateInputPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length <= 1024 &&
    path.startsWith("/") &&
    path !== "/" &&
    !/[\x00-\x1f\x7f\\]/.test(path) &&
    posix.normalize(path) === path &&
    !path.endsWith("/")
  );
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  );
}

/** Private regular files only. No symlink ancestors, public directories, hooks,
 * unbounded readFile, or raw filesystem errors. Same-UID/root attackers remain
 * outside POSIX permission isolation; expected artifact digests provide binding. */
export async function readPrivateRepairInput(
  path: string,
  maxBytes: number
): Promise<Buffer> {
  const uid = requirePrivateLinux();
  if (
    !isPrivateInputPath(path) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8 * 1024 * 1024
  )
    throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
  let handle: fs.FileHandle | undefined;
  try {
    const parent = posix.dirname(path);
    if (parent === "/") throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
    const ancestors: Array<{ path: string; stat: Stats }> = [];
    let cursor = parent;
    while (true) {
      const stat = await fs.lstat(cursor);
      const immediate = cursor === parent;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== uid) ||
        (immediate
          ? (stat.mode & 0o7777) !== 0o700
          : (stat.mode & 0o022) !== 0 &&
            !(
              cursor === "/tmp" &&
              stat.uid === 0 &&
              (stat.mode & 0o1000) !== 0
            ))
      )
        throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
      ancestors.push({ path: cursor, stat });
      if (cursor === "/") break;
      cursor = posix.dirname(cursor);
    }
    const before = await fs.lstat(path);
    const requireFile = (s: Stats) => {
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        (s.uid !== 0 && s.uid !== uid) ||
        (s.mode & 0o7777) !== 0o600 ||
        s.nlink !== 1 ||
        !Number.isSafeInteger(s.size) ||
        s.size <= 0
      )
        throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
      if (s.size > maxBytes)
        throw new RepairInputError("PRIVATE_INPUT_TOO_LARGE");
    };
    requireFile(before);
    handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const opened = await handle.stat();
    requireFile(opened);
    if (!sameFile(before, opened))
      throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size)
      throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
    const after = await handle.stat();
    const pathAfter = await fs.lstat(path);
    requireFile(after);
    requireFile(pathAfter);
    if (!sameFile(opened, after) || !sameFile(opened, pathAfter))
      throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
    for (const a of ancestors) {
      const fresh = await fs.lstat(a.path);
      // Parent timestamps may legitimately change; identity and permissions may not.
      if (
        !fresh.isDirectory() ||
        fresh.isSymbolicLink() ||
        fresh.dev !== a.stat.dev ||
        fresh.ino !== a.stat.ino ||
        fresh.uid !== a.stat.uid ||
        fresh.mode !== a.stat.mode
      )
        throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof RepairInputError) throw error;
    throw new RepairInputError("PRIVATE_INPUT_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type RepairCliArgs =
  | { mode: "help" }
  | {
      mode: "record-attestation" | "dry-run";
      plan: string;
      input: string;
      codeSha: string;
    };

/** Parse before touching config, files or clients. There is deliberately no apply. */
export function parseLegacySlipRepairArgs(
  args: readonly string[]
): RepairCliArgs {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  const mode = args.includes("--record-attestation")
    ? "record-attestation"
    : "dry-run";
  const inputName = mode === "record-attestation" ? "statement" : "attestation";
  const expected = mode === "record-attestation" ? 4 : 5;
  const values = new Map<string, string>();
  for (const arg of args) {
    const split = arg.indexOf("=");
    const key = split < 0 ? arg : arg.slice(0, split);
    if (values.has(key)) throw new RepairInputError("INVALID_REPAIR_ARGUMENTS");
    values.set(key, split < 0 ? "" : arg.slice(split + 1));
  }
  const allowed = [
    `--${mode}`,
    "--plan",
    `--${inputName}`,
    "--code-sha",
    ...(mode === "dry-run" ? ["--confirm-preview"] : []),
  ];
  if (
    !args.includes(`--${mode}`) ||
    (mode === "dry-run" && !args.includes("--confirm-preview")) ||
    args.length !== expected ||
    values.size !== expected ||
    [...values.keys()].some(k => !allowed.includes(k)) ||
    values.get(`--${mode}`) !== "" ||
    (mode === "dry-run" && values.get("--confirm-preview") !== "") ||
    !isPrivateInputPath(values.get("--plan") ?? "") ||
    !isPrivateInputPath(values.get(`--${inputName}`) ?? "") ||
    !/^[a-f0-9]{40}$/.test(values.get("--code-sha") ?? "")
  )
    throw new RepairInputError("INVALID_REPAIR_ARGUMENTS");
  return {
    mode,
    plan: values.get("--plan")!,
    input: values.get(`--${inputName}`)!,
    codeSha: values.get("--code-sha")!,
  };
}
