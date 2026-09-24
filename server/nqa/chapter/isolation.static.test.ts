import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CHAPTER_DIR = path.resolve(process.cwd(), "server/nqa/chapter");

function productionSources(): string[] {
  return fs
    .readdirSync(CHAPTER_DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(CHAPTER_DIR, file));
}

describe("NQA M07 chapter isolation", () => {
  it("does not import shared router, workspace, database, or client surfaces", () => {
    const forbiddenImports = [
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
      /from\s+["'][^"']*client[^"']*["']/i,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenImports) {
        expect(
          pattern.test(source),
          `forbidden import in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });

  it("contains no Google mutation method or production listener", () => {
    const forbidden = [
      /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i,
      /:batchUpdate/i,
      /documents\.batchUpdate/i,
      /\.listen\s*\(/,
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\brouter\.(?:get|post|put|patch|delete)\s*\(/,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(source),
          `mutation/transport surface in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });

  it("does not use tab index as a chapter identity comparison", () => {
    const parser = fs.readFileSync(path.join(CHAPTER_DIR, "parser.ts"), "utf8");
    const resolver = fs.readFileSync(
      path.join(CHAPTER_DIR, "resolver.ts"),
      "utf8"
    );

    expect(resolver).not.toMatch(/tabIndex\s*===\s*.*chapter/);
    expect(parser).not.toMatch(/chapter\s*=\s*tab\.index/);
  });
});
