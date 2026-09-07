import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/LoginPage.tsx"), "utf8");

describe("LoginPage Preview auth configuration safety", () => {
  it("uses the non-throwing Manus URL builder and never calls the strict builder directly", () => {
    expect(source).toMatch(/tryBuildManusLoginUrl/);
    expect(source).not.toMatch(/\bbuildManusLoginUrl\s*\(/);
  });

  it("keeps Google login renderable when the optional Manus URL is unavailable", () => {
    expect(source).toMatch(/href=\{GOOGLE_LOGIN_START_PATH\}/);
    expect(source.match(/\{manusLoginUrl && \(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
