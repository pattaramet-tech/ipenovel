import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sdk } from "./_core/sdk";
import { __setDbForTests } from "./db";
import { getTestDb } from "./test-helpers/testDb";
import * as registry from "./services/sessionRegistry";
import { authSessions, readingLeases, sessionSlots, users } from "../drizzle/schema";

/**
 * R8B-4C — Session Slot Recovery regression battery.
 *
 * Staging acceptance defect: A active, C logout, B logout/re-login left
 * B stuck in pending_choice even though only ONE active session remained —
 * a pending_choice row had no activation trigger once a slot freed
 * (resolveThirdLogin requires displacing a live session; maybePromoteUnslotted
 * only covers unslotted_legacy).
 *
 * Fix under test: registry.maybeActivatePending + the SDK auth path wiring
 * (resolveRegistryRow pending branch) — a pending session claims a freed slot
 * on its own next request, never displacing live sessions, quota decided by
 * a locking recount inside the user-lock tx, durable revocation and DB-time
 * pending expiry preserved.
 */

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

const SESSION_30D_MS = 30 * 86400000;
const DAY_MS = 86400000;

function setFlag(on: boolean) {
  process.env.READER_SESSION_CONTROLS = on ? "true" : "false";
}

describe("R8B-4C session slot recovery", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const createdUserIds: number[] = [];
  const createdSessionIds: number[] = [];

  /** Fresh user per test — quota state must never leak between tests. */
  let userU = 0;
  let userOpenId = "";

  async function freshUser(): Promise<number> {
    const openId = `r8b4c-${tag}-${randomUUID().slice(0, 8)}`;
    const id = insertId(
      await db.insert(users).values({
        openId,
        name: `R8B4C ${tag}`,
        email: `r8b4c-${randomUUID().slice(0, 8)}@example.test`,
        loginMethod: "test",
        role: "user",
      })
    );
    createdUserIds.push(id);
    userU = id;
    userOpenId = openId;
    return id;
  }

  beforeAll(async () => {
    __setDbForTests(db);
    setFlag(true);
  });

  afterAll(async () => {
    setFlag(false);
    __setDbForTests(null);
    if (createdSessionIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.id, createdSessionIds));
    }
    await db.delete(authSessions).where(inArray(authSessions.userId, createdUserIds));
    await db.delete(readingLeases).where(inArray(readingLeases.userId, createdUserIds));
    await db.delete(sessionSlots).where(inArray(sessionSlots.userId, createdUserIds));
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  beforeEach(() => {
    setFlag(true);
  });

  /** Mints a v2 cookie + registry row (allocator decides status per flag/slots). */
  async function mintV2(
    label: string,
    opts?: { expiresInMs?: number }
  ) {
    const sid = registry.generateSid();
    const token = await sdk.createSessionToken(userOpenId, {
      sid,
      expiresInMs: opts?.expiresInMs ?? SESSION_30D_MS,
    });
    const row = await registry.allocateSessionRow({
      userId: userU,
      token,
      sid,
      expiresAt: new Date(Date.now() + (opts?.expiresInMs ?? SESSION_30D_MS)),
      createdVia: "google",
      clientLabel: label,
    });
    createdSessionIds.push(row.id);
    return { token, sid, row };
  }

  const authByCookie = (token: string) =>
    sdk.authenticateRequestWithSession({
      headers: { cookie: `app_session_id=${token}` },
    } as any);

  async function freshRow(id: number) {
    const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id));
    return row;
  }

  async function slotsRow() {
    const [row] = await db.select().from(sessionSlots).where(eq(sessionSlots.userId, userU));
    return row;
  }

  async function activeCount() {
    const rows = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userU), eq(authSessions.status, "active")));
    return rows.length;
  }

  /** Standard fixture: fresh user with A + C active, B pending (third login). */
  async function activeActivePending() {
    await freshUser();
    const a = await mintV2("A device");
    const c = await mintV2("C device");
    const b = await mintV2("B device");
    expect(a.row.status).toBe("active");
    expect(c.row.status).toBe("active");
    expect(b.row.status).toBe("pending_choice");
    return { a, b, c };
  }

  // =====================================================================
  // T1 — the reported staging scenario, through the REAL SDK auth path
  // =====================================================================
  it("T1: A active, C logout, B re-login pending → C logout frees the slot → B's next SDK request activates B without touching A", async () => {
    const { a, b, c } = await activeActivePending();

    // C logs out — the durable revocation floor.
    const outcome = await registry.revokeByToken(c.token);
    expect(outcome).toBe("revoked");

    // B's pending deadline is min(JWT exp, NOW+30m) — verify the fixture.
    const pendingBefore = await freshRow(b.row.id);
    expect(pendingBefore!.status).toBe("pending_choice");

    // B's next authenticated request (context construction) must claim the freed slot.
    const auth = await authByCookie(b.token);
    expect(auth.sessionRow!.status).toBe("active");

    const after = await freshRow(b.row.id);
    expect(after!.status).toBe("active");
    // R4/C: activation inherits the VERIFIED JWT exp — not cut at the 30m window.
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    // No displacement: A is byte-identical (same id, still active), C stays revoked.
    const aAfter = await freshRow(a.row.id);
    expect(aAfter!.status).toBe("active");
    expect(aAfter!.id).toBe(a.row.id);
    const cAfter = await freshRow(c.row.id);
    expect(cAfter!.status).toBe("revoked");
    expect(cAfter!.revokedReason).toBe("user_logout");

    expect(await activeCount()).toBe(2);
    expect((await slotsRow())!.activeCount).toBe(2);
  });

  // =====================================================================
  // T2 — registry-level claim: idempotent, quota untouched beyond +1
  // =====================================================================
  it("T2: registry claim activates the freed slot exactly once and keeps the slots counter consistent", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);

    const first = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(first!.status).toBe("active");

    const again = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(again!.status).toBe("active");
    expect(await activeCount()).toBe(2);
    expect((await slotsRow())!.activeCount).toBe(2);
    expect((await freshRow(a.row.id))!.status).toBe("active");
  });

  // =====================================================================
  // T3 — quota still full → claim is a no-op (chooser path unchanged)
  // =====================================================================
  it("T3: with the quota full a claim attempt leaves the row pending_choice", async () => {
    const { b } = await activeActivePending();
    const result = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(result!.status).toBe("pending_choice");
    expect(await activeCount()).toBe(2);
  });

  // =====================================================================
  // T4 — race: two pending sessions claim ONE freed slot
  // =====================================================================
  it("T4: two concurrent claims for one freed slot activate exactly one session (never 3 active)", async () => {
    const { a, b, c } = await activeActivePending();
    const d = await mintV2("D device"); // quota full → also pending
    expect(d.row.status).toBe("pending_choice");

    await registry.revokeByToken(c.token); // exactly one slot frees

    const [rB, rD] = await Promise.all([
      registry.maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) }),
      registry.maybeActivatePending({ sessionId: d.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) }),
    ]);

    const statuses = [rB!.status, rD!.status].sort();
    expect(statuses).toEqual(["active", "pending_choice"]);
    expect(await activeCount()).toBe(2); // A + exactly one claimer — never 3
    expect((await slotsRow())!.activeCount).toBe(2);
    expect((await freshRow(a.row.id))!.status).toBe("active");
  });

  // =====================================================================
  // T5 — race: pending claim vs a fresh third login for the last slot
  // =====================================================================
  it("T5: concurrent pending-claim and fresh login serialize on the slots lock — exactly one takes the last slot", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(c.token); // one slot frees

    const [claim, fresh] = await Promise.all([
      registry.maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: new Date(Date.now() + SESSION_30D_MS) }),
      mintV2("fresh racer").then(r => r.row),
    ]);

    const winners = [claim!.status, fresh.status].filter(s => s === "active").length;
    expect(winners).toBe(1);
    expect(await activeCount()).toBe(2);
    expect((await slotsRow())!.activeCount).toBe(2);
  });

  // =====================================================================
  // T6 — session rotation interplay: rotation never promotes a pending row
  // =====================================================================
  it("T6: same-session rotation keeps quota at 2 and leaves pending untouched; the freed slot still activates the pending row", async () => {
    const { a, b, c } = await activeActivePending();

    // A rotates: NEW sid + token (UNIQUE(sid)), OLD row id as rotateRowId —
    // the allocator supersedes A and creates A' in ONE tx.
    const rotatedSid = registry.generateSid();
    const rotatedToken = await sdk.createSessionToken(userOpenId, {
      sid: rotatedSid,
      expiresInMs: SESSION_30D_MS,
    });
    const rotated = await registry.allocateSessionRow({
      userId: userU,
      token: rotatedToken,
      sid: rotatedSid,
      expiresAt: new Date(Date.now() + SESSION_30D_MS),
      createdVia: "google",
      rotateRowId: a.row.id,
    });
    createdSessionIds.push(rotated.id);
    expect(rotated.status).toBe("active");
    expect((await freshRow(a.row.id))!.status).toBe("superseded");
    expect((await freshRow(b.row.id))!.status).toBe("pending_choice"); // rotation is NOT a promotion trigger
    expect(await activeCount()).toBe(2);

    // C logs out → the freed slot is claimable by the pending row.
    await registry.revokeByToken(c.token);
    const auth = await authByCookie(b.token);
    expect(auth.sessionRow!.status).toBe("active");
    expect(await activeCount()).toBe(2);
    expect((await freshRow(rotated.id))!.status).toBe("active");
  });

  // =====================================================================
  // T7 — third-login displacement contract unchanged (chooser still works)
  // =====================================================================
  it("T7: with the quota full, third login stays pending and resolveThirdLogin still displaces the chosen session", async () => {
    const { a, b, c } = await activeActivePending();
    const resolved = await registry.resolveThirdLogin({
      callerSessionId: b.row.id,
      displaceSessionId: c.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(resolved.ok).toBe(true);
    expect((await freshRow(b.row.id))!.status).toBe("active");
    expect((await freshRow(c.row.id))!.status).toBe("superseded");
    expect((await freshRow(c.row.id))!.revokedReason).toBe("displaced_by_login");
    expect((await freshRow(a.row.id))!.status).toBe("active");
    expect(await activeCount()).toBe(2);
  });

  // =====================================================================
  // T8 — durable revocation floor: a revoked row can never claim a slot
  // =====================================================================
  it("T8: a revoked pending row never re-activates and its cookie is rejected by the floor", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(b.token); // B logs out while pending
    const freed = await registry.revokeByToken(c.token); // slot frees afterwards

    const claim = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(claim!.status).toBe("revoked");
    expect((await freshRow(b.row.id))!.revokedReason).toBe("user_logout");

    // The floor rejects the dead cookie outright.
    await expect(authByCookie(b.token)).rejects.toMatchObject({ reason: "session_revoked" });
    expect(await activeCount()).toBe(1); // only A
    void a; void freed;
  });

  // =====================================================================
  // T9 — pending expiry floor: an elapsed chooser window expires, never activates
  // =====================================================================
  it("T9: a pending row whose chooser window elapsed is flipped to superseded(expired), never activated", async () => {
    const { b, c } = await activeActivePending();
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.id, b.row.id));

    const claim = await registry.maybeActivatePending({
      sessionId: b.row.id,
      activateExpiresAt: new Date(Date.now() + SESSION_30D_MS),
    });
    expect(claim!.status).toBe("superseded");
    expect(claim!.revokedReason).toBe("expired");
    // A and C are both untouched and still active — only the expired pending
    // row died; the freed-slot activation never happened for it.
    expect((await freshRow(c.row.id))!.status).toBe("active");
    expect(await activeCount()).toBe(2);
  });

  // =====================================================================
  // T10 — flag OFF: the choose concept vanishes; promotion keeps verified exp
  // =====================================================================
  it("T10: with the flag OFF a pending row promotes via the real auth path with the verified JWT exp (slots counter untouched)", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);
    const slotsBefore = await slotsRow();

    setFlag(false);
    try {
      const auth = await authByCookie(b.token);
      expect(auth.sessionRow!.status).toBe("active");
      const after = await freshRow(b.row.id);
      expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
      // OFF does not maintain the slots counter (mirrors allocate's OFF path).
      const slotsAfter = await slotsRow();
      expect(slotsAfter!.activeCount).toBe(slotsBefore!.activeCount);
      expect((await freshRow(a.row.id))!.status).toBe("active");
    } finally {
      setFlag(true);
    }
  });

  // =====================================================================
  // T11 — the same pending row claimed by two concurrent requests
  // =====================================================================
  it("T11: two concurrent claims on the SAME pending row serialize to one activation", async () => {
    const { a, b, c } = await activeActivePending();
    await registry.revokeByToken(c.token);

    const exp = new Date(Date.now() + SESSION_30D_MS);
    const [r1, r2] = await Promise.all([
      registry.maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: exp }),
      registry.maybeActivatePending({ sessionId: b.row.id, activateExpiresAt: exp }),
    ]);
    expect(r1!.status).toBe("active");
    expect(r2!.status).toBe("active");
    expect(await activeCount()).toBe(2);
    expect((await slotsRow())!.activeCount).toBe(2);
  });
});
