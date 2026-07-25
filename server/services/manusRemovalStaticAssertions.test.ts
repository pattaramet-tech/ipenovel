import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Literal source-text assertions (not a mock-call check - see
 * slipFileUploadService.test.ts / fileService.test.ts for the runtime
 * equivalent) that the two payment-slip/episode-file upload services no
 * longer reference the legacy Manus storage proxy at all, now that both
 * upload to the private R2 bucket instead.
 */
describe("Manus storagePut removal - static source assertions", () => {
  it("slipFileUploadService.ts no longer imports or calls the legacy storagePut", () => {
    const source = readFileSync(join(__dirname, "slipFileUploadService.ts"), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/storage["']/);
    expect(source).not.toMatch(/\bstoragePut\s*\(/);
  });

  it("fileService.ts no longer imports or calls the legacy storagePut", () => {
    const source = readFileSync(join(__dirname, "fileService.ts"), "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/storage["']/);
    expect(source).not.toMatch(/\bstoragePut\s*\(/);
  });

  it("both services import putPrivateObject from the private R2 adapter instead", () => {
    const slipSource = readFileSync(join(__dirname, "slipFileUploadService.ts"), "utf8");
    const fileSource = readFileSync(join(__dirname, "fileService.ts"), "utf8");
    expect(slipSource).toMatch(/putPrivateObject/);
    expect(fileSource).toMatch(/putPrivateObject/);
  });
});
