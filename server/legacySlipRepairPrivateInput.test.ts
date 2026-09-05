import { describe, it, expect, vi, beforeEach } from "vitest";

const fixture = vi.hoisted(() => ({
  platform: "linux",
  uid: 0,
  body: Buffer.from('{"private":"NEVER_LOG_THIS"}'),
  stats: new Map<string, any>(),
  handle: undefined as any,
}));
vi.mock("node:os", () => ({ platform: () => fixture.platform }));
vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async (path: string) => {
    if (!fixture.stats.has(path)) throw new Error("NEVER_LOG_THIS");
    return fixture.stats.get(path);
  }),
  open: vi.fn(async () => fixture.handle),
}));
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  readPrivateRepairInput,
  isPrivateInputPath,
  parseLegacySlipRepairArgs,
} from "../scripts/lib/legacySlipRepairPrivateInput";

function stat(file: boolean, mode: number, ino: number) {
  return {
    uid: 0,
    mode,
    ino,
    dev: 1,
    nlink: 1,
    size: file ? fixture.body.length : 0,
    mtimeMs: 100,
    ctimeMs: 100,
    isDirectory: () => !file,
    isFile: () => file,
    isSymbolicLink: () => false,
  };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fixture.platform = "linux";
  vi.stubGlobal("process", { ...process, geteuid: () => fixture.uid });
  fixture.uid = 0;
  fixture.stats = new Map([
    ["/", stat(false, 0o755, 1)],
    ["/root", stat(false, 0o700, 2)],
    ["/root/private", stat(false, 0o700, 3)],
    ["/root/private/plan.json", stat(true, 0o600, 4)],
  ]);
  fixture.handle = {
    stat: vi.fn(async () => fixture.stats.get("/root/private/plan.json")),
    close: vi.fn(async () => {}),
    read: vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        const count = Math.max(
          0,
          Math.min(length, fixture.body.length - position)
        );
        fixture.body.copy(buffer, offset, position, position + count);
        return { bytesRead: count, buffer };
      }
    ),
  };
});

describe("private repair input", () => {
  it("reads a private regular file by bounded fd and closes it", async () => {
    expect(
      await readPrivateRepairInput("/root/private/plan.json", 4096)
    ).toEqual(fixture.body);
    expect(fs.open).toHaveBeenCalledWith(
      "/root/private/plan.json",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    expect(fixture.handle.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    "/root/private/../plan.json",
    "/root//plan.json",
    "/root/private/plan.json/",
    "C:\\secret",
    "relative",
    "/root/\nfile",
    "/",
  ])("rejects noncanonical paths %s", async path => {
    expect(isPrivateInputPath(path)).toBe(false);
    await expect(readPrivateRepairInput(path, 4096)).rejects.toMatchObject({
      code: "PRIVATE_INPUT_UNSAFE",
    });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("rejects non-Linux before filesystem", async () => {
    fixture.platform = "win32";
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 4096)
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    expect(fs.lstat).not.toHaveBeenCalled();
  });
  it.each([
    ["/root/private", { mode: 0o755 }],
    ["/root/private", { uid: 123 }],
    ["/root/private", { isSymbolicLink: () => true }],
    ["/root", { mode: 0o777 }],
    ["/root/private/plan.json", { mode: 0o644 }],
    ["/root/private/plan.json", { mode: 0o4600 }],
    ["/root/private/plan.json", { nlink: 2 }],
    ["/root/private/plan.json", { isSymbolicLink: () => true }],
    ["/root/private/plan.json", { isFile: () => false }],
    ["/root/private/plan.json", { uid: 100 }],
  ])("rejects unsafe ownership/type/mode %s %o", async (path, change) => {
    Object.assign(fixture.stats.get(path), change);
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 4096)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_UNSAFE" });
  });
  it("allows root sticky /tmp above a private directory", async () => {
    fixture.stats.set("/tmp", stat(false, 0o1777, 5));
    fixture.stats.set("/tmp/private", stat(false, 0o700, 6));
    fixture.stats.set(
      "/tmp/private/plan.json",
      fixture.stats.get("/root/private/plan.json")
    );
    expect(
      await readPrivateRepairInput("/tmp/private/plan.json", 4096)
    ).toEqual(fixture.body);
  });
  it("rejects oversize before opening", async () => {
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 1)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_TOO_LARGE" });
    expect(fs.open).not.toHaveBeenCalled();
  });
  it("detects replacement between lstat and open", async () => {
    fixture.handle.stat.mockResolvedValue({
      ...fixture.stats.get("/root/private/plan.json"),
      ino: 99,
    });
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 4096)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_UNSAFE" });
    expect(fixture.handle.close).toHaveBeenCalledTimes(1);
  });
  it("detects content metadata changes after reading", async () => {
    fixture.handle.stat
      .mockResolvedValueOnce({
        ...fixture.stats.get("/root/private/plan.json"),
      })
      .mockResolvedValueOnce({
        ...fixture.stats.get("/root/private/plan.json"),
        ctimeMs: 200,
      });
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 4096)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_UNSAFE" });
  });
  it("handles partial reads until exact EOF", async () => {
    fixture.handle.read.mockImplementation(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        const count = Math.max(
          0,
          Math.min(3, length, fixture.body.length - position)
        );
        fixture.body.copy(buffer, offset, position, position + count);
        return { bytesRead: count, buffer };
      }
    );
    expect(
      await readPrivateRepairInput("/root/private/plan.json", 4096)
    ).toEqual(fixture.body);
  });
  it("detects file growth or truncation", async () => {
    fixture.handle.read.mockResolvedValue({ bytesRead: 0 });
    await expect(
      readPrivateRepairInput("/root/private/plan.json", 4096)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_UNSAFE" });
  });
  it("sanitizes underlying filesystem errors", async () => {
    const error = await readPrivateRepairInput(
      "/root/missing/plan.json",
      4096
    ).catch(e => e);
    expect(error.code).toBe("PRIVATE_INPUT_FAILED");
    expect(String(error)).not.toContain("NEVER_LOG_THIS");
  });
});

describe("strict repair CLI parser", () => {
  const sha = "a".repeat(40);
  it("accepts only the two non-live modes", () => {
    expect(
      parseLegacySlipRepairArgs([
        "--record-attestation",
        "--plan=/root/private/plan.json",
        "--statement=/root/private/statement.json",
        `--code-sha=${sha}`,
      ]).mode
    ).toBe("record-attestation");
    expect(
      parseLegacySlipRepairArgs([
        "--dry-run",
        "--confirm-preview",
        "--plan=/root/private/plan.json",
        "--attestation=/root/private/attestation.json",
        `--code-sha=${sha}`,
      ]).mode
    ).toBe("dry-run");
  });
  it.each([
    [],
    ["--apply"],
    ["--live"],
    ["--help", "--dry-run"],
    ["--dry-run"],
    [
      "--record-attestation",
      "--plan=/root/private/p",
      "--statement=/root/private/s",
      `--code-sha=${sha}`,
      "--target=11280002",
    ],
    [
      "--dry-run",
      "--confirm-preview",
      "--plan=/root/private/p",
      "--attestation=/root/private/a",
      `--code-sha=${sha}`,
      "--live",
    ],
  ])("refuses unsafe or incomplete argument sets %j", (...args: string[]) => {
    expect(() => parseLegacySlipRepairArgs(args)).toThrow(
      "INVALID_REPAIR_ARGUMENTS"
    );
  });
});
