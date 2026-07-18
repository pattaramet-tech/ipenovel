import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Safety-net for the canonical domain redirect middleware. Locks in:
 * - legacy host (old Manus subdomain) -> canonical host, 301, path+query preserved
 * - only GET/HEAD ever redirect - POST/PUT/PATCH/DELETE always fall through
 * - localhost/127.0.0.1/*.local are never redirected (local dev safety)
 * - the canonical host itself never redirects (no loop)
 * - LEGACY_REDIRECT_HOSTS/CANONICAL_HOST env overrides are respected
 */

function makeReq(overrides: { host?: string; method?: string; originalUrl?: string; url?: string }) {
  return {
    headers: { host: overrides.host },
    method: overrides.method ?? "GET",
    originalUrl: overrides.originalUrl,
    url: overrides.url,
  } as any;
}

function makeRes() {
  return { redirect: vi.fn() } as any;
}

const ORIGINAL_ENV = { ...process.env };

async function loadMiddleware(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import("./canonicalDomainRedirect");
  return mod.canonicalDomainRedirect;
}

describe("canonicalDomainRedirect - default env (CANONICAL_HOST/LEGACY_REDIRECT_HOSTS unset)", () => {
  let middleware: any;

  beforeEach(async () => {
    middleware = await loadMiddleware({ CANONICAL_HOST: undefined, LEGACY_REDIRECT_HOSTS: undefined });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("redirects the legacy Manus host root path to the canonical domain", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", originalUrl: "/" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/");
    expect(next).not.toHaveBeenCalled();
  });

  it("preserves a deep path", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", originalUrl: "/novels/57" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/novels/57");
  });

  it("preserves path and query string together", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", originalUrl: "/novels?sort=popular" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/novels?sort=popular");
  });

  it("preserves a reader deep link", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", originalUrl: "/reader/12345" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/reader/12345");
  });

  it("redirects HEAD the same as GET", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", method: "HEAD", originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/novels");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "never redirects a %s request, even on the legacy host",
    (method) => {
      const req = makeReq({ host: "ipenovelz.manus.space", method, originalUrl: "/api/trpc/cart.add" });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.redirect).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    }
  );

  it("never redirects a POST to /api/trpc specifically", () => {
    const req = makeReq({ host: "ipenovelz.manus.space", method: "POST", originalUrl: "/api/trpc/orders.checkout" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(["localhost", "127.0.0.1", "foo.local"])("never redirects %s even if it were on the legacy list", (host) => {
    const req = makeReq({ host, originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not redirect (and does not loop) when already on the canonical host", () => {
    const req = makeReq({ host: "ipenovel.com", originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not redirect an unrelated/unknown host", () => {
    const req = makeReq({ host: "some-other-site.example.com", originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("strips the port from the Host header before comparing", () => {
    const req = makeReq({ host: "ipenovelz.manus.space:443", originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "https://ipenovel.com/novels");
  });

  it("does not redirect www.ipenovel.com by default (not in the default legacy list)", () => {
    const req = makeReq({ host: "www.ipenovel.com", originalUrl: "/novels" });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("canonicalDomainRedirect - custom CANONICAL_HOST/LEGACY_REDIRECT_HOSTS env", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("redirects every host in a custom comma-separated LEGACY_REDIRECT_HOSTS list, including www once added", async () => {
    const middleware = await loadMiddleware({
      CANONICAL_HOST: "example.com",
      LEGACY_REDIRECT_HOSTS: "old-manus-host.manus.space, www.example.com ",
    });

    const legacyReq = makeReq({ host: "old-manus-host.manus.space", originalUrl: "/novels/1" });
    const legacyRes = makeRes();
    middleware(legacyReq, legacyRes, vi.fn());
    expect(legacyRes.redirect).toHaveBeenCalledWith(301, "https://example.com/novels/1");

    const wwwReq = makeReq({ host: "www.example.com", originalUrl: "/novels/1" });
    const wwwRes = makeRes();
    middleware(wwwReq, wwwRes, vi.fn());
    expect(wwwRes.redirect).toHaveBeenCalledWith(301, "https://example.com/novels/1");

    const canonicalReq = makeReq({ host: "example.com", originalUrl: "/novels/1" });
    const canonicalRes = makeRes();
    const canonicalNext = vi.fn();
    middleware(canonicalReq, canonicalRes, canonicalNext);
    expect(canonicalRes.redirect).not.toHaveBeenCalled();
    expect(canonicalNext).toHaveBeenCalledTimes(1);
  });
});
