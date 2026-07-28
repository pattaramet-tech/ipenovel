import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type CookieCall = { name: string; value: string; options: Record<string, unknown> };

function anonymousContext(): { ctx: TrpcContext; setCookies: CookieCall[] } {
  const setCookies: CookieCall[] = [];
  const ctx: TrpcContext = {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        setCookies.push({ name, value, options });
      },
    } as TrpcContext["res"],
  };
  return { ctx, setCookies };
}

describe("admin.login - database unavailable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not respond 'Invalid credentials', does not create a session, and does not set a cookie", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(
      new Error("[Database] Database connection is not available")
    );
    const getAdminByEmailSpy = vi.spyOn(db, "getAdminByEmail");

    const { ctx, setCookies } = anonymousContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.admin.login({ email: "admin@example.invalid", password: "whatever" })
    ).rejects.not.toMatchObject({ message: "Invalid credentials" });

    expect(getAdminByEmailSpy).not.toHaveBeenCalled();
    expect(setCookies).toHaveLength(0);
  });

  it("proceeds to the credential check when the database IS available - the guard changes nothing on the happy/normal-rejection path", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const getAdminByEmailSpy = vi.spyOn(db, "getAdminByEmail").mockResolvedValue(undefined);

    const { ctx, setCookies } = anonymousContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.admin.login({ email: "admin@example.invalid", password: "whatever" })
    ).rejects.toMatchObject({ message: "Invalid credentials" });

    expect(getAdminByEmailSpy).toHaveBeenCalledTimes(1);
    expect(setCookies).toHaveLength(0);
  });
});
