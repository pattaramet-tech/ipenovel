import { describe, expect, it } from "vitest";
import { AnonymousCredentialError, isAnonymousCredentialError } from "./authErrors";

describe("AnonymousCredentialError / isAnonymousCredentialError", () => {
  it("recognizes an AnonymousCredentialError instance", () => {
    expect(isAnonymousCredentialError(new AnonymousCredentialError("no cookie", "no_cookie"))).toBe(true);
  });

  it("does not recognize a plain Error (e.g. a database/infrastructure failure) as anonymous", () => {
    expect(isAnonymousCredentialError(new Error("connection refused"))).toBe(false);
  });

  it("does not recognize non-error values as anonymous", () => {
    expect(isAnonymousCredentialError(null)).toBe(false);
    expect(isAnonymousCredentialError(undefined)).toBe(false);
    expect(isAnonymousCredentialError("no cookie")).toBe(false);
    expect(isAnonymousCredentialError({ message: "no cookie" })).toBe(false);
  });

  it("carries the given message, reason, and a distinct name", () => {
    const error = new AnonymousCredentialError("wrong appId", "invalid_session_token");
    expect(error.message).toBe("wrong appId");
    expect(error.name).toBe("AnonymousCredentialError");
    expect(error.reason).toBe("invalid_session_token");
  });

  it.each(["no_cookie", "invalid_session_token", "no_user_record", "admin_session_invalid"] as const)(
    "accepts reason %s",
    reason => {
      expect(new AnonymousCredentialError("x", reason).reason).toBe(reason);
    }
  );
});
