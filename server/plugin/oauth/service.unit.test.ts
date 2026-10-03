import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { resolvePluginFoundationEnabled } from "../../_core/env";
import { extractPluginClientCredentials } from "./service";

describe("resolvePluginFoundationEnabled (exact-literal flag)", () => {
  it("accepts only the exact literal \"true\"", () => {
    expect(resolvePluginFoundationEnabled("true")).toBe(true);
  });

  it("fails closed for every other value including look-alikes", () => {
    for (const raw of [undefined, "", "TRUE", "True", " true", "true ", "1", "yes", "on"]) {
      expect(resolvePluginFoundationEnabled(raw), `raw=${String(raw)}`).toBe(false);
    }
  });
});

describe("extractPluginClientCredentials", () => {
  const makeRequest = (authorization?: string) =>
    ({
      headers: authorization === undefined ? {} : { authorization },
    }) as unknown as Request;

  it("parses HTTP Basic credentials (RFC 6749 §2.3.1)", () => {
    const basic = Buffer.from("plg_client:plg_secret").toString("base64");
    expect(extractPluginClientCredentials(makeRequest(`Basic ${basic}`), undefined, undefined)).toEqual({
      clientId: "plg_client",
      clientSecret: "plg_secret",
    });
  });

  it("supports client_secret_post when no Authorization header is present", () => {
    expect(
      extractPluginClientCredentials(makeRequest(), "plg_client", "plg_secret")
    ).toEqual({ clientId: "plg_client", clientSecret: "plg_secret" });
  });

  it("prefers Basic over body credentials (never mixes)", () => {
    const basic = Buffer.from("plg_basic:basic_secret").toString("base64");
    expect(
      extractPluginClientCredentials(makeRequest(`Basic ${basic}`), "plg_body", "body_secret")
    ).toEqual({ clientId: "plg_basic", clientSecret: "basic_secret" });
  });

  it("fails closed on malformed/missing credentials", () => {
    expect(extractPluginClientCredentials(makeRequest(), undefined, undefined)).toBeNull();
    expect(extractPluginClientCredentials(makeRequest("Basic !!!not-base64!!!"), undefined, undefined)).toBeNull();
    expect(
      extractPluginClientCredentials(makeRequest(`Basic ${Buffer.from("no-separator").toString("base64")}`), undefined, undefined)
    ).toBeNull();
    expect(extractPluginClientCredentials(makeRequest(), "only-id", undefined)).toBeNull();
    expect(extractPluginClientCredentials(makeRequest("Bearer something"), undefined, undefined)).toBeNull();
  });
});
