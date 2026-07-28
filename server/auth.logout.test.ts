import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

type CookieCall = {
  name: string;
  options: Record<string, unknown>;
};

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

function anonymousContext(cookieHeader?: string): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];
  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: cookieHeader !== undefined ? { cookie: cookieHeader } : {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };
  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });

  it("works when ctx.user is null (already-anonymous caller) - logout never requires an authenticated session", async () => {
    const { ctx, clearedCookies } = anonymousContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
  });

  it("can be called twice in a row - each call clears the cookie again and succeeds (idempotent)", async () => {
    const { ctx, clearedCookies } = anonymousContext();
    const caller = appRouter.createCaller(ctx);

    const first = await caller.auth.logout();
    const second = await caller.auth.logout();

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(2);
    expect(clearedCookies[0]?.options).toEqual(clearedCookies[1]?.options);
  });

  it("succeeds with no cookie header at all", async () => {
    const { ctx, clearedCookies } = anonymousContext(undefined);
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
  });

  it("succeeds with a malformed/garbage cookie header - logout never parses or verifies the session cookie, only clears it", async () => {
    const { ctx, clearedCookies } = anonymousContext(`${COOKIE_NAME}=not-a-real-jwt-at-all`);
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
  });

  it("always clears with the same cookie options (name/path/secure/sameSite/httpOnly/maxAge), regardless of whether a cookie was present", async () => {
    const withCookie = anonymousContext(`${COOKIE_NAME}=garbage`);
    const withoutCookie = anonymousContext(undefined);

    await appRouter.createCaller(withCookie.ctx).auth.logout();
    await appRouter.createCaller(withoutCookie.ctx).auth.logout();

    expect(withCookie.clearedCookies[0]?.options).toEqual(withoutCookie.clearedCookies[0]?.options);
  });
});
