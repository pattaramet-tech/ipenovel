/** REAL Linux filesystem release gate. No mocks, cloud files, network or DB. */
import { createHash } from "node:crypto";
import {
  mkdtemp,
  chmod,
  writeFile,
  lstat,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import { platform } from "node:os";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import { readPrivateRepairInput } from "../scripts/lib/legacySlipRepairPrivateInput";
import { createPrivateRelinkOutput } from "../scripts/lib/legacySlipRelinkPrivateOutput";
import { parseOperatorAttestationBytes } from "../scripts/lib/legacySlipRepairContract";

const owned = new Set<string>();
beforeAll(() => {
  if (platform() !== "linux" || typeof process.geteuid !== "function")
    throw new Error("ISOLATED_REPAIR_REQUIRES_REAL_LINUX_NO_SKIP");
});
afterEach(async () => {
  for (const dir of owned) {
    // Only newly created exact private test directories. No user tmp glob.
    if (
      !/^\/tmp\/ipe-(repair-linux-test|legacy-relink)-[A-Za-z0-9]+$/.test(dir)
    )
      throw new Error("UNSAFE_TEST_CLEANUP_TARGET");
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.geteuid!()
    )
      throw new Error("UNSAFE_TEST_CLEANUP_DIRECTORY");
    await rm(dir, { recursive: true });
    owned.delete(dir);
  }
});
async function privateFile() {
  const dir = await mkdtemp("/tmp/ipe-repair-linux-test-");
  owned.add(dir);
  await chmod(dir, 0o700);
  const file = `${dir}/input.json`;
  const bytes = Buffer.from('{"synthetic":true}\n');
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  return { dir, file, bytes };
}

describe("real Linux private repair inputs and attestation publication", () => {
  it("reads exact 0600 regular file under 0700 private directory with /tmp sticky ancestor", async () => {
    const f = await privateFile();
    expect(await readPrivateRepairInput(f.file, 4096)).toEqual(f.bytes);
  });
  it.each([0o644, 0o640, 0o666, 0o400])("rejects file mode %s", async mode => {
    const f = await privateFile();
    await chmod(f.file, mode);
    await expect(readPrivateRepairInput(f.file, 4096)).rejects.toMatchObject({
      code: "PRIVATE_INPUT_UNSAFE",
    });
  });
  it.each([0o755, 0o750, 0o777])(
    "rejects immediate parent mode %s",
    async mode => {
      const f = await privateFile();
      await chmod(f.dir, mode);
      await expect(readPrivateRepairInput(f.file, 4096)).rejects.toMatchObject({
        code: "PRIVATE_INPUT_UNSAFE",
      });
    }
  );
  it("rejects symbolic-link files without reading their target", async () => {
    const f = await privateFile();
    const alias = `${f.dir}/alias.json`;
    await symlink(f.file, alias);
    await expect(readPrivateRepairInput(alias, 4096)).rejects.toMatchObject({
      code: "PRIVATE_INPUT_UNSAFE",
    });
  });
  it("rejects symlinked parent even when the target is private", async () => {
    const f = await privateFile();
    const other = await privateFile();
    const alias = `${other.dir}/alias`;
    await symlink(f.dir, alias);
    await expect(
      readPrivateRepairInput(`${alias}/input.json`, 4096)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_UNSAFE" });
  });
  it("rejects multiply linked files", async () => {
    const f = await privateFile();
    await link(f.file, `${f.dir}/hard-link.json`);
    await expect(readPrivateRepairInput(f.file, 4096)).rejects.toMatchObject({
      code: "PRIVATE_INPUT_UNSAFE",
    });
  });
  it("rejects oversized input before reading beyond its bound", async () => {
    const f = await privateFile();
    await expect(
      readPrivateRepairInput(f.file, f.bytes.length - 1)
    ).rejects.toMatchObject({ code: "PRIVATE_INPUT_TOO_LARGE" });
  });
  it("publishes actual synthetic attestation exclusively, fsyncs, and reads it back with exact digest and no new authority", async () => {
    const { intent, attestation } = createRepairFixture();
    const output = await createPrivateRelinkOutput();
    owned.add(output.directory);
    const artifact = await output.writePlan(attestation);
    const ds = await lstat(output.directory);
    const fs = await lstat(artifact.path);
    expect(ds.mode & 0o7777).toBe(0o700);
    expect(fs.mode & 0o7777).toBe(0o600);
    expect(fs.nlink).toBe(1);
    expect(fs.uid).toBe(process.geteuid!());
    const bytes = await readPrivateRepairInput(artifact.path, 65536);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      artifact.sha256
    );
    const decoded = parseOperatorAttestationBytes(bytes, intent);
    expect(decoded).toMatchObject({
      writeAuthorized: false,
      independentReview: null,
      historicalByteIdentity: "UNPROVEN",
    });
    await expect(output.writePlan(attestation)).rejects.toMatchObject({
      code: "OUTPUT_ALREADY_USED",
    });
  });
});
