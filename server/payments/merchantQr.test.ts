import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import sharp from "sharp";
import {
  generateMerchantQr,
  generateMerchantQrPayload,
  merchantQrCrc,
  MAX_MERCHANT_QR_SATANG,
} from "./merchantQr";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/merchant-qr.synthetic.json", import.meta.url),
    "utf8"
  )
);
const fields = (text: string) => {
  const out: [string, string][] = [];
  for (let at = 0; at < text.length;) {
    const length = Number(text.slice(at + 2, at + 4));
    out.push([text.slice(at, at + 2), text.slice(at + 4, at + 4 + length)]);
    at += 4 + length;
  }
  return out;
};
const encode = (pairs: [string, string][]) =>
  pairs.map(([t, v]) => t + String(v.length).padStart(2, "0") + v).join("");
const seal = (pairs: [string, string][]) => {
  const body = encode(pairs.filter(([t]) => t !== "63")) + "6304";
  return body + merchantQrCrc(body);
};
const replace = (tag: string, value: string) =>
  seal(fields(fixture.template).map(([t, v]) => [t, t === tag ? value : v]));
function decoded(png: Buffer) {
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)
    ?.data;
}
describe("merchant QR template amount generation", () => {
  it("checks CRC against the external standard check vector", () => {
    expect(merchantQrCrc("123456789")).toBe("29B1");
  });
  it("matches a fixed independent golden payload and CRC", () => {
    expect(generateMerchantQrPayload(fixture.template, 100)).toBe(
      fixture.oneBaht
    );
  });
  it.each([1, 99, 100, 101, 1999, 10000, 999999999999])(
    "preserves receiver and all opaque fields for %i satang",
    amount => {
      const result = generateMerchantQrPayload(fixture.template, amount);
      const pairs = fields(result);
      expect(pairs.filter(([t]) => !["54", "63"].includes(t))).toEqual(
        fields(fixture.template).filter(([t]) => t !== "63")
      );
      expect(pairs.filter(([t]) => t === "54")).toEqual([
        [
          "54",
          Math.floor(amount / 100) +
            "." +
            String(amount % 100).padStart(2, "0"),
        ],
      ]);
      expect(result.slice(-4)).toBe(merchantQrCrc(result.slice(0, -4)));
    }
  );
  it("replaces an existing amount without duplicates and is idempotent", () => {
    const result = generateMerchantQrPayload(fixture.oneBaht, 1999);
    expect(fields(result).filter(([t]) => t === "54")).toEqual([
      ["54", "19.99"],
    ]);
    expect(generateMerchantQrPayload(result, 1999)).toBe(result);
    expect(generateMerchantQrPayload(result, 100)).toBe(fixture.oneBaht);
  });
  it.each([
    0,
    -1,
    1.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    MAX_MERCHANT_QR_SATANG + 1,
    "100",
    null,
  ])("rejects invalid amount %s", value => {
    expect(() =>
      generateMerchantQrPayload(fixture.template, value as number)
    ).toThrow("INVALID_MERCHANT_QR_AMOUNT");
  });
  it.each([
    ["bad CRC", () => fixture.template.slice(0, -4) + "0000"],
    ["truncated", () => fixture.template.slice(0, -3)],
    ["trailing junk", () => fixture.template + "00"],
    ["non-ASCII", () => fixture.template.replace("TESTSHOP", "ทดสอบร้าน")],
    ["oversized", () => "0".repeat(1025)],
    ["bad format", () => replace("00", "02")],
    ["dynamic template", () => replace("01", "12")],
    ["wrong currency", () => replace("53", "840")],
    ["wrong country", () => replace("58", "US")],
    [
      "wrong AID",
      () =>
        replace(
          "30",
          new Map(fields(fixture.template))
            .get("30")!
            .replace("010112", "010111")
        ),
    ],
    [
      "missing merchant",
      () => seal(fields(fixture.template).filter(([t]) => t !== "30")),
    ],
    [
      "missing ref1",
      () =>
        replace(
          "30",
          encode(
            fields(new Map(fields(fixture.template)).get("30")!).filter(
              ([t]) => t !== "02"
            )
          )
        ),
    ],
    [
      "bad biller",
      () =>
        replace(
          "30",
          new Map(fields(fixture.template))
            .get("30")!
            .replace("0115000000000000000", "0115XXXXXXXXXXXXXXX")
        ),
    ],
    [
      "duplicate root",
      () =>
        seal([
          ...fields(fixture.template).filter(([t]) => t !== "63"),
          ["53", "764"],
        ]),
    ],
    [
      "duplicate nested",
      () =>
        replace("30", new Map(fields(fixture.template)).get("30")! + "0201A"),
    ],
    ["malformed nested", () => replace("31", "0009short")],
    [
      "tip",
      () =>
        seal(
          [
            ...fields(fixture.template).filter(([t]) => t !== "63"),
            ["55", "01"],
          ].sort((a, b) => a[0].localeCompare(b[0])) as [string, string][]
        ),
    ],
    [
      "invalid old amount",
      () =>
        seal(
          [
            ...fields(fixture.template).filter(([t]) => t !== "63"),
            ["54", "-1.00"],
          ].sort((a, b) => a[0].localeCompare(b[0])) as [string, string][]
        ),
    ],
    ["bad length", () => fixture.template.replace("5908", "5999")],
  ] as const)("fails closed for %s", (_name, make) => {
    expect(() => generateMerchantQrPayload(make(), 100)).toThrow(
      "INVALID_MERCHANT_QR_TEMPLATE"
    );
  });
  it.each([1, 100, 12345, MAX_MERCHANT_QR_SATANG])(
    "renders PNG and SVG that independently decode (%i)",
    async amount => {
      const result = await generateMerchantQr(fixture.template, amount);
      expect(decoded(result.png)).toBe(result.payload);
      expect(
        decoded(
          await sharp(Buffer.from(result.svg)).resize(800, 800).png().toBuffer()
        )
      ).toBe(result.payload);
      const image = PNG.sync.read(result.png);
      expect([...image.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    }
  );
});

const privatePath = process.env.MERCHANT_QR_FIXTURE_FILE;
describe.skipIf(!privatePath)("private user-provided K SHOP fixtures", () => {
  it("matches the bank-app sample byte for byte and independently decodes both images", async () => {
    const real = JSON.parse(readFileSync(privatePath!, "utf8"));
    const qr = await generateMerchantQr(real.template, 100);
    // Boolean comparisons keep merchant identifiers out of assertion logs.
    expect(qr.payload === real.oneBaht).toBe(true);
    expect(decoded(qr.png) === real.oneBaht).toBe(true);
    expect(
      decoded(
        await sharp(Buffer.from(qr.svg)).resize(800, 800).png().toBuffer()
      ) === real.oneBaht
    ).toBe(true);
  });
});
