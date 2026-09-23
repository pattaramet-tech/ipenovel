import { expect, type Page } from "@playwright/test";
import { e2eBaseUrl } from "./env";

export type RuntimeWatch = {
  failures: string[];
  assertClean: () => void;
};

export function watchRuntimeFailures(page: Page): RuntimeWatch {
  const failures: string[] = [];
  const expectedOrigin = new URL(e2eBaseUrl).origin;

  page.on("pageerror", error => {
    failures.push(`pageerror: ${error.message}`);
  });

  page.on("response", response => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(response.url()).origin === expectedOrigin;
    } catch {
      return;
    }
    if (sameOrigin && response.status() >= 500) {
      failures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`
      );
    }
  });

  return {
    failures,
    assertClean: () => {
      expect(failures, failures.join("\n")).toEqual([]);
    },
  };
}

export async function gotoOk(page: Page, pathname: string) {
  const response = await page.goto(pathname, { waitUntil: "domcontentloaded" });
  expect(response, `No navigation response for ${pathname}`).not.toBeNull();
  expect(
    response!.status(),
    `${pathname} returned ${response!.status()}`
  ).toBeLessThan(400);
  return response!;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
