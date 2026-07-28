import { describe, expect, it } from "vitest";
import { AnonymousCredentialError, isAnonymousCredentialError } from "./authErrors";

describe("AnonymousCredentialError / isAnonymousCredentialError", () => {
  it("recognizes an AnonymousCredentialError instance", () => {
    expect(isAnonymousCredentialError(new AnonymousCredentialError("no cookie"))).toBe(true);
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

  it("carries the given message and a distinct name", () => {
    const error = new AnonymousCredentialError("wrong appId");
    expect(error.message).toBe("wrong appId");
    expect(error.name).toBe("AnonymousCredentialError");
  });
});
