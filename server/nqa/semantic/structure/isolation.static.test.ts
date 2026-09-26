import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/semantic/structure");

function productionSources(): string[] {
  return fs
    .readdirSync(DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(DIR, file));
}

describe("NQA M12 structure isolation", () => {
  it("does not import shared router/workspace/database/client surfaces", () => {
    const forbidden = [
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
      /from\s+["'][^"']*client[^"']*["']/i,
    ];

    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source)).toBe(false);
      }
    }
  });

  it("contains no production mutation/listener surface", () => {
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
        expect(pattern.test(source)).toBe(false);
      }
    }
  });

  it("contains no paid external model endpoint", () => {
    const source = productionSources()
      .map(file => fs.readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/api\.openai\.com/i);
    expect(source).not.toMatch(/api\.anthropic\.com/i);
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
    expect(source).not.toMatch(/api\.cohere\.ai/i);
  });

  it("routes structure endpoint validation through the centralized private-sidecar policy", () => {
    const provider = fs.readFileSync(path.join(DIR, "provider.ts"), "utf8");
    const policy = fs.readFileSync(
      path.resolve(DIR, "..", "sidecarEndpoint.ts"),
      "utf8"
    );

    expect(provider).toContain("validateNqaSidecarEndpoint");
    expect(policy).toContain('"127.0.0.1"');
    expect(policy).toContain('"localhost"');
    expect(policy).toContain('"::1"');
    expect(policy).toContain("Remote private NQA sidecar endpoints require the private bridge gate.");
  });
});
