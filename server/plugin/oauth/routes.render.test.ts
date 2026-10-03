import { describe, expect, it } from "vitest";
import { escapePluginHtml, toPluginOAuthErrorResponse, pluginOAuthError } from "../errors";
import { buildPluginAuthorizationServerMetadata, renderPluginConsentPage } from "./routes";

describe("renderPluginConsentPage", () => {
  const base = {
    clientName: "ChatGPT Connector",
    scopes: ["identity:read"] as const,
    state: "0123456789abcdefghijklmnop",
    csrfToken: "csrf-token-value",
  };

  it("renders hidden fields and the escaped client name", () => {
    const html = renderPluginConsentPage(base);
    expect(html).toContain('name="state" value="0123456789abcdefghijklmnop"');
    expect(html).toContain('name="csrfToken" value="csrf-token-value"');
    expect(html).toContain("ChatGPT Connector");
    expect(html).toContain("identity:read");
    expect(html).toContain('action="/api/plugin/oauth/authorize/consent"');
  });

  it("HTML-escapes hostile client names (no XSS through client registration)", () => {
    const html = renderPluginConsentPage({
      ...base,
      clientName: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;xss&quot;");
  });
});

describe("escapePluginHtml", () => {
  it("escapes the full dangerous set", () => {
    expect(escapePluginHtml(`<&>"'&`)).toBe("&lt;&amp;&gt;&quot;&#39;&amp;");
  });
});

describe("toPluginOAuthErrorResponse", () => {
  it("maps known PluginOAuthErrors to their fixed code/status", () => {
    const mapped = toPluginOAuthErrorResponse(pluginOAuthError("invalid_grant"));
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toBe("invalid_grant");
    expect(mapped.body.error_description).toBe(
      "The provided authorization grant or credentials are invalid, expired, or revoked."
    );
  });

  it("collapses unknown errors to a fixed server_error (never echoing internals)", () => {
    const mapped = toPluginOAuthErrorResponse(new Error("ER_ACCESS_DENIED: host 10.0.0.1 not allowed - this is a secret"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error).toBe("server_error");
    expect(JSON.stringify(mapped.body)).not.toContain("ER_ACCESS_DENIED");
    expect(JSON.stringify(mapped.body)).not.toContain("10.0.0.1");
  });
});

describe("buildPluginAuthorizationServerMetadata", () => {
  it("builds absolute URLs from the configured base only", () => {
    const metadata = buildPluginAuthorizationServerMetadata("https://ipenovel.com") as Record<string, unknown>;
    expect(metadata.issuer).toBe("https://ipenovel.com");
    expect(metadata.scopes_supported).toEqual(["identity:read"]);
    expect(JSON.stringify(metadata)).not.toContain("undefined");
  });
});
