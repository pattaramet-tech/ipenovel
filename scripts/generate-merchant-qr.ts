import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateMerchantQr } from "../server/payments/merchantQr";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !/^[1-9]\d*$/.test(args[1])) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/generate-merchant-qr.ts <trusted-template.txt> <integer-satang> <new-output-directory>"
    );
  }
  const template = (await readFile(resolve(args[0]), "utf8")).trim();
  const qr = await generateMerchantQr(template, Number(args[1]));
  const out = resolve(args[2]);
  // Exclusive directory creation prevents accidental overwrite of earlier evidence.
  await mkdir(out);
  await writeFile(resolve(out, "payment-qr.png"), qr.png, { flag: "wx" });
  await writeFile(resolve(out, "payment-qr.svg"), qr.svg, { flag: "wx" });
  console.log(
    JSON.stringify({
      amount: qr.amount,
      outputDirectory: out,
      files: ["payment-qr.png", "payment-qr.svg"],
      bankPaymentTested: false,
    })
  );
}
main().catch(error => {
  console.error(
    error instanceof Error ? error.message : "QR_GENERATION_FAILED"
  );
  process.exitCode = 1;
});
