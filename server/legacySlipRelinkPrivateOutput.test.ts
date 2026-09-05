import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type * as RealFs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  platform: vi.fn(),
  fs: {
    lstat: vi.fn(),
    mkdtemp: vi.fn(),
    open: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
  },
}));
vi.mock("node:os", () => ({ platform: mocked.platform }));
vi.mock("node:fs/promises", () => mocked.fs);
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    constants: {
      ...original.constants,
      // Node omits these POSIX constants on the Windows test host.
      O_DIRECTORY: original.constants.O_DIRECTORY ?? 0x10000,
      O_NOFOLLOW: original.constants.O_NOFOLLOW ?? 0x20000,
    },
  };
});

import {
  createPrivateRelinkOutput,
  LEGACY_SLIP_RELINK_PLAN_MAX_BYTES,
  RelinkOutputError,
} from "../scripts/lib/legacySlipRelinkPrivateOutput";
import {
  prepareLegacySlipRelinkPlan,
  type RelinkReaders,
} from "../scripts/lib/legacySlipRelinkPlan";

const DIRECTORY = "/tmp/ipe-legacy-relink-aB1xY2";
const FINAL_PATH = `${DIRECTORY}/plan.json`;
const UID = 1000;
const actualPlatform = process.platform;
const originalGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");

interface Entry {
  type: "directory" | "file" | "symlink";
  uid: number;
  mode: number;
  ino: number;
  dev: number;
  nlink: number;
  bytes: Buffer;
}

function fixture() {
  const entries = new Map<string, Entry>();
  const trace: string[] = [];
  let nextInode = 10;
  const add = (path: string, overrides: Partial<Entry> = {}) => {
    const entry: Entry = {
      type: "directory",
      uid: UID,
      mode: 0o700,
      ino: nextInode++,
      dev: 1,
      nlink: 1,
      bytes: Buffer.alloc(0),
      ...overrides,
    };
    entries.set(path, entry);
    return entry;
  };
  add("/tmp", { uid: 0, mode: 0o1777 });
  const stat = (entry: Entry) => ({
    ...entry,
    size: entry.bytes.length,
    isDirectory: () => entry.type === "directory",
    isFile: () => entry.type === "file",
    isSymbolicLink: () => entry.type === "symlink",
  });
  const lookup = (path: string) => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`ENOENT SECRET_PATH ${path}`);
    return entry;
  };
  mocked.fs.lstat.mockImplementation(async (path: string) =>
    stat(lookup(path))
  );
  mocked.fs.mkdtemp.mockImplementation(async (prefix: string) => {
    trace.push("mkdtemp");
    expect(prefix).toBe("/tmp/ipe-legacy-relink-");
    add(DIRECTORY);
    return DIRECTORY;
  });
  mocked.fs.open.mockImplementation(
    async (path: string, flags: number, mode?: number) => {
      trace.push(path === DIRECTORY ? "open-directory" : "open-file");
      expect(flags & constants.O_NOFOLLOW).not.toBe(0);
      if (flags & constants.O_CREAT) {
        expect(flags & constants.O_EXCL).not.toBe(0);
        if (entries.has(path)) throw new Error("EEXIST SECRET_PATH");
        add(path, { type: "file", mode: mode ?? 0o600 });
      }
      const entry = lookup(path);
      if (entry.type === "symlink") throw new Error("ELOOP SECRET_PATH");
      return {
        stat: vi.fn(async () => stat(entry)),
        chmod: vi.fn(async (newMode: number) => {
          entry.mode = newMode;
        }),
        writeFile: vi.fn(async (bytes: Buffer) => {
          trace.push("write");
          entry.bytes = Buffer.from(bytes);
        }),
        sync: vi.fn(async () => {
          trace.push(entry.type === "file" ? "file-sync" : "directory-sync");
        }),
        close: vi.fn(async () => {
          trace.push(entry.type === "file" ? "file-close" : "directory-close");
        }),
      };
    }
  );
  mocked.fs.link.mockImplementation(async (from: string, to: string) => {
    trace.push("link");
    if (entries.has(to)) throw new Error(`EEXIST SECRET_PATH ${to}`);
    const source = lookup(from);
    source.nlink++;
    entries.set(to, source);
  });
  mocked.fs.unlink.mockImplementation(async (path: string) => {
    trace.push("unlink");
    const source = lookup(path);
    source.nlink--;
    entries.delete(path);
  });
  return { entries, trace, add, stat };
}

let state: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.clearAllMocks();
  mocked.platform.mockReturnValue("linux");
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    value: () => UID,
  });
  state = fixture();
});
afterEach(() => {
  if (originalGeteuid)
    Object.defineProperty(process, "geteuid", originalGeteuid);
  else Reflect.deleteProperty(process, "geteuid");
  vi.unstubAllEnvs();
});

async function expectFixedError(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelinkOutputError);
  expect(caught).toMatchObject({
    code,
    message: "LEGACY_SLIP_RELINK_OUTPUT_FAILED",
  });
  expect(JSON.stringify(caught)).not.toMatch(/SECRET_PATH|\/tmp\//);
  expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
}

describe("private legacy slip relink artifact", () => {
  it.each(["win32", "darwin", "freebsd"])(
    "fails before filesystem I/O on %s",
    async targetPlatform => {
      mocked.platform.mockReturnValue(targetPlatform);
      await expectFixedError(
        createPrivateRelinkOutput(),
        "UNSUPPORTED_PLATFORM"
      );
      for (const operation of Object.values(mocked.fs))
        expect(operation).not.toHaveBeenCalled();
    }
  );

  it("fails before I/O when the effective uid is unavailable", async () => {
    Object.defineProperty(process, "geteuid", { value: undefined });
    await expectFixedError(createPrivateRelinkOutput(), "UNSUPPORTED_PLATFORM");
    expect(mocked.fs.lstat).not.toHaveBeenCalled();
  });

  it("pins /tmp, ignoring user supplied temporary directories", async () => {
    vi.stubEnv("TMPDIR", "/workspace/SECRET_PATH");
    vi.stubEnv("TEMP", "/workspace/SECRET_PATH");
    vi.stubEnv("TMP", "/workspace/SECRET_PATH");
    const output = await createPrivateRelinkOutput();
    expect(output.directory).toBe(DIRECTORY);
    expect(state.entries.get(DIRECTORY)).toMatchObject({
      uid: UID,
      mode: 0o700,
    });
  });

  it.each([
    { type: "symlink" as const },
    { type: "file" as const },
    { uid: 2000 },
    { mode: 0o777 },
    { mode: 0o775 },
  ])("rejects an unsafe /tmp parent: %j", async override => {
    Object.assign(state.entries.get("/tmp")!, override);
    await expectFixedError(
      createPrivateRelinkOutput(),
      "UNSAFE_TEMP_DIRECTORY"
    );
    expect(mocked.fs.mkdtemp).not.toHaveBeenCalled();
  });

  it("does not leak a raw directory creation failure", async () => {
    mocked.fs.mkdtemp.mockRejectedValue(new Error("SECRET_PATH /tmp/private"));
    await expectFixedError(
      createPrivateRelinkOutput(),
      "DIRECTORY_CREATE_FAILED"
    );
  });

  it("rejects a mkdtemp path outside the fixed private prefix", async () => {
    mocked.fs.mkdtemp.mockResolvedValue("/tmp/ipe-legacy-relink-a/b");
    await expectFixedError(
      createPrivateRelinkOutput(),
      "UNSAFE_OUTPUT_DIRECTORY"
    );
    expect(mocked.fs.open).not.toHaveBeenCalled();
  });

  it("rejects a newly created directory owned by another uid", async () => {
    mocked.fs.mkdtemp.mockImplementation(async () => {
      state.add(DIRECTORY, { uid: 2000 });
      return DIRECTORY;
    });
    await expectFixedError(
      createPrivateRelinkOutput(),
      "UNSAFE_OUTPUT_DIRECTORY"
    );
  });

  it("rejects an ancestor changed during directory creation", async () => {
    mocked.fs.mkdtemp.mockImplementation(async () => {
      state.add(DIRECTORY);
      state.entries.get("/tmp")!.ino++;
      return DIRECTORY;
    });
    await expectFixedError(
      createPrivateRelinkOutput(),
      "UNSAFE_TEMP_DIRECTORY"
    );
  });

  it("publishes complete UTF-8 JSON only after file fsync; final mode is 0600", async () => {
    const output = await createPrivateRelinkOutput();
    expect(state.entries.has(FINAL_PATH)).toBe(false);
    const plan = {
      version: 1,
      note: "ทดสอบ",
      sources: [{ id: 1 }],
      safe: true,
    };
    const result = await output.writePlan(plan);
    const expected = Buffer.from(JSON.stringify(plan) + "\n", "utf8");
    const entry = state.entries.get(FINAL_PATH)!;
    expect(result).toEqual({
      path: FINAL_PATH,
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
    expect(entry.bytes).toEqual(expected);
    expect(entry).toMatchObject({ uid: UID, mode: 0o600, nlink: 1 });
    expect(state.trace.indexOf("file-sync")).toBeLessThan(
      state.trace.indexOf("link")
    );
    expect(state.trace.indexOf("file-close")).toBeLessThan(
      state.trace.indexOf("link")
    );
    expect(state.trace.indexOf("link")).toBeLessThan(
      state.trace.indexOf("directory-sync")
    );
    expect(
      [...state.entries.keys()].filter(path => path.endsWith(".tmp"))
    ).toEqual([]);
    await expectFixedError(output.writePlan(plan), "OUTPUT_ALREADY_USED");
  });

  it("prevents concurrent writes from sharing an output directory", async () => {
    const output = await createPrivateRelinkOutput();
    const first = output.writePlan({ first: true });
    await expectFixedError(
      output.writePlan({ second: true }),
      "OUTPUT_ALREADY_USED"
    );
    await first;
  });

  it("never replaces an existing final file", async () => {
    const output = await createPrivateRelinkOutput();
    const existing = state.add(FINAL_PATH, {
      type: "file",
      mode: 0o600,
      bytes: Buffer.from("existing private artifact"),
    });
    await expectFixedError(
      output.writePlan({ new: true }),
      "OUTPUT_PROMOTION_FAILED"
    );
    expect(state.entries.get(FINAL_PATH)).toBe(existing);
    expect(existing.bytes.toString()).toBe("existing private artifact");
    expect(
      mocked.fs.unlink.mock.calls.every(([path]) => path !== FINAL_PATH)
    ).toBe(true);
  });

  it("never replaces a final symlink", async () => {
    const output = await createPrivateRelinkOutput();
    const existing = state.add(FINAL_PATH, { type: "symlink" });
    await expectFixedError(
      output.writePlan({ test: true }),
      "OUTPUT_PROMOTION_FAILED"
    );
    expect(state.entries.get(FINAL_PATH)).toBe(existing);
  });

  it("blocks a replaced output directory before creating a file", async () => {
    const output = await createPrivateRelinkOutput();
    state.entries.get(DIRECTORY)!.ino++;
    await expectFixedError(
      output.writePlan({ test: true }),
      "UNSAFE_OUTPUT_DIRECTORY"
    );
    expect(
      mocked.fs.open.mock.calls.some(([, flags]) => flags & constants.O_CREAT)
    ).toBe(false);
  });

  it("blocks changed directory permissions", async () => {
    const output = await createPrivateRelinkOutput();
    state.entries.get(DIRECTORY)!.mode = 0o755;
    await expectFixedError(
      output.writePlan({ test: true }),
      "UNSAFE_OUTPUT_DIRECTORY"
    );
  });

  it("does not publish a file after write failure", async () => {
    const output = await createPrivateRelinkOutput();
    const normalOpen = mocked.fs.open.getMockImplementation()!;
    mocked.fs.open.mockImplementation(async (...args) => {
      const handle = await normalOpen(...args);
      if (args[1] & constants.O_CREAT)
        handle.writeFile.mockRejectedValue(
          new Error("SECRET_PATH private-url")
        );
      return handle;
    });
    await expectFixedError(
      output.writePlan({ test: true }),
      "OUTPUT_WRITE_FAILED"
    );
    expect(mocked.fs.link).not.toHaveBeenCalled();
    expect(state.entries.has(FINAL_PATH)).toBe(false);
  });

  it("does not publish a file after fsync failure", async () => {
    const output = await createPrivateRelinkOutput();
    const normalOpen = mocked.fs.open.getMockImplementation()!;
    mocked.fs.open.mockImplementation(async (...args) => {
      const handle = await normalOpen(...args);
      if (args[1] & constants.O_CREAT)
        handle.sync.mockRejectedValue(new Error("SECRET_PATH private-url"));
      return handle;
    });
    await expectFixedError(
      output.writePlan({ test: true }),
      "OUTPUT_WRITE_FAILED"
    );
    expect(mocked.fs.link).not.toHaveBeenCalled();
    expect(state.entries.has(FINAL_PATH)).toBe(false);
  });

  it("rejects changed temporary-file ownership before promotion", async () => {
    const output = await createPrivateRelinkOutput();
    const normalOpen = mocked.fs.open.getMockImplementation()!;
    mocked.fs.open.mockImplementation(async (...args) => {
      const handle = await normalOpen(...args);
      if (args[1] & constants.O_CREAT) {
        const normalSync = handle.sync.getMockImplementation()!;
        handle.sync.mockImplementation(async () => {
          await normalSync();
          state.entries.get(args[0])!.uid = 2000;
        });
      }
      return handle;
    });
    await expectFixedError(
      output.writePlan({ test: true }),
      "UNSAFE_OUTPUT_FILE"
    );
    expect(mocked.fs.link).not.toHaveBeenCalled();
  });

  it("rejects extra hard links before promotion", async () => {
    const output = await createPrivateRelinkOutput();
    const normalOpen = mocked.fs.open.getMockImplementation()!;
    mocked.fs.open.mockImplementation(async (...args) => {
      const handle = await normalOpen(...args);
      if (args[1] & constants.O_CREAT) {
        handle.sync.mockImplementation(async () => {
          state.entries.get(args[0])!.nlink = 2;
        });
      }
      return handle;
    });
    await expectFixedError(
      output.writePlan({ test: true }),
      "UNSAFE_OUTPUT_FILE"
    );
    expect(mocked.fs.link).not.toHaveBeenCalled();
  });

  it("bounds encoded bytes, not JavaScript string length", async () => {
    const output = await createPrivateRelinkOutput();
    const plan = {
      text: "ท".repeat(Math.ceil(LEGACY_SLIP_RELINK_PLAN_MAX_BYTES / 3)),
    };
    await expectFixedError(output.writePlan(plan), "PLAN_TOO_LARGE");
    expect(
      mocked.fs.open.mock.calls.some(([, flags]) => flags & constants.O_CREAT)
    ).toBe(false);
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    () => "secret",
    new Date(),
    [undefined],
  ])("rejects non-JSON values without creating output: %s", async value => {
    const output = await createPrivateRelinkOutput();
    await expectFixedError(output.writePlan({ value }), "INVALID_PLAN");
    expect(mocked.fs.link).not.toHaveBeenCalled();
  });

  it("does not call getters or toJSON while encoding the selected schema", async () => {
    const getter = vi.fn(() => "SECRET_PATH");
    const toJSON = vi.fn(() => ({ secret: "SECRET_PATH" }));
    const first = await createPrivateRelinkOutput();
    await expectFixedError(
      first.writePlan(
        Object.defineProperty({}, "private", { get: getter, enumerable: true })
      ),
      "INVALID_PLAN"
    );
    // A fresh fixture models a second unpredictable mkdtemp directory.
    state = fixture();
    const second = await createPrivateRelinkOutput();
    await expectFixedError(second.writePlan({ toJSON }), "INVALID_PLAN");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects cycles before creating a file", async () => {
    const output = await createPrivateRelinkOutput();
    const cycle: any = {};
    cycle.self = cycle;
    await expectFixedError(output.writePlan(cycle), "INVALID_PLAN");
    expect(mocked.fs.link).not.toHaveBeenCalled();
  });

  it("rejects proxies without invoking their serialization traps", async () => {
    const trap = vi.fn(() => {
      throw new Error("SECRET_PATH");
    });
    const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap });
    const output = await createPrivateRelinkOutput();
    await expectFixedError(output.writePlan(proxy), "INVALID_PLAN");
    expect(trap).not.toHaveBeenCalled();
  });

  it("normalizes unknown error codes without retaining their content", () => {
    const error = new RelinkOutputError("SECRET_PATH" as any);
    expect(error.code).toBe("OUTPUT_WRITE_FAILED");
    expect(JSON.stringify(error)).not.toContain("SECRET_PATH");
  });

  it.each([false, true])(
    "serializes the actual full ten-row plan with missing ETag=%s, preserving its digest",
    async missingEtag => {
      const readers: RelinkReaders = {
        readSource: vi.fn(async target => ({
          source: {
            ...target,
            ownerUserId: 55,
            status: "approved",
            slipImageUrl: `https://d2xsxph8kpxj0f.cloudfront.net/synthetic-private/${target.sourceId}`,
            slipEvidenceClass: "legacy_compatibility_required",
            evidenceVersion: 0,
            slipEvidenceId: null,
            extractedEvidenceVersion: null,
            extractedData: null,
            bindings: [],
            claims: [],
            relatedReadTruncated: false,
          },
          record: {
            id: target.sourceId,
            amount: "1.00",
            updatedAt: "2026-09-01 00:00:00",
          },
          order:
            target.sourceType === "order_payment"
              ? { id: 1, userId: 55 }
              : null,
          related: { claims: [], bindings: [], unknowns: [], collisions: [] },
          truncated: false,
        })),
        listCandidate: vi.fn(async target => ({
          listing: {
            candidateCount: 1,
            unexpectedObjectCount: 0,
            truncated: false,
          },
          candidate: {
            key: `payment-slips/legacy/${target.sourceType === "order_payment" ? "payments" : "wallet-topups"}/${target.sourceId}/123-synthetic.jpg`,
            etag: missingEtag ? undefined : '"synthetic-etag"',
            size: 32,
          },
        })),
        readCandidate: vi.fn(async candidate => ({
          rawHash: createHash("sha256")
            .update(`raw:${candidate.key}`)
            .digest("hex"),
          canonicalHash: createHash("sha256")
            .update(`canonical:${candidate.key}`)
            .digest("hex"),
          byteLength: 32,
          mimeType: "image/jpeg" as const,
        })),
        readCrossReferences: vi.fn(async () => ({
          claims: [],
          collisions: [],
          bindings: [],
          uploads: [],
          references: [],
          truncated: false,
        })),
      };
      const plan = await prepareLegacySlipRelinkPlan(readers, {
        runId: "12345678-1234-4234-a234-123456789012",
        preparedAt: "2026-09-05T12:00:00.000Z",
        declaredCodeSha: "a".repeat(40),
        toolSourceDigest: "b".repeat(64),
        targetFingerprint: "c".repeat(64),
      });
      expect(plan.rows).toHaveLength(10);
      expect(
        plan.rows.every(
          row => row.status === (missingEtag ? "BLOCKED" : "NEEDS_ATTESTATION")
        )
      ).toBe(true);
      if (missingEtag) {
        expect(readers.readCandidate).not.toHaveBeenCalled();
        expect(
          plan.rows.every(row => row.candidate?.candidate?.etag === null)
        ).toBe(true);
      } else {
        expect(readers.readCandidate).toHaveBeenCalledTimes(10);
      }
      const output = await createPrivateRelinkOutput();
      const result = await output.writePlan(plan);
      const saved = state.entries.get(result.path)!;
      expect(JSON.parse(saved.bytes.toString("utf8"))).toEqual(plan);
      expect(result.sha256).toBe(
        createHash("sha256").update(saved.bytes).digest("hex")
      );
      expect(saved).toMatchObject({ mode: 0o600, uid: UID, nlink: 1 });
      expect(plan.writeAuthorized).toBe(false);
      expect(plan.isApplyManifest).toBe(false);
    }
  );

  it("publishes a real operator-attestation shape without granting write authority", async () => {
    const { createRepairFixture } =
      await import("./fixtures/legacySlipRepairFixtures");
    const { attestation } = createRepairFixture();
    const output = await createPrivateRelinkOutput();
    const result = await output.writePlan(attestation);
    const saved = state.entries.get(result.path)!;
    expect(JSON.parse(saved.bytes.toString("utf8"))).toEqual(attestation);
    expect(result.sha256).toBe(
      createHash("sha256").update(saved.bytes).digest("hex")
    );
    expect(saved).toMatchObject({ mode: 0o600, uid: UID, nlink: 1 });
    expect(attestation.independentReview).toBeNull();
    expect(attestation.writeAuthorized).toBe(false);
  });

  it.skipIf(actualPlatform !== "linux")(
    "writes a real POSIX private fixture with exact final hash and permissions",
    async () => {
      const real = await vi.importActual<typeof RealFs>("node:fs/promises");
      for (const key of Object.keys(mocked.fs) as Array<keyof typeof mocked.fs>)
        mocked.fs[key].mockImplementation(real[key] as any);
      if (originalGeteuid)
        Object.defineProperty(process, "geteuid", originalGeteuid);
      const output = await createPrivateRelinkOutput();
      expect(output.directory).toMatch(
        /^\/tmp\/ipe-legacy-relink-[A-Za-z0-9]+$/
      );
      let artifactPath: string | undefined;
      try {
        const result = await output.writePlan({
          fixture: "no production data",
        });
        artifactPath = result.path;
        const content = await real.readFile(result.path);
        expect(result.sha256).toBe(
          createHash("sha256").update(content).digest("hex")
        );
        expect((await real.lstat(output.directory)).mode & 0o7777).toBe(0o700);
        expect((await real.lstat(result.path)).mode & 0o7777).toBe(0o600);
        expect((await real.lstat(result.path)).nlink).toBe(1);
      } finally {
        if (artifactPath) await real.unlink(artifactPath);
        await real.rmdir(output.directory);
      }
    }
  );
});
