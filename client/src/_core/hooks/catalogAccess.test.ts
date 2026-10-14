import { describe, expect, it } from "vitest";
import { resolveCatalogFetchState } from "./catalogAccess";

describe("resolveCatalogFetchState", () => {
  it("lets an author and an admin load self-scoped catalog data", () => {
    expect(resolveCatalogFetchState({ loading: false, user: { role: "author" } })).toBe("allowed");
    expect(resolveCatalogFetchState({ loading: false, user: { role: "admin" } })).toBe("allowed");
  });

  it("keeps a reader, a signed-out visitor, and a loading session from fetching", () => {
    expect(resolveCatalogFetchState({ loading: false, user: { role: "user" } })).toBe("forbidden");
    expect(resolveCatalogFetchState({ loading: false, user: null })).toBe("unauthenticated");
    expect(resolveCatalogFetchState({ loading: true, user: { role: "author" } })).toBe("loading");
  });

  it("keeps a failed auth lookup from fetching when no user is present, and still allows a known author", () => {
    const error = new Error("auth.me failed");
    expect(resolveCatalogFetchState({ loading: false, user: null, authMeError: error })).toBe("error");
    expect(resolveCatalogFetchState({ loading: false, user: { role: "author" }, authMeError: error })).toBe("allowed");
  });
});
