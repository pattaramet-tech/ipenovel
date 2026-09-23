import { describe, expect, it } from "vitest";

import { extractGoogleDocId, parseIntakeRow } from "./intake";

describe("NQA intake parser", () => {
  it("extracts a Google Docs id without treating the deep-linked tab as identity", () => {
    expect(
      extractGoogleDocId(
        "https://docs.google.com/document/d/1abcDEF_123-xyz/edit?tab=t.abc"
      )
    ).toBe("1abcDEF_123-xyz");
  });

  it("parses the current canonical bundle locator", () => {
    const result = parseIntakeRow({
      locator: {
        spreadsheetId: "1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y",
        sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
        sheetId: 0,
        row: 1562,
      },
      novelDisplayTitle:
        "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230",
      translationUrl:
        "https://docs.google.com/document/d/1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ/edit?tab=t.5tvv9nt8ogpt",
      webSourceUrl:
        "https://www.webnovel.com/th/book/the-shinobi-of-straw-hats_19016984905951905",
      preparedSourceUrl:
        "https://docs.google.com/document/d/1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q/edit",
    });

    expect(result.status).toBe("PASS");
    if (result.status === "PASS") {
      expect(result.contract.preparedSourceRef.documentId).toBe(
        "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q"
      );
      expect(result.parsedBundle).toMatchObject({
        rangeStart: 181,
        rangeEnd: 230,
      });
    }
  });

  it("fails closed when K is missing even when E exists", () => {
    const result = parseIntakeRow({
      locator: {
        spreadsheetId: "spreadsheet-12345",
        sheetName: "Sheet",
        row: 10,
      },
      novelDisplayTitle: "เรื่องทดสอบ 001 - 030",
      translationUrl:
        "https://docs.google.com/document/d/translationDoc123/edit",
      webSourceUrl: "https://example.com/source",
      preparedSourceUrl: null,
    });

    expect(result).toMatchObject({
      status: "FAIL",
      issues: ["SOURCE_REFERENCE_MISSING"],
    });
  });

  it("rejects malformed C document references", () => {
    const result = parseIntakeRow({
      locator: {
        spreadsheetId: "spreadsheet-12345",
        sheetName: "Sheet",
        row: 10,
      },
      novelDisplayTitle: "เรื่องทดสอบ 001 - 030",
      translationUrl: "https://example.com/not-a-google-doc",
      preparedSourceUrl:
        "https://docs.google.com/document/d/sourceDoc12345/edit",
    });

    expect(result).toMatchObject({
      status: "FAIL",
      issues: ["TRANSLATION_REFERENCE_INVALID"],
    });
  });
});
