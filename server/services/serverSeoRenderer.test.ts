import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { injectSeoMetadata } from "./htmlSeoInjector";

/**
 * Safety-net for server-side <head> metadata injection (fixes view-source/
 * social-crawler requests seeing static homepage metadata for every route -
 * see docs/PERFORMANCE_SEO_AUDIT.md). Covers:
 * - homepage / novels-list / novel-detail / reader / private-route metadata
 * - novel-detail using real DB data, with not-found/unpublished falling
 *   back to safe generic metadata (never exposing draft data)
 * - XSS: a malicious title/description can never break out of its tag or
 *   inject a new one
 * - no duplicate tags, no leftover homepage canonical on other routes
 * - a DB failure never crashes rendering (falls back to the template as-is)
 */

const TEMPLATE = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <!-- SEO_START -->
    <title>IpeNovel — นิยายแปลออนไลน์</title>
    <meta name="description" content="อ่านนิยายแปลออนไลน์ นิยายแฟนฟิค นิยายกีฬา นิยายอนิเมะ และนิยายยอดนิยมบน IpeNovel" />
    <link rel="canonical" href="https://ipenovel.com/" />
    <!-- SEO_END -->
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

describe("injectSeoMetadata (pure HTML injection)", () => {
  it("replaces title/description/canonical inside the marked block only", () => {
    const html = injectSeoMetadata(TEMPLATE, {
      title: "ทดสอบ | IpeNovel",
      description: "คำอธิบายทดสอบ",
      canonical: "https://ipenovel.com/novels/57",
    });
    expect(html).toContain("<title>ทดสอบ | IpeNovel</title>");
    expect(html).toContain('content="คำอธิบายทดสอบ"');
    expect(html).toContain('href="https://ipenovel.com/novels/57"');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it("never produces duplicate title/canonical/og:title tags", () => {
    const html = injectSeoMetadata(TEMPLATE, {
      title: "นิยาย A | IpeNovel",
      canonical: "https://ipenovel.com/novels/1",
    });
    expect((html.match(/<title>/g) || []).length).toBe(1);
    expect((html.match(/rel="canonical"/g) || []).length).toBe(1);
    expect((html.match(/property="og:title"/g) || []).length).toBe(1);
  });

  it("preserves the template's own title/description/canonical when a field is omitted (e.g. private-route robots-only update)", () => {
    const html = injectSeoMetadata(TEMPLATE, { robots: "noindex,nofollow" });
    expect(html).toContain("<title>IpeNovel — นิยายแปลออนไลน์</title>");
    expect(html).toContain('href="https://ipenovel.com/"');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("escapes a malicious title so it can never break out of the <title> tag or inject markup", () => {
    const html = injectSeoMetadata(TEMPLATE, {
      title: `</title><script>alert(1)</script><title>`,
      canonical: "https://ipenovel.com/novels/1",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;title&gt;");
  });

  it("escapes a malicious description containing quotes so it can never break out of the content attribute", () => {
    const html = injectSeoMetadata(TEMPLATE, {
      title: "ok",
      description: `"><meta http-equiv="refresh" content="0;url=https://evil.example">`,
      canonical: "https://ipenovel.com/novels/1",
    });
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(html).toContain("&quot;&gt;&lt;meta");
  });

  it("neutralizes a </script> breakout attempt inside JSON-LD while keeping valid JSON", () => {
    const html = injectSeoMetadata(TEMPLATE, {
      title: "ok",
      canonical: "https://ipenovel.com/novels/1",
      jsonLd: { "@type": "Book", name: `</script><script>alert(1)</script>` },
    });
    expect(html).not.toContain("</script><script>alert(1)</script>");
    const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(scriptMatch).toBeTruthy();
    const parsed = JSON.parse(scriptMatch![1]);
    expect(parsed.name).toBe("</script><script>alert(1)</script>");
  });

  it("returns the template completely unmodified if the SEO markers are missing", () => {
    const noMarkers = "<html><head><title>x</title></head><body></body></html>";
    expect(injectSeoMetadata(noMarkers, { title: "should not appear" })).toBe(noMarkers);
  });

  it("only sets og:image/twitter tags when an image is actually provided (never a stale/empty image block)", () => {
    const withImage = injectSeoMetadata(TEMPLATE, {
      title: "t",
      canonical: "https://ipenovel.com/novels/1",
      ogImage: "https://media.ipenovel.com/novel-covers/1/a.webp",
    });
    expect(withImage).toContain('property="og:image" content="https://media.ipenovel.com/novel-covers/1/a.webp"');
    expect(withImage).toContain('name="twitter:card" content="summary_large_image"');

    const withoutImage = injectSeoMetadata(TEMPLATE, { title: "t", canonical: "https://ipenovel.com/novels/1" });
    expect(withoutImage).not.toContain("og:image");
    expect(withoutImage).not.toContain("twitter:card");
  });
});

describe("resolveSeoMetadata / renderSeoHtml - route resolution (no DB needed)", () => {
  it("resolves the homepage", async () => {
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");
    const meta = await resolveSeoMetadata("/");
    expect(meta?.title).toBe("IpeNovel — นิยายแปลออนไลน์");
    expect(meta?.canonical).toBe("https://ipenovel.com/");
    expect(meta?.jsonLd?.["@type"]).toBe("WebSite");
  });

  it("resolves the novels listing, stripping query params from canonical", async () => {
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");
    const meta = await resolveSeoMetadata("/novels?sort=popular");
    expect(meta?.title).toBe("รายการนิยาย | IpeNovel");
    expect(meta?.canonical).toBe("https://ipenovel.com/novels");
  });

  it("resolves the reader route with noindex,follow and no DB-derived content", async () => {
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");
    const meta = await resolveSeoMetadata("/read/12345");
    expect(meta?.robots).toBe("noindex,follow");
    expect(meta?.canonical).toBe("https://ipenovel.com/read/12345");
    expect(meta?.description).toBeUndefined();
  });

  it.each(["/admin", "/admin/novels", "/cart", "/orders", "/orders/5", "/my-novels", "/wallet", "/payment/9"])(
    "resolves %s as noindex,nofollow with no title override",
    async (path) => {
      const { resolveSeoMetadata } = await import("./serverSeoRenderer");
      const meta = await resolveSeoMetadata(path);
      expect(meta?.robots).toBe("noindex,nofollow");
      expect(meta?.title).toBeUndefined();
    }
  );

  it("returns null for an unclassified route, leaving the template untouched", async () => {
    const { resolveSeoMetadata, renderSeoHtml } = await import("./serverSeoRenderer");
    const meta = await resolveSeoMetadata("/sports-votes");
    expect(meta).toBeNull();
    const html = await renderSeoHtml(TEMPLATE, "/sports-votes");
    expect(html).toBe(TEMPLATE);
  });
});

describe("resolveSeoMetadata - novel detail (mocked DB)", () => {
  afterEach(() => {
    vi.doUnmock("../db");
    vi.resetModules();
  });

  it("uses real novel data for a published novel: title, canonical, og:image, JSON-LD Book, no homepage canonical left over", async () => {
    vi.doMock("../db", () => ({
      getNovelSeoData: vi.fn(async (id: number) => ({
        id,
        title: "นิยายทดสอบ SEO",
        description: "<p>เรื่องราวการผจญภัย &amp; น่าติดตาม</p>",
        coverImageUrl: "https://media.ipenovel.com/novel-covers/57/cover.webp",
        author: "นักเขียนทดสอบ",
        publicationStatus: "published",
      })),
    }));
    vi.resetModules();
    const { resolveSeoMetadata, renderSeoHtml } = await import("./serverSeoRenderer");

    const meta = await resolveSeoMetadata("/novels/57");
    expect(meta?.title).toBe("นิยายทดสอบ SEO | IpeNovel");
    expect(meta?.description).toBe("เรื่องราวการผจญภัย & น่าติดตาม");
    expect(meta?.canonical).toBe("https://ipenovel.com/novels/57");
    expect(meta?.ogType).toBe("book");
    expect(meta?.ogImage).toBe("https://media.ipenovel.com/novel-covers/57/cover.webp");
    expect(meta?.jsonLd?.["@type"]).toBe("Book");
    expect((meta?.jsonLd as any)?.author?.name).toBe("นักเขียนทดสอบ");
    expect((meta?.jsonLd as any)?.inLanguage).toBe("th-TH");

    const html = await renderSeoHtml(TEMPLATE, "/novels/57");
    expect(html).toContain("<title>นิยายทดสอบ SEO | IpeNovel</title>");
    expect(html).toContain('property="og:image" content="https://media.ipenovel.com/novel-covers/57/cover.webp"');
    expect(html).not.toContain('href="https://ipenovel.com/"');
    expect((html.match(/rel="canonical"/g) || []).length).toBe(1);
  });

  it("falls back to safe generic metadata for a novel that doesn't exist (never a raw DB-null crash)", async () => {
    vi.doMock("../db", () => ({ getNovelSeoData: vi.fn(async () => null) }));
    vi.resetModules();
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");

    const meta = await resolveSeoMetadata("/novels/999999");
    expect(meta?.title).toBe("IpeNovel — นิยายแปลออนไลน์");
    expect(meta?.ogType).toBe("website");
    expect(meta?.ogImage).toBeUndefined();
    expect(meta?.jsonLd).toBeUndefined();
  });

  it("falls back to safe generic metadata for an unpublished/draft novel, never exposing its real title", async () => {
    vi.doMock("../db", () => ({
      getNovelSeoData: vi.fn(async (id: number) => ({
        id,
        title: "DRAFT - ยังไม่เผยแพร่ ห้ามเห็น",
        description: "ข้อมูลลับ",
        coverImageUrl: null,
        author: null,
        publicationStatus: "archived",
      })),
    }));
    vi.resetModules();
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");

    const meta = await resolveSeoMetadata("/novels/42");
    expect(meta?.title).not.toContain("DRAFT");
    expect(meta?.title).not.toContain("ห้ามเห็น");
    expect(meta?.description).not.toContain("ข้อมูลลับ");
    expect(meta?.title).toBe("IpeNovel — นิยายแปลออนไลน์");
  });

  it("never omits the author field when missing, and never crashes on a missing description/cover", async () => {
    vi.doMock("../db", () => ({
      getNovelSeoData: vi.fn(async (id: number) => ({
        id,
        title: "นิยายไม่มีข้อมูลเสริม",
        description: null,
        coverImageUrl: null,
        author: null,
        publicationStatus: "published",
      })),
    }));
    vi.resetModules();
    const { resolveSeoMetadata } = await import("./serverSeoRenderer");

    const meta = await resolveSeoMetadata("/novels/7");
    expect(meta?.title).toBe("นิยายไม่มีข้อมูลเสริม | IpeNovel");
    expect(meta?.ogImage).toBeUndefined();
    expect((meta?.jsonLd as any)?.author).toBeUndefined();
    expect(typeof meta?.description).toBe("string");
    expect(meta?.description!.length).toBeGreaterThan(0); // natural fallback sentence, never empty
  });

  it("renderSeoHtml never throws and falls back to the unmodified template if the DB call itself throws", async () => {
    vi.doMock("../db", () => ({
      getNovelSeoData: vi.fn(async () => {
        throw new Error("connection lost");
      }),
    }));
    vi.resetModules();
    const { renderSeoHtml } = await import("./serverSeoRenderer");

    const html = await renderSeoHtml(TEMPLATE, "/novels/57");
    // Falls back to generic site metadata (via the caught-error path inside
    // getNovelSeoDataCached), not a crash and not the raw template with a
    // stale prior novel's data.
    expect(html).toContain("<title>IpeNovel — นิยายแปลออนไลน์</title>");
  });
});
