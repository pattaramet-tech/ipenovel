import { describe, expect, it, vi } from "vitest";

import {
  buildProductionDispatchPayload,
  dispatchProductionDeployed,
  resolveProductionDispatchConfig,
} from "../scripts/production-post-deploy-dispatch.mjs";

const SHA = "25DE878AFC01A004B1262340502721C2D2AF4564";
const TOKEN = "test-token-never-log";

function env(overrides: Record<string, string> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: "production",
    SOURCE_COMMIT: SHA,
    GITHUB_PRODUCTION_DISPATCH_TOKEN: TOKEN,
    ...overrides,
  };
}

describe("M24 Production post-deploy dispatch", () => {
  it("builds the exact production-deployed payload from SOURCE_COMMIT", () => {
    expect(buildProductionDispatchPayload(SHA)).toEqual({
      event_type: "production-deployed",
      client_payload: {
        deployed_sha: SHA.toLowerCase(),
        environment: "production",
      },
    });
  });

  it("fails closed for a non-production runtime", () => {
    expect(() =>
      resolveProductionDispatchConfig(
        env({ DEPLOYMENT_ENVIRONMENT: "production-staging" })
      )
    ).toThrow(/must exactly equal production/);
  });

  it("fails closed for a missing or invalid deployed SHA", () => {
    expect(() =>
      resolveProductionDispatchConfig(env({ SOURCE_COMMIT: "" }))
    ).toThrow(/Missing SOURCE_COMMIT/);
    expect(() =>
      resolveProductionDispatchConfig(env({ SOURCE_COMMIT: "25de878" }))
    ).toThrow(/full 40-character Git SHA/);
  });

  it("fails closed when the runtime dispatch token is missing", () => {
    expect(() =>
      resolveProductionDispatchConfig(
        env({ GITHUB_PRODUCTION_DISPATCH_TOKEN: "" })
      )
    ).toThrow(/Missing GITHUB_PRODUCTION_DISPATCH_TOKEN/);
  });

  it("posts only to the fixed repository dispatch endpoint without logging the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const logs: string[] = [];
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), init: init || {} });
        return new Response(null, { status: 204 });
      }
    );

    const result = await dispatchProductionDeployed({
      env: env(),
      fetchImpl,
      logger: {
        log: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: (...args: unknown[]) => logs.push(args.join(" ")),
      },
      sleepImpl: async () => {},
    });

    expect(result).toMatchObject({
      ok: true,
      status: 204,
      deployedSha: SHA.toLowerCase(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/pattaramet-tech/ipenovel/dispatches"
    );
    expect(calls[0]?.init.method).toBe("POST");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      event_type: "production-deployed",
      client_payload: {
        deployed_sha: SHA.toLowerCase(),
        environment: "production",
      },
    });
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("retries transient GitHub failures but does not retry authentication failure", async () => {
    const retryingFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      dispatchProductionDeployed({
        env: env(),
        fetchImpl: retryingFetch,
        logger: { log: vi.fn(), warn: vi.fn() },
        sleepImpl: async () => {},
      })
    ).resolves.toMatchObject({ ok: true, status: 204 });
    expect(retryingFetch).toHaveBeenCalledTimes(2);

    const authFetch = vi.fn(
      async () => new Response("bad credentials", { status: 401 })
    );
    await expect(
      dispatchProductionDeployed({
        env: env(),
        fetchImpl: authFetch,
        logger: { log: vi.fn(), warn: vi.fn() },
        sleepImpl: async () => {},
      })
    ).rejects.toThrow(/HTTP 401/);
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
