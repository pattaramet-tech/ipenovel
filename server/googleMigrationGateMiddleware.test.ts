import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import * as db from "./db";
import { ENV } from "./_core/env";
import type { TrpcContext } from "./_core/context";

// Integration-style coverage of the mandatory Google-migration gate wired
// centrally into server/_core/trpc.ts's protectedProcedure (see
// server/_core/googleMigrationGate.test.ts for the pure
// isBlockedByGoogleMigrationGate unit tests this exercises end to end
// through real router procedures, via appRouter.createCaller - the same
// pattern server/auth.logout.test.ts and server/authGoogleConnected.test.ts
// already use).

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function userContext(overrides: Partial<AuthenticatedUser> = {}): TrpcContext {
  const user: AuthenticatedUser = {
    id: 55,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function adminContext(): TrpcContext {
  return userContext({ id: 1, openId: "admin-1", role: "admin" });
}

describe("mandatory Google-migration gate - end-to-end through real router procedures", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
    vi.restoreAllMocks();
  });

  describe("gate flag OFF (manus/google mode, or transition without the flag)", () => {
    it("manus mode -> a protectedProcedure query works normally, no googleConnected lookup at all", async () => {
      ENV.authProvider = "manus";
      ENV.requireGoogleConnection = false;
      vi.spyOn(db, "getOrCreateCart").mockResolvedValue({ id: 10, userId: 55 } as any);
      vi.spyOn(db, "getCartItems").mockResolvedValue([]);
      const identitySpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

      const caller = appRouter.createCaller(userContext());
      const result = await caller.cart.get();

      expect(result.items).toEqual([]);
      expect(identitySpy).not.toHaveBeenCalled();
    });

    it("transition mode but flag off -> a protectedProcedure mutation is not blocked", async () => {
      ENV.authProvider = "transition";
      ENV.requireGoogleConnection = false;
      vi.spyOn(db, "getOrCreateCart").mockResolvedValue({ id: 10, userId: 55 } as any);
      vi.spyOn(db, "clearCart").mockResolvedValue(undefined as any);

      const caller = appRouter.createCaller(userContext());
      const result = await caller.cart.clear();

      expect(result).toEqual({ success: true });
    });
  });

  describe("gate ACTIVE (transition + AUTH_REQUIRE_GOOGLE_CONNECTION=true), user NOT connected", () => {
    function activateGate() {
      ENV.authProvider = "transition";
      ENV.requireGoogleConnection = true;
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    }

    it("a protectedProcedure QUERY (cart.get) is blocked with FORBIDDEN, cause.code GOOGLE_CONNECTION_REQUIRED, and never touches the cart tables at all", async () => {
      activateGate();
      const cartSpy = vi.spyOn(db, "getOrCreateCart");

      const caller = appRouter.createCaller(userContext());
      const error = await caller.cart.get().catch((e) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("FORBIDDEN");
      expect((error as any).cause?.code).toBe("GOOGLE_CONNECTION_REQUIRED");
      expect(cartSpy).not.toHaveBeenCalled();
    });

    it("a protectedProcedure MUTATION (cart.clear) is blocked with FORBIDDEN, cause.code GOOGLE_CONNECTION_REQUIRED, and never touches the cart tables at all", async () => {
      activateGate();
      const cartSpy = vi.spyOn(db, "getOrCreateCart");

      const caller = appRouter.createCaller(userContext());
      const error = await caller.cart.clear().catch((e) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("FORBIDDEN");
      expect((error as any).cause?.code).toBe("GOOGLE_CONNECTION_REQUIRED");
      expect(cartSpy).not.toHaveBeenCalled();
    });

    it("the error never reveals the user's id, email, or any Google identity detail", async () => {
      activateGate();
      const caller = appRouter.createCaller(userContext({ id: 55, email: "sample@example.com" }));
      const error = await caller.cart.get().catch((e) => e);

      const serialized = JSON.stringify({ message: (error as TRPCError).message, cause: (error as any).cause });
      expect(serialized).not.toContain("55");
      expect(serialized).not.toContain("sample@example.com");
    });

    it("auth.googleConnected itself is NEVER blocked - it is the exact query the gate depends on, gating it would be a deadlock", async () => {
      activateGate();
      const caller = appRouter.createCaller(userContext());
      const result = await caller.auth.googleConnected();

      expect(result).toEqual({ googleConnected: false });
    });

    it("auth.logout is NEVER blocked (publicProcedure, outside the gate entirely)", async () => {
      activateGate();
      const caller = appRouter.createCaller(userContext());
      const result = await caller.auth.logout();

      expect(result).toEqual({ success: true });
    });

    it("an admin procedure (admin.dashboard.summary) is NEVER blocked, even though the calling admin user has no Google identity connected", async () => {
      activateGate();
      vi.spyOn(db, "getDashboardSummary").mockResolvedValue({ totalUsers: 1 } as any);
      const identitySpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

      const caller = appRouter.createCaller(adminContext());
      const result = await caller.admin.dashboard.summary();

      expect(result).toEqual({ totalUsers: 1 });
      // The admin procedure never even asks the gate the question - it's
      // built on authenticatedProcedure, not protectedProcedure.
      expect(identitySpy).not.toHaveBeenCalled();
    });

    it("an admin calling an ORDINARY protectedProcedure QUERY (cart.get - not an admin-only procedure) is NEVER blocked either, even with no Google identity connected - the bug this fix closes", async () => {
      activateGate();
      vi.spyOn(db, "getOrCreateCart").mockResolvedValue({ id: 10, userId: 1 } as any);
      vi.spyOn(db, "getCartItems").mockResolvedValue([]);
      const identitySpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

      const caller = appRouter.createCaller(adminContext());
      const result = await caller.cart.get();

      expect(result.items).toEqual([]);
      // Unlike admin.dashboard.summary above (an admin-only procedure that
      // never reaches requireGoogleMigrationComplete at all), cart.get IS
      // a genuine protectedProcedure - this is the actual regression
      // proof: requireGoogleMigrationComplete's own admin bypass
      // short-circuits before isBlockedByGoogleMigrationGate is ever
      // called, for THIS admin user on THIS ordinary endpoint.
      expect(identitySpy).not.toHaveBeenCalled();
    });

    it("an admin calling an ORDINARY protectedProcedure MUTATION (cart.clear) is NEVER blocked either", async () => {
      activateGate();
      vi.spyOn(db, "getOrCreateCart").mockResolvedValue({ id: 10, userId: 1 } as any);
      vi.spyOn(db, "clearCart").mockResolvedValue(undefined as any);
      const identitySpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

      const caller = appRouter.createCaller(adminContext());
      const result = await caller.cart.clear();

      expect(result).toEqual({ success: true });
      expect(identitySpy).not.toHaveBeenCalled();
    });
  });

  describe("gate ACTIVE, user IS connected", () => {
    it("a protectedProcedure query/mutation both work normally", async () => {
      ENV.authProvider = "transition";
      ENV.requireGoogleConnection = true;
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
        id: 1,
        userId: 55,
        provider: "google",
        providerSubject: "sub-abc",
      } as any);
      vi.spyOn(db, "getOrCreateCart").mockResolvedValue({ id: 10, userId: 55 } as any);
      vi.spyOn(db, "getCartItems").mockResolvedValue([]);
      vi.spyOn(db, "clearCart").mockResolvedValue(undefined as any);

      const caller = appRouter.createCaller(userContext());
      const getResult = await caller.cart.get();
      const clearResult = await caller.cart.clear();

      expect(getResult.items).toEqual([]);
      expect(clearResult).toEqual({ success: true });
    });
  });
});
