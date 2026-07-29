import { describe, expect, it } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { classifyLogoutFailure } from "./logoutOutcome";

function makeUnauthorizedError(): TRPCClientError<any> {
  return new TRPCClientError("Unauthorized", {
    result: { error: { data: { code: "UNAUTHORIZED" } } },
  } as any);
}

function makeForbiddenError(): TRPCClientError<any> {
  return new TRPCClientError("Forbidden", {
    result: { error: { data: { code: "FORBIDDEN" } } },
  } as any);
}

describe("classifyLogoutFailure", () => {
  it("UNAUTHORIZED (no session to clear) -> already_logged_out", () => {
    expect(classifyLogoutFailure(makeUnauthorizedError())).toBe("already_logged_out");
  });

  it("any other tRPC error code (e.g. FORBIDDEN) -> unexpected_error", () => {
    expect(classifyLogoutFailure(makeForbiddenError())).toBe("unexpected_error");
  });

  it("a plain network/Error (not a TRPCClientError) -> unexpected_error", () => {
    expect(classifyLogoutFailure(new Error("Network request failed"))).toBe("unexpected_error");
    expect(classifyLogoutFailure(new TypeError("Failed to fetch"))).toBe("unexpected_error");
  });

  it("a non-Error thrown value -> unexpected_error", () => {
    expect(classifyLogoutFailure("boom")).toBe("unexpected_error");
    expect(classifyLogoutFailure(undefined)).toBe("unexpected_error");
    expect(classifyLogoutFailure(null)).toBe("unexpected_error");
  });

  it("a TRPCClientError with no data.code at all -> unexpected_error", () => {
    const error = new TRPCClientError("Something broke", { result: { error: {} } } as any);
    expect(classifyLogoutFailure(error)).toBe("unexpected_error");
  });
});
