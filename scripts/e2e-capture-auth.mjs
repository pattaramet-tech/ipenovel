import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "@playwright/test";

const previewHost = "r2-preview.ipenovel.com";
const baseURL = process.env.E2E_BASE_URL?.trim() || `https://${previewHost}`;
const target = new URL(baseURL);

if (![previewHost, "localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error(`Refusing auth capture against ${target.hostname}`);
}

const statePath = path.resolve(
  process.env.E2E_STORAGE_STATE?.trim() || ".playwright/.auth/user.json"
);

await fs.mkdir(path.dirname(statePath), { recursive: true });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
const rl = readline.createInterface({ input, output });
try {
  await page.goto(new URL("/login", baseURL).toString(), {
    waitUntil: "domcontentloaded",
  });
  console.log(`Opened ${baseURL}`);
  console.log(
    "Sign in with the dedicated Preview test account in the browser."
  );
  console.log("Do not paste credentials into this terminal or into ChatGPT.");
  await rl.question(
    "When login is complete, press Enter here to verify and save state... "
  );

  await page.goto(new URL("/cart", baseURL).toString(), {
    waitUntil: "domcontentloaded",
  });

  const authenticatedCartHeading = page.locator("h1");
  if ((await authenticatedCartHeading.count()) === 0) {
    throw new Error(
      "Authentication verification failed: /cart did not render its authenticated heading."
    );
  }

  await context.storageState({ path: statePath });
  console.log(`Saved Playwright auth state to ${statePath}`);
} finally {
  rl.close();
  await browser.close();
}
