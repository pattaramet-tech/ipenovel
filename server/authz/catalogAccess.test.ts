import { describe, expect, it } from "vitest";
import { decideCatalogNovelAccess } from "./catalogAccess";

describe("catalog novel access", () => {
  it("lets an admin open a legacy novel with no owner", () => {
    expect(decideCatalogNovelAccess({ id: 1, role: "admin" }, { authorUserId: null })).toBe("allow");
  });

  it("lets an author open only the novel stored under their user id", () => {
    expect(decideCatalogNovelAccess({ id: 7, role: "author" }, { authorUserId: 7 })).toBe("allow");
  });

  it("hides another author's novel and a legacy null-owned novel from an author", () => {
    expect(decideCatalogNovelAccess({ id: 7, role: "author" }, { authorUserId: 8 })).toBe("not_found");
    expect(decideCatalogNovelAccess({ id: 7, role: "author" }, { authorUserId: null })).toBe("not_found");
    expect(decideCatalogNovelAccess({ id: 7, role: "author" }, null)).toBe("not_found");
  });

  it("refuses a reader and a missing actor", () => {
    expect(decideCatalogNovelAccess({ id: 3, role: "user" }, { authorUserId: 3 })).toBe("forbidden");
    expect(decideCatalogNovelAccess(null, { authorUserId: 3 })).toBe("forbidden");
  });
});
