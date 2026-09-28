import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  new URL("./vite.ts", import.meta.url),
  "utf8"
);

describe("production frontend asset cache hardening", () => {
  it("never lets missing hashed assets fall through to SPA HTML", () => {
    expect(source).toContain('app.use("/assets"');
    expect(source).toContain('status(404)');
    expect(source).toContain('"Content-Type": "text/plain; charset=utf-8"');
    expect(source).toContain('"Cache-Control": "no-store, max-age=0"');
  });

  it("serves hashed assets immutable and SPA HTML non-cacheable", () => {
    expect(source).toContain('immutable: true');
    expect(source).toContain('maxAge: "1y"');
    expect(source).toContain('"public, max-age=31536000, immutable"');
    expect(source).toContain('index: false');
    expect(source).toContain('"no-store, max-age=0, must-revalidate"');
  });
});
