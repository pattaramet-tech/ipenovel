import { describe, it, expect } from "vitest";
import {
  classifyStaticFile,
  resolveStaticCacheControl,
  IMMUTABLE_HASHED_ASSET_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  SHORT_CACHE_PUBLIC_FILE_CACHE_CONTROL,
} from "./staticCachePolicy";

describe("classifyStaticFile", () => {
  it("classifies a hashed JS asset under assets/ as immutable-hashed-asset", () => {
    expect(classifyStaticFile("assets/index-gv3Lrxwc.js")).toBe("immutable-hashed-asset");
  });

  it("classifies a hashed CSS asset under assets/ as immutable-hashed-asset", () => {
    expect(classifyStaticFile("assets/index-7JsRjUPM.css")).toBe("immutable-hashed-asset");
  });

  it("classifies a Windows-style absolute path under assets\\ as immutable-hashed-asset", () => {
    expect(classifyStaticFile("C:\\repo\\dist\\public\\assets\\ReaderPage-DQIOOdAY.js")).toBe(
      "immutable-hashed-asset"
    );
  });

  it("classifies index.html as html", () => {
    expect(classifyStaticFile("dist/public/index.html")).toBe("html");
  });

  it("classifies index.html on a Windows-style path as html", () => {
    expect(classifyStaticFile("C:\\repo\\dist\\public\\index.html")).toBe("html");
  });

  it("classifies a public file with no hash as short-cache-public-file", () => {
    expect(classifyStaticFile("favicon.ico")).toBe("short-cache-public-file");
    expect(classifyStaticFile("robots.txt")).toBe("short-cache-public-file");
  });

  it("does not misclassify a path that merely CONTAINS the word 'assets' but isn't under an assets/ directory", () => {
    expect(classifyStaticFile("my-assets-backup/index.js")).toBe("short-cache-public-file");
    expect(classifyStaticFile("foo/assetsxyz/bar.js")).toBe("short-cache-public-file");
    expect(classifyStaticFile("assets-old/legacy.js")).toBe("short-cache-public-file");
  });

  it("still recognizes a real assets/ directory nested deeper in the path", () => {
    expect(classifyStaticFile("public/nested/assets/chunk-abc123.js")).toBe("immutable-hashed-asset");
  });
});

describe("resolveStaticCacheControl", () => {
  it("returns the immutable long-cache header for a hashed asset", () => {
    expect(resolveStaticCacheControl("assets/index-gv3Lrxwc.js")).toBe(IMMUTABLE_HASHED_ASSET_CACHE_CONTROL);
  });

  it("returns the no-cache/must-revalidate header for HTML", () => {
    expect(resolveStaticCacheControl("index.html")).toBe(HTML_CACHE_CONTROL);
  });

  it("returns the short-cache header for an unhashed public file", () => {
    expect(resolveStaticCacheControl("favicon.ico")).toBe(SHORT_CACHE_PUBLIC_FILE_CACHE_CONTROL);
  });
});
