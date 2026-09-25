import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(process.cwd(), "server/nqa/autolink");

describe("NQA novel-id autolink mutation isolation", () => {
  it("keeps the writer scoped to Sheets values API and explicit Column A", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "googleTransport.ts"),
      "utf8"
    );

    expect(source).toContain('"!A" + input.row');
    expect(source).toContain('":B" +');
    expect(source).not.toMatch(/batchUpdate/i);
    expect(source).not.toMatch(/documents\.batchUpdate/i);
    expect(source).not.toMatch(/permissions\.(?:create|update|delete)/i);
  });

  it("does not mutate Workspace or enable permissions from the autolink module", () => {
    const source = fs
      .readdirSync(ROOT)
      .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map(file => fs.readFileSync(path.join(ROOT, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/bindPublicationNovel\s*\(/);
    expect(source).not.toMatch(/NQA_V1_ENABLED_PERMISSION_TIERS\s*=/);
    expect(source).not.toMatch(/\.listen\s*\(/);
  });
});
