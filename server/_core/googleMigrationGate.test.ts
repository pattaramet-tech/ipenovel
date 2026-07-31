import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { ENV } from "./env";
import { isBlockedByGoogleMigrationGate } from "./googleMigrationGate";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

describe("isBlockedByGoogleMigrationGate", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
    vi.restoreAllMocks();
  });

  it("gate disabled (manus mode) -> false, and never even queries the database", async () => {
    ENV.authProvider = "manus";
    ENV.requireGoogleConnection = true; // deliberately left on - must not matter outside transition
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

    const blocked = await isBlockedByGoogleMigrationGate({ id: 1 });

    expect(blocked).toBe(false);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("gate disabled (transition mode, flag false) -> false, no database query", async () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = false;
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");

    const blocked = await isBlockedByGoogleMigrationGate({ id: 1 });

    expect(blocked).toBe(false);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("gate active, user HAS a linked Google identity -> false (not blocked)", async () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
      id: 1,
      userId: 55,
      provider: "google",
      providerSubject: "sub",
    } as any);

    const blocked = await isBlockedByGoogleMigrationGate({ id: 55 });

    expect(blocked).toBe(false);
  });

  it("gate active, user has NO linked Google identity -> true (blocked)", async () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    const blocked = await isBlockedByGoogleMigrationGate({ id: 55 });

    expect(blocked).toBe(true);
  });

  it("queries by the given user's own id and the literal provider \"google\" - never any other user id", async () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    await isBlockedByGoogleMigrationGate({ id: 999 });

    expect(lookupSpy).toHaveBeenCalledWith(999, "google");
  });
});
