import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";

/**
 * R4/IR-03 — logout reports durable-revoke outcome TRUTHFULLY: an injected
 * registry write failure must surface as durableRevocation "unconfirmed"
 * (with the cookie STILL cleared — the browser logout itself never fails),
 * never as silent success. No secrets in the response.
 */

const revokeByTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./services/sessionRegistry", () => ({
  revokeByToken: revokeByTokenMock,
}));

function logoutCaller(cookie?: string) {
  const cleared: Array<{ name: string }> = [];
  const res = { clearCookie: (name: string) => cleared.push({ name }) };
  const caller = appRouter.createCaller({
    user: null,
    authSession: null,
    authSessionExpiresAt: null,
    req: { protocol: "https", headers: cookie ? { cookie } : {} },
    res,
  } as any);
  return { caller, cleared };
}

beforeEach(() => {
  revokeByTokenMock.mockReset();
});

describe("R4/IR-03 — logout durable-revoke reporting (injected registry failure)", () => {
  it("registry write SUCCEEDS → durableRevocation 'revoked', cookie cleared", async () => {
    revokeByTokenMock.mockResolvedValue("revoked");
    const { caller, cleared } = logoutCaller("app_session_id=some-token");
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "revoked" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
    expect(revokeByTokenMock).toHaveBeenCalledWith("some-token");
  });

  it("registry write THROWS (db down) → durableRevocation 'unconfirmed', cookie STILL cleared, success shape kept", async () => {
    revokeByTokenMock.mockRejectedValue(new Error("ER_CONN_LOST (redacted driver summary)"));
    const { caller, cleared } = logoutCaller("app_session_id=some-token");
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "unconfirmed" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
  });

  it("registry unreachable (explicit 'unavailable') → durableRevocation 'unconfirmed'", async () => {
    revokeByTokenMock.mockResolvedValue("unavailable");
    const { caller } = logoutCaller("app_session_id=some-token");
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "unconfirmed" });
  });

  it("no durable registry row for this cookie → durableRevocation 'not_found', cookie cleared", async () => {
    revokeByTokenMock.mockResolvedValue("not_found");
    const { caller, cleared } = logoutCaller("app_session_id=legacy-or-unknown");
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "not_found" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
  });

  it("no cookie at all → durableRevocation 'not_found' (nothing to revoke), cookie cleared", async () => {
    const { caller, cleared } = logoutCaller(undefined);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true, durableRevocation: "not_found" });
    expect(cleared).toEqual([{ name: "app_session_id" }]);
    expect(revokeByTokenMock).not.toHaveBeenCalled();
  });

  it("response never echoes the raw error/token (no secrets)", async () => {
    revokeByTokenMock.mockRejectedValue(new Error("mysql password secret-here"));
    const { caller } = logoutCaller("app_session_id=super-secret-token");
    const result = await caller.auth.logout();
    expect(JSON.stringify(result)).not.toContain("secret-here");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });
});
