import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DETERMINISTIC_DIR = path.resolve(
  process.cwd(),
  "server/nqa/deterministic"
);

function productionSources(): string[] {
  return fs
    .readdirSync(DETERMINISTIC_DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(DETERMINISTIC_DIR, file));
}

describe("NQA M08 deterministic isolation", () => {
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
          "forbidden import in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("contains no production mutation or network listener", () => {
    const forbidden = [
      /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i,
      /:batchUpdate/i,
      /documents\.batchUpdate/i,
      /spreadsheets\.batchUpdate/i,
      /\.listen\s*\(/,
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\brouter\.(?:get|post|put|patch|delete)\s*\(/,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(source),
          "mutation/transport surface in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("does not implement semantic-model or embedding execution", () => {
    const forbiddenSemanticMarkers = [
      /embedding/i,
      /cross.?encoder/i,
      /semantic model/i,
      /openai/i,
      /anthropic/i,
      /gemini/i,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenSemanticMarkers) {
        expect(
          pattern.test(source),
          "semantic-model surface in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("keeps full chapter text out of deterministic result evidence", () => {
    const engine = fs.readFileSync(
      path.join(DETERMINISTIC_DIR, "engine.ts"),
      "utf8"
    );

    expect(engine).not.toMatch(
      /boundedSummary:\s*(?:sourceText|translationText)/
    );
  });
});
