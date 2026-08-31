import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function adminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "sports-admin",
    email: "sports-admin@example.test",
    name: "Sports Admin",
    loginMethod: "test",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as AuthenticatedUser;
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

const baseCreateInput = {
  title: "Arsenal vs Liverpool",
  voteDeadlineAt: new Date(Date.now() + 60_000),
  voteCostPoints: "0",
  rewardKind: "points" as const,
  rewardPointsAmount: "10",
  status: "draft" as const,
};

describe("IPE-009 Sports Vote admin create contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a new legacy name-only match before the database layer can be called", async () => {
    const createSpy = vi.spyOn(db, "createSportsMatch").mockResolvedValue({ id: 77 });
    const caller = appRouter.createCaller(adminContext());

    await expect(caller.admin.sportsMatches.create({
      ...baseCreateInput,
      homeTeamName: "Legacy Home",
      awayTeamName: "Legacy Away",
    } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("accepts a catalog-backed match and forwards the exact competition/team IDs", async () => {
    const createSpy = vi.spyOn(db, "createSportsMatch").mockResolvedValue({ id: 88 });
    const caller = appRouter.createCaller(adminContext());

    const result = await caller.admin.sportsMatches.create({
      ...baseCreateInput,
      competitionId: 10,
      homeTeamId: 20,
      awayTeamId: 30,
    });

    expect(result).toEqual({ id: 88 });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      competitionId: 10,
      homeTeamId: 20,
      awayTeamId: 30,
    }));
  });
});
