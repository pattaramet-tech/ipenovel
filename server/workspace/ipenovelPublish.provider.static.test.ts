import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(
  path.resolve(process.cwd(), "server/workspace/ipenovelPublish.provider.ts"),
  "utf8"
);

describe("IpeNovel publish NQA pre-publish hygiene boundary", () => {
  it("runs the NQA hygiene gate before reader visibility is enabled", () => {
    const gateIndex = SOURCE.indexOf(
      "const hygiene = buildNqaPrePublishHygieneGate"
    );
    const publishIndex = SOURCE.indexOf("isPublished: true");

    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(gateIndex);
    expect(SOURCE).toContain('"CONTENT_HYGIENE_BLOCKED"');
  });

  it("persists deterministic remediation and hygiene evidence with the publish transaction", () => {
    expect(SOURCE).toContain("content: hygiene.sanitizedContent");
    expect(SOURCE).toContain("wordCount(hygiene.sanitizedContent)");
    expect(SOURCE).toContain("nqaPrePublishHygiene");
    expect(SOURCE).toContain(
      "artifactFingerprint: hygiene.artifactFingerprint"
    );
    expect(SOURCE).toContain("residualSignals: hygiene.residualSignals");
  });
});
