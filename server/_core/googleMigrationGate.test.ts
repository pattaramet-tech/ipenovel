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

  it("[post-account-recovery session UX] a source account whose Google identity was just moved away by an approved recovery request is blocked by this SAME gate, exactly like any other unconnected user - the gate is agnostic to WHY a user lacks an identity, which is what makes the 'old session can never impersonate the target' invariant hold without any account-recovery-specific code here at all", async () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    // executeAccountRecovery's moveAuthIdentityOwner (server/db.ts) changes
    // authIdentities.userId from source to target - it never creates a new
    // row for the source. From this gate's point of view, the source
    // account (still authenticated via its OWN, untouched session cookie -
    // see server/services/accountRecoveryService.ts's
    // finalizeAccountRecoveryTargetUser docstring, which never touches
    // users.id/openId) now simply has no linked google identity, the exact
    // same lookup result as any never-connected user.
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);

    const sourceStillLoggedIn = { id: 55 };
    const blocked = await isBlockedByGoogleMigrationGate(sourceStillLoggedIn);

    expect(blocked).toBe(true);
  });
});
