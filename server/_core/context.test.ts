import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { createContext } from "./context";
import { AnonymousCredentialError } from "./authErrors";
import { sdk } from "./sdk";

function fakeOpts(): CreateExpressContextOptions {
  return {
    req: { headers: {} } as any,
    res: {} as any,
  } as CreateExpressContextOptions;
}

describe("createContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves user: null when authenticateRequest reports an expected anonymous credential error", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new AnonymousCredentialError("no cookie"));

    const ctx = await createContext(fakeOpts());

    expect(ctx.user).toBeNull();
  });

  it("resolves the real user when authenticateRequest succeeds", async () => {
    const user = { id: 1, openId: "user-1", role: "user" } as any;
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue(user);

    const ctx = await createContext(fakeOpts());

    expect(ctx.user).toBe(user);
  });

  it("does NOT resolve to anonymous for a database/infrastructure failure - it rethrows", async () => {
    const infraError = new Error("connection refused");
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(infraError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createContext(fakeOpts())).rejects.toBe(infraError);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does NOT resolve to anonymous for a missing-session-secret configuration error", async () => {
    const configError = new Error("[Auth] JWT_SECRET is not configured - refusing to sign or verify sessions");
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(configError);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createContext(fakeOpts())).rejects.toBe(configError);
  });

  it("never logs the raw error object for an unexpected failure - only a sanitized summary string", async () => {
    const secretLookingMessage = "password=hunter2 token=abcdef1234567890";
    const infraError = new Error(secretLookingMessage);
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(infraError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createContext(fakeOpts())).rejects.toBe(infraError);

    const loggedArgs = errorSpy.mock.calls[0];
    // safeErrorSummary redacts credential-shaped fragments - the raw
    // "password=..."/"token=..." text must never reach the log call as-is.
    expect(JSON.stringify(loggedArgs)).not.toContain("hunter2");
  });
});
