import { describe, expect, it } from "vitest";

import { makeNovelCandidateIdentity } from "../core";
import { parseIntakeRow } from "../intake";
import type { SourceContract } from "../contracts";
import type { NqaIdentityCatalog } from "./contracts";
import { NqaNovelIdentityResolver, titleDiceSimilarity } from "./resolver";

function contractFor(input: {
  title: string;
  translationId?: string;
  sourceId?: string;
}): SourceContract {
  const result = parseIntakeRow({
    locator: {
      spreadsheetId: "spreadsheet-12345",
      sheetName: "Sheet",
      sheetId: 1,
      row: 10,
    },
    novelDisplayTitle: `${input.title} 001 - 030`,
    translationUrl:
      "https://docs.google.com/document/d/" +
      (input.translationId ?? "translationDoc12345") +
      "/edit",
    webSourceUrl: "https://example.com/source",
    preparedSourceUrl:
      "https://docs.google.com/document/d/" +
      (input.sourceId ?? "sourceDocument12345") +
      "/edit",
  });

  if (result.status !== "PASS") {
    throw new Error("test contract failed to parse");
  }
  return result.contract;
}

function catalogFor(
  entries: Array<{
    title: string;
    aliases?: string[];
    translationIds?: string[];
    sourceIds?: string[];
  }>
): NqaIdentityCatalog {
  return {
    novels: entries.map(entry => ({
      novel: {
        ...makeNovelCandidateIdentity(entry.title),
        aliases: entry.aliases ?? [],
      },
      translationDocumentIds: entry.translationIds ?? [],
      sourceDocumentIds: entry.sourceIds ?? [],
    })),
    bundles: [],
  };
}
describe("NQA novel identity resolver", () => {
  it("returns the same structured novel id across bundle ranges", () => {
    const resolver = new NqaNovelIdentityResolver({
      novels: [],
      bundles: [],
    });
    const title = "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา";

    const a = resolver.resolve({
      canonicalTitle: title,
      contract: contractFor({
        title,
        translationId: "translationDocA123",
        sourceId: "sourceDocumentA123",
      }),
    });
    const b = resolver.resolve({
      canonicalTitle: title,
      contract: contractFor({
        title,
        translationId: "translationDocB123",
        sourceId: "sourceDocumentB123",
      }),
    });

    expect(a.status).toBe("NEW");
    expect(b.status).toBe("NEW");
    if (a.status === "NEW" && b.status === "NEW") {
      expect(a.novel.novelId).toBe(b.novel.novelId);
    }
  });

  it("resolves an exact canonical title", () => {
    const catalog = catalogFor([{ title: "เรื่องทดสอบ" }]);
    const resolver = new NqaNovelIdentityResolver(catalog);

    const result = resolver.resolve({
      canonicalTitle: " เรื่องทดสอบ ",
      contract: contractFor({ title: "เรื่องทดสอบ" }),
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      kind: "EXACT_TITLE",
      novel: { authority: "EXACT" },
    });
  });

  it("resolves a configured exact alias", () => {
    const catalog = catalogFor([
      {
        title: "เรื่องหลัก",
        aliases: ["ชื่อเก่า"],
      },
    ]);
    const resolver = new NqaNovelIdentityResolver(catalog);

    const result = resolver.resolve({
      canonicalTitle: "ชื่อเก่า",
      contract: contractFor({ title: "ชื่อเก่า" }),
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      kind: "ALIAS",
      novel: { authority: "ALIAS" },
    });
  });
  it("prioritizes known document identity", () => {
    const catalog = catalogFor([
      {
        title: "เรื่องหลัก",
        sourceIds: ["knownSourceDoc123"],
      },
    ]);
    const resolver = new NqaNovelIdentityResolver(catalog);

    const result = resolver.resolve({
      canonicalTitle: "ชื่อที่ยังไม่อยู่ใน alias",
      contract: contractFor({
        title: "ชื่อที่ยังไม่อยู่ใน alias",
        sourceId: "knownSourceDoc123",
      }),
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      kind: "KNOWN_DOCUMENT",
    });
  });

  it("reviews conflicting exact document identities", () => {
    const catalog = catalogFor([
      {
        title: "เรื่องหนึ่ง",
        translationIds: ["translationConflict123"],
      },
      {
        title: "เรื่องสอง",
        sourceIds: ["sourceConflict12345"],
      },
    ]);
    const resolver = new NqaNovelIdentityResolver(catalog);

    const result = resolver.resolve({
      canonicalTitle: "ชื่อใหม่",
      contract: contractFor({
        title: "ชื่อใหม่",
        translationId: "translationConflict123",
        sourceId: "sourceConflict12345",
      }),
    });

    expect(result).toMatchObject({
      status: "REVIEW",
      kind: "AMBIGUOUS",
    });
    if (result.status === "REVIEW") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("reviews a fuzzy candidate instead of auto-merging", () => {
    const canonical = "วันพีซ ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา";
    const catalog = catalogFor([{ title: canonical }]);
    const resolver = new NqaNovelIdentityResolver(catalog, {
      fuzzyThreshold: 0.8,
    });

    const result = resolver.resolve({
      canonicalTitle: "วันพีซ ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจ",
      contract: contractFor({
        title: "วันพีซ ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจ",
      }),
    });

    expect(result).toMatchObject({
      status: "REVIEW",
      kind: "FUZZY_REVIEW",
      novel: null,
    });
    if (result.status === "REVIEW") {
      expect(result.candidates[0].score).toBeGreaterThanOrEqual(0.8);
    }
  });
  it("creates a structured new identity when no known candidate is close", () => {
    const catalog = catalogFor([{ title: "คนละเรื่องโดยสิ้นเชิง" }]);
    const resolver = new NqaNovelIdentityResolver(catalog);

    const result = resolver.resolve({
      canonicalTitle: "นารูโตะ การผจญภัยครั้งใหม่",
      contract: contractFor({
        title: "นารูโตะ การผจญภัยครั้งใหม่",
      }),
    });

    expect(result).toMatchObject({
      status: "NEW",
      kind: "STRUCTURED_NEW",
      novel: { authority: "STRUCTURED" },
    });
  });

  it("uses deterministic bounded character-bigram similarity", () => {
    expect(titleDiceSimilarity("abc", "abc")).toBe(1);
    expect(titleDiceSimilarity("abc", "xyz")).toBe(0);
    expect(titleDiceSimilarity("abc", "abd")).toBeGreaterThan(0);
    expect(titleDiceSimilarity("abc", "abd")).toBeLessThan(1);
  });
});
