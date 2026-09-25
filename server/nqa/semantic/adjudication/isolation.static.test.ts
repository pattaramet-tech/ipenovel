import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/semantic/adjudication");

function productionSources(): string[] {
  return fs
    .readdirSync(DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(DIR, file));
}

describe("NQA M11 adjudication isolation", () => {
  it("does not import shared router, workspace, database, or client surfaces", () => {
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
        expect(
          pattern.test(source),
          "forbidden import in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("contains no production mutation or application listener", () => {
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
          "mutation/listener surface in " + path.basename(file)
        ).toBe(false);
      }
    }
  });

  it("allows external HTTP only for the explicit Jev provider", () => {
    for (const file of productionSources()) {
      const source = fs.readFileSync(file, "utf8");
      if (path.basename(file) === "jev.ts") continue;

      expect(source).not.toMatch(/https?:\/\//i);
    }

    const jev = fs.readFileSync(path.join(DIR, "jev.ts"), "utf8");
    expect(jev).toContain("api.typesafe.ai");
    expect(jev).toContain("thejevai.com");
  });

  it("keeps Jev state text-free", () => {
    const contracts = fs.readFileSync(path.join(DIR, "contracts.ts"), "utf8");
    const evidence = fs.readFileSync(path.join(DIR, "evidence.ts"), "utf8");

    expect(contracts).toContain("Omit<");
    expect(contracts).toContain('"snippets"');
    expect(evidence).toContain("snippetSignals");
    expect(evidence).not.toMatch(/snippetSignals:[\s\S]{0,500}sourceText:/);
  });

  it("keeps Jev final-decision authority disabled by default", () => {
    const policy = fs.readFileSync(path.join(DIR, "policy.ts"), "utf8");

    expect(policy).toContain("allowJevFinalDecision: false");
  });
});
