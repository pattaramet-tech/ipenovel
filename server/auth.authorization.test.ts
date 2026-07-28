import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

function anonymousContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function userContext(overrides: Partial<NonNullable<TrpcContext["user"]>> = {}): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "regular-user",
      email: "user@example.invalid",
      name: "Regular User",
      loginMethod: "google",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      ...overrides,
    } as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function adminContext(): TrpcContext {
  return userContext({ id: 2, openId: "admin-user", role: "admin" });
}

describe("protectedProcedure", () => {
  it("rejects an anonymous (unauthenticated) caller with UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    await expect(caller.points.balance()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows an authenticated regular user through the auth gate", async () => {
    // db.getUserPointsBalance runs after the auth gate - whatever it does
    // (this sandbox has no live database, so it gracefully resolves with a
    // default balance), it must never be the UNAUTHORIZED the anonymous
    // case gets; that specifically would mean the auth gate itself failed.
    const caller = appRouter.createCaller(userContext());
    try {
      await caller.points.balance();
    } catch (error) {
      expect(error).not.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});

describe("adminProcedure", () => {
  it("rejects an anonymous caller (adminProcedure is built on protectedProcedure, so an anonymous caller is rejected by the auth gate first, as UNAUTHORIZED, before the role check ever runs)", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    await expect(caller.admin.settings.getCheckoutMaintenance()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a regular (role: user) authenticated caller", async () => {
    const caller = appRouter.createCaller(userContext());
    await expect(caller.admin.settings.getCheckoutMaintenance()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a client-supplied role of 'admin' on the input has no effect - only ctx.user.role (sourced from the database) is checked", async () => {
    // updateCheckoutMaintenance's input schema has no `role` field at all,
    // so this also proves there is no way for a request body to smuggle a
    // role in; the only lever a compromised client has is ctx.user, which
    // in production is populated exclusively by a fresh database lookup in
    // sdk.authenticateRequest, never by anything the client sent.
    const caller = appRouter.createCaller(userContext());
    await expect(
      caller.admin.settings.updateCheckoutMaintenance({
        enabled: true,
        scope: "all_checkout",
        severity: "error",
        title: "Maintenance",
        message: "Try again later",
        // @ts-expect-error - role is not part of this input's schema; this
        // line exists to prove a stray extra field can't escalate privilege.
        role: "admin",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a caller whose ctx.user.role is admin through the auth gate", async () => {
    const caller = appRouter.createCaller(adminContext());
    // Reaching past the auth gate at all (any resolution, or a non-FORBIDDEN
    // rejection from the resolver body hitting the unavailable test
    // database) proves role: admin is what let it through.
    await expect(caller.admin.settings.getCheckoutMaintenance()).resolves.toBeDefined();
  });
});
