import QRCode from "qrcode";

type Field = { tag: string; value: string };
const invalid = () => new Error("INVALID_MERCHANT_QR_TEMPLATE");

/** CRC-16/CCITT-FALSE; input profile is printable ASCII, so lengths are bytes. */
export function merchantQrCrc(value: string): string {
  let crc = 0xffff;
  for (let index = 0; index < value.length; index++) {
    crc ^= value.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function parse(value: string): Field[] {
  const fields: Field[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < value.length) {
    const header = value.slice(offset, offset + 4);
    if (!/^\d{4}$/.test(header)) throw invalid();
    const tag = header.slice(0, 2);
    const length = Number(header.slice(2));
    if (!length || seen.has(tag) || offset + 4 + length > value.length)
      throw invalid();
    fields.push({ tag, value: value.slice(offset + 4, offset + 4 + length) });
    seen.add(tag);
    offset += 4 + length;
  }
  return fields;
}
const encode = (fields: Field[]) =>
  fields
    .map(
      ({ tag, value }) => tag + String(value.length).padStart(2, "0") + value
    )
    .join("");

/** Format constraint only. Checkout must additionally enforce its business limits. */
export const MAX_MERCHANT_QR_SATANG = 999_999_999_999;
export function formatMerchantQrAmount(amountSatang: number): string {
  if (
    !Number.isSafeInteger(amountSatang) ||
    amountSatang <= 0 ||
    amountSatang > MAX_MERCHANT_QR_SATANG
  )
    throw new Error("INVALID_MERCHANT_QR_AMOUNT");
  return (
    Math.floor(amountSatang / 100) +
    "." +
    String(amountSatang % 100).padStart(2, "0")
  );
}

function validatedFields(template: string): Field[] {
  if (
    typeof template !== "string" ||
    template.length > 1024 ||
    !/^[\x20-\x7E]+$/.test(template)
  )
    throw invalid();
  const fields = parse(template);
  const get = (tag: string) => fields.find(field => field.tag === tag)?.value;
  if (
    fields[0]?.tag !== "00" ||
    get("00") !== "01" ||
    get("01") !== "11" ||
    get("53") !== "764" ||
    get("58") !== "TH"
  )
    throw invalid();
  // Dynamic/bank-issued tokens must never be repurposed as reusable templates.
  if (fields.some((field, i) => i > 0 && field.tag <= fields[i - 1].tag))
    throw invalid();
  const checksum = fields.at(-1);
  if (
    checksum?.tag !== "63" ||
    !/^[0-9A-F]{4}$/.test(checksum.value) ||
    merchantQrCrc(template.slice(0, -4)) !== checksum.value
  )
    throw invalid();
  // Tips and VAT introduce an additional amount policy not supported here.
  if (["55", "56", "57", "80"].some(tag => get(tag) !== undefined))
    throw invalid();
  const account = new Map(
    parse(get("30") ?? "").map(field => [field.tag, field.value])
  );
  if (
    account.get("00") !== "A000000677010112" ||
    !/^\d{15}$/.test(account.get("01") ?? "") ||
    !/^[A-Za-z0-9]{1,20}$/.test(account.get("02") ?? "") ||
    (account.has("03") && !/^[A-Za-z0-9]{1,20}$/.test(account.get("03")!))
  )
    throw invalid();
  for (const tag of ["31", "62"]) {
    const nested = get(tag);
    if (nested !== undefined) parse(nested);
  }
  const amount = get("54");
  if (
    amount !== undefined &&
    (!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(amount) || Number(amount) <= 0)
  )
    throw invalid();
  return fields;
}

/**
 * Trusted merchant template + server-derived integer satang only.
 * CRC checks syntax/integrity, not ownership. Never expose arbitrary template
 * or amount input as a public checkout API; resolve both on the server.
 */
export function generateMerchantQrPayload(
  template: string,
  amountSatang: number
): string {
  const amount = formatMerchantQrAmount(amountSatang);
  const fields = validatedFields(template).filter(
    field => field.tag !== "54" && field.tag !== "63"
  );
  const index = fields.findIndex(field => field.tag > "54");
  fields.splice(index < 0 ? fields.length : index, 0, {
    tag: "54",
    value: amount,
  });
  const body = encode(fields) + "6304";
  return body + merchantQrCrc(body);
}

/** Fixed rendering settings retain a 4-module quiet zone and solid contrast. */
export async function generateMerchantQr(
  template: string,
  amountSatang: number
) {
  const payload = generateMerchantQrPayload(template, amountSatang);
  const options = { errorCorrectionLevel: "M" as const, margin: 4, scale: 8 };
  const png = await QRCode.toBuffer(payload, { ...options, type: "png" });
  const svg = await QRCode.toString(payload, { ...options, type: "svg" });
  return { payload, amount: formatMerchantQrAmount(amountSatang), png, svg };
}
