import { describe, expect, it, vi } from "vitest";

import { GoogleRestNovelIdSheetBackfillTransport } from "./googleTransport";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NQA narrow Google Sheet Column A backfill transport", () => {
  it("reads only A:B identity context and writes exactly A{row}", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.includes("includeGridData=false")) {
        return jsonResponse({
          spreadsheetId: "sheet-1",
          properties: { title: "รวมนิยาย" },
          sheets: [{ properties: { title: "นิยายยังไม่จบ/ยังไม่ยื่น" } }],
        });
      }
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse({
          range: "'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744:B1744",
          majorDimension: "ROWS",
          values: [
            [
              "",
              "นารูโตะ: ระบบนักรับจ้าง โลกนินจาไม่มีศัตรู มีแต่ลูกค้า 081 - 130",
            ],
          ],
        });
      }
      return jsonResponse({
        updatedRange: "'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744",
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      });
    });

    const transport = new GoogleRestNovelIdSheetBackfillTransport({
      accessTokenProvider: () => "test-token",
      fetchFn,
    });

    const row = await transport.readRowIdentity({
      spreadsheetId: "sheet-1",
      sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
      row: 1744,
    });
    expect(row).toMatchObject({
      spreadsheetTitle: "รวมนิยาย",
      novelIdCell: null,
      row: 1744,
    });

    const receipt = await transport.writeNovelId({
      spreadsheetId: "sheet-1",
      sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
      row: 1744,
      novelId: 812,
    });
    expect(receipt).toEqual({
      updatedRange: "'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744",
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    });

    const put = requests.find(request => request.init?.method === "PUT");
    expect(put).toBeTruthy();
    expect(decodeURIComponent(put!.url)).toContain(
      "/values/'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744?"
    );
    expect(JSON.parse(String(put!.init?.body))).toEqual({
      range: "'นิยายยังไม่จบ/ยังไม่ยื่น'!A1744",
      majorDimension: "ROWS",
      values: [[812]],
    });
    expect(JSON.stringify(put)).not.toContain("A1744:B1744");
  });
});
