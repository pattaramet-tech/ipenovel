import { describe, it, expect, vi } from "vitest";
import { escapeXml, formatLastmod, buildSitemapXml, handleSitemapXml } from "./sitemap";

describe("escapeXml", () => {
  it("escapes all 5 XML special characters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("https://ipenovel.com/novels/57")).toBe("https://ipenovel.com/novels/57");
  });
});

describe("formatLastmod", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(formatLastmod(new Date("2026-07-19T12:34:56Z"))).toBe("2026-07-19");
  });

  it("formats a date string the same way", () => {
    expect(formatLastmod("2026-01-05T00:00:00Z")).toBe("2026-01-05");
  });

  it("returns undefined for null/undefined/invalid input, never throws", () => {
    expect(formatLastmod(null)).toBeUndefined();
    expect(formatLastmod(undefined)).toBeUndefined();
    expect(formatLastmod("not a date")).toBeUndefined();
  });
});

describe("buildSitemapXml", () => {
  it("produces a valid urlset with escaped locs and optional fields", () => {
    const xml = buildSitemapXml([
      { loc: "https://ipenovel.com/", changefreq: "daily", priority: "1.0" },
      { loc: "https://ipenovel.com/novels/1?x=1&y=2", lastmod: "2026-07-19" },
    ]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://ipenovel.com/</loc>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("<loc>https://ipenovel.com/novels/1?x=1&amp;y=2</loc>");
    expect(xml).toContain("<lastmod>2026-07-19</lastmod>");
    expect(xml.trim().endsWith("</urlset>")).toBe(true);
  });

  it("omits optional tags entirely when not provided (no empty <lastmod/>)", () => {
    const xml = buildSitemapXml([{ loc: "https://ipenovel.com/novels" }]);
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });
});

function makeRes() {
  return {
    _status: 0,
    _body: "",
    _contentType: "",
    set(name: string, value: string) {
      if (name.toLowerCase() === "content-type") this._contentType = value;
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    send(body: string) {
      this._body = body;
      return this;
    },
  } as any;
}

describe("handleSitemapXml", () => {
  it("always includes the homepage and /novels static URLs, with correct content-type", async () => {
    const res = makeRes();
    await handleSitemapXml({} as any, res);

    expect(res._contentType).toContain("application/xml");
    expect(res._status).toBe(200);
    expect(res._body).toContain("<loc>https://ipenovel.com/</loc>");
    expect(res._body).toContain("<loc>https://ipenovel.com/novels</loc>");
    // Never a legacy/alias domain in sitemap URLs.
    expect(res._body).not.toContain("manus.space");
  });

  it("never crashes the request even if the DB lookup throws", async () => {
    vi.doMock("../db", () => ({
      getPublishedNovelsForSitemap: () => {
        throw new Error("boom");
      },
    }));
    vi.resetModules();
    const { handleSitemapXml: handleWithBrokenDb } = await import("./sitemap");

    const res = makeRes();
    await expect(handleWithBrokenDb({} as any, res)).resolves.not.toThrow();
    expect(res._status).toBe(200);
    expect(res._body).toContain("<loc>https://ipenovel.com/</loc>");

    vi.doUnmock("../db");
    vi.resetModules();
  });
});
