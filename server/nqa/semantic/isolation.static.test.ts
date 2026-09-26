import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SEMANTIC_DIR = path.resolve(process.cwd(), "server/nqa/semantic");

function productionSources(): string[] {
  return fs
    .readdirSync(SEMANTIC_DIR)
    .filter(
      file =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "privateBridge.ts"
    )
    .map(file => path.join(SEMANTIC_DIR, file));
}

describe("NQA M09 semantic isolation", () => {
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

  it("contains no Google production mutation or network listener", () => {
    const forbidden = [
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

  it("contains no external paid LLM/provider endpoint", () => {
    const forbiddenProviders = [
      /api\.openai\.com/i,
      /api\.anthropic\.com/i,
      /generativelanguage\.googleapis\.com/i,
      /api\.cohere\.ai/i,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenProviders) {
        expect(
          pattern.test(source),
          "external model endpoint in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("routes embedding endpoint validation through the centralized private-sidecar policy", () => {
    const provider = fs.readFileSync(
      path.join(SEMANTIC_DIR, "embedding.ts"),
      "utf8"
    );
    const policy = fs.readFileSync(
      path.join(SEMANTIC_DIR, "sidecarEndpoint.ts"),
      "utf8"
    );

    expect(provider).toContain("validateNqaSidecarEndpoint");
    expect(policy).toContain('"127.0.0.1"');
    expect(policy).toContain('"localhost"');
    expect(policy).toContain('"::1"');
    expect(policy).toContain("Remote private NQA sidecar endpoints require the private bridge gate.");
  });

  it("keeps full source and translation text out of semantic evidence", () => {
    const source = fs.readFileSync(
      path.join(SEMANTIC_DIR, "search.ts"),
      "utf8"
    );

    expect(source).not.toMatch(
      /boundedSummary:\s*(?:translationText|sourceTexts)/
    );
  });
});
