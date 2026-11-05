/**
 * R40R66 — REAL spawn E2E for the external one-shot scheduler CLI.
 *
 * Spawns the actual command (`tsx scripts/notifications-tick.ts`) as an
 * operator's cron would, against the disposable `ipenovel_test` MySQL 8:
 *   1. disabled gates  -> exit 0, zero notification SQL, nothing delivered;
 *   2. enabled gates   -> exit 0, seeded event+outbox row delivered to a
 *      real recipient (real store, real runner — the full pipeline);
 *   3. re-tick         -> exit 0, ZERO new recipients (idempotent);
 *   4. R40R66R3 no-fallback proof -> a Production-shaped UNREACHABLE
 *      DATABASE_URL alongside a verified TEST_DATABASE_URL: the run still
 *      delivers through the test channel only (any DATABASE_URL fallback
 *      would fail the whole tick instead).
 *
 * The delivery semantics themselves (leases, retry, dead-letter, paging)
 * are qualified in s6DeliveryInbox/R-file suites; THIS file proves the CLI
 * binary wiring: env gates, exit codes, one-shot invocation, exit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { and, count, eq } from "drizzle-orm";
import {
  notificationEvents,
  notificationOutbox,
  notificationRecipients,
  users,
} from "../../drizzle/schema";
import { createTransactionalEventOutboxAdapter } from "../notifications/eventOutboxStore";
import { getTestDb } from "../test-helpers/testDb";
import { createTestUser, deleteFixtures } from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("tick CLI E2E requires TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

const SCRIPT = "scripts/notifications-tick.ts";

function spawnTick(extraEnv: Record<string, string>): { code: number; stdout: string } {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    DEPLOYMENT_ENVIRONMENT: "local-test",
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    NOTIFICATIONS_ACTIVATION_AT: "2026-10-01T00:00:00.000Z",
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT], {
      env,
      timeout: 90_000,
      encoding: "utf8",
      cwd: new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error: any) {
    // Surface the CLI's own sanitized stderr in the assertion message.
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

const trackedUserIds: number[] = [];
const trackedEventKeys: string[] = [];

async function seedEligibleEvent(userId: number): Promise<void> {
  const t = requireTestDb();
  const sourceId = String(800_000_000 + userId);
  const transitionKey = `r66_${sourceId}`;
  const eventKey = `notification:v1:wallet_topup_approved:wallet_topups:${sourceId}:${transitionKey}`;
  trackedEventKeys.push(eventKey);
  await t.transaction(async (tx: any) => {
    const adapter = createTransactionalEventOutboxAdapter(tx, new Date(Date.now() - 60_000), new Date("2026-10-01T00:00:00.000Z"));
    const outcome = await adapter.insertEventWithOutboxIfAbsent({
      kind: "wallet_topup_approved",
      key: eventKey,
      sourceType: "wallet_topups",
      sourceId,
      transitionKey,
      targetUserId: userId,
      episodeIds: [],
    });
    if (outcome !== "created") throw new Error(`seed event: ${outcome}`);
  });
}

async function recipientsForEvent(eventKey: string): Promise<number> {
  const t = requireTestDb();
  const event = (await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, eventKey)).limit(1))[0];
  if (!event) return -1;
  return Number((await t.select({ c: count() }).from(notificationRecipients).where(eq(notificationRecipients.eventId, event.id)))[0]?.c ?? 0);
}

describe("R40R66 tick CLI spawn E2E (real command, disposable MySQL)", () => {
  it("disabled gates -> exit 0, zero notification SQL, nothing delivered", async () => {
    const user = await createTestUser();
    trackedUserIds.push(user.id);
    await seedEligibleEvent(user.id);
    const t = requireTestDb();

    const { code, stdout } = spawnTick({
      NOTIFICATIONS_ENABLED: "false",
      NOTIFICATIONS_DELIVERY_ENABLED: "false",
    });

    expect(code).toBe(0);
    expect(stdout).toContain('"status":"disabled"');
    // zero notification SQL: THIS test's own seeded event/outbox row is
    // untouched (state pending, never claimed) and no recipient was created.
    // Table-wide assertions would be order-dependent on a shared DB.
    const ownEvent = (
      await t.select().from(notificationEvents).where(eq(notificationEvents.eventKey, trackedEventKeys[0]))
    )[0];
    const ownOutbox = (
      await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, ownEvent.id))
    )[0];
    expect(ownOutbox.state).toBe("pending");
    expect(ownOutbox.attempt).toBe(0);
    expect(ownOutbox.leaseToken).toBeNull();
    expect(await recipientsForEvent(trackedEventKeys[0])).toBe(0);
  });

  it("enabled gates -> exit 0, event delivered to a real recipient, re-tick idempotent", async () => {
    const user = await createTestUser();
    trackedUserIds.push(user.id);
    await seedEligibleEvent(user.id);
    const t = requireTestDb();

    const { code, stdout } = spawnTick({
      NOTIFICATIONS_ENABLED: "true",
      NOTIFICATIONS_DELIVERY_ENABLED: "true",
    });

    expect(code).toBe(0);
    expect(stdout).toContain('"status":"completed"');
    expect(await recipientsForEvent(trackedEventKeys[0])).toBe(1);

    // idempotent re-tick: no duplicate recipient, event already completed
    const second = spawnTick({
      NOTIFICATIONS_ENABLED: "true",
      NOTIFICATIONS_DELIVERY_ENABLED: "true",
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('"recipientsCreated":0');
    expect(await recipientsForEvent(trackedEventKeys[0])).toBe(1);
  });

  it("R40R66R3 no-fallback: unreachable Production-shaped DATABASE_URL is ignored on the local-test channel", async () => {
    const user = await createTestUser();
    trackedUserIds.push(user.id);
    await seedEligibleEvent(user.id);
    const t = requireTestDb();

    // DATABASE_URL points at a Production-named database on a closed local
    // port (instant ECONNREFUSED). If the CLI ever fell back to DATABASE_URL
    // on the local-test channel, this tick could not claim or deliver and
    // would exit 1 - a successful delivery here can only have been routed
    // through TEST_DATABASE_URL (ensureVerifiedTestDb).
    const { code, stdout, stderr } = spawnTick({
      DATABASE_URL: "mysql://prod-should-not-be-used:prod-password@127.0.0.1:1/ipenovel_prod",
      NOTIFICATIONS_ENABLED: "true",
      NOTIFICATIONS_DELIVERY_ENABLED: "true",
    });

    expect(code).toBe(0);
    expect(stdout).toContain('"status":"completed"');
    // The unreachable production identity never leaks into operator output.
    expect(stdout).not.toContain("prod-should-not-be-used");
    expect(stderr).not.toContain("prod-should-not-be-used");
    // The ONLY write landed in the disposable test database.
    expect(await recipientsForEvent(trackedEventKeys[0])).toBe(1);
  });
});

afterEach(async () => {
  const t = requireTestDb();
  for (const key of trackedEventKeys) {
    const rows = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.eventKey, key))
      .catch(() => []);
    for (const row of rows) {
      await t.delete(notificationRecipients).where(eq(notificationRecipients.eventId, row.id)).catch(() => {});
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id)).catch(() => {});
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.eventKey, key)).catch(() => {});
  }
  for (const id of trackedUserIds) {
    await t.delete(notificationRecipients).where(eq(notificationRecipients.userId, id)).catch(() => {});
    await deleteFixtures({ userIds: [id] }).catch(() => {});
  }
  trackedEventKeys.length = 0;
  trackedUserIds.length = 0;
  void and;
  void count;
  void eq;
  void users;
});
