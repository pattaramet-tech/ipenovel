/**
 * R40R58 LOCAL ACCEPTANCE HARNESS - operator-invoked via tsx. NEVER runs in
 * production: it writes synthetic rows to the disposable `ipenovel_test`
 * database and mints LOCAL-ONLY session cookies.
 *
 * What it does, entirely through REAL code paths:
 *   1. seeds synthetic accounts (unique openIds) directly in ipenovel_test;
 *   2. writes notification events through the REAL transactional
 *      event-outbox adapter (wallet-topup receipts + one real wishlist
 *      fanout per fixture novel) - never raw inbox rows;
 *   3. delivers them by ticking the REAL composed controlled runtime
 *      (one-shot explicit invocation, no scheduler);
 *   4. mints HS256 session cookies with the SAME claims contract as
 *      server/_core/sdk.signSession (openId/appId, iss ipenovel-session,
 *      JWT_SECRET) for the local dev server to verify;
 *   5. writes the fixture file (cookieName + tokens) to the
 *      operator-provided path OUTSIDE this repository.
 *
 * Required environment:
 *   TEST_DATABASE_URL=...ipenovel_test   (guard-enforced)
 *   TEST_DATABASE_TRANSPORT=internal_plaintext   (local container)
 *   E2E_LOCAL_DB_ATTESTED=ipenovel_test  (isolation attestation)
 *   NOTIFICATIONS_ACCEPTANCE_FIXTURES=<abs path outside the repo>
 *   JWT_SECRET=<>=32 bytes, SAME value the local server boots with>
 *   VITE_APP_ID=<same value the local server boots with>
 *   NOTIFICATIONS_ACTIVATION_AT=<UTC instant before now>
 */
import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";
import { and, eq, isNull } from "drizzle-orm";
import {
  notificationEvents,
  notificationRecipients,
  novels,
  users,
  wishlists,
} from "../drizzle/schema";
import * as db from "../server/db";
import { getTestDb } from "../server/test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { createTransactionalEventOutboxAdapter } from "../server/notifications/eventOutboxStore";
import { createControlledNotificationRuntime } from "../server/notifications/controlledRuntime";
import { readNotificationRuntimeFlags } from "../server/notifications/runtimeGate";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("TEST_DATABASE_URL");
  assertSafeTestDatabaseUrl(databaseUrl);
  if (process.env.E2E_LOCAL_DB_ATTESTED !== "ipenovel_test") {
    throw new Error("Refusing to seed without E2E_LOCAL_DB_ATTESTED=ipenovel_test");
  }
  const fixturesPath = requireEnv("NOTIFICATIONS_ACCEPTANCE_FIXTURES");
  if (path.resolve(fixturesPath).startsWith(process.cwd() + path.sep)) {
    throw new Error("Fixture file must be written OUTSIDE the repository");
  }
  const jwtSecret = requireEnv("JWT_SECRET");
  const appId = requireEnv("VITE_APP_ID");
  const activationAt = new Date(requireEnv("NOTIFICATIONS_ACTIVATION_AT"));
  if (Number.isNaN(activationAt.getTime()) || activationAt.getTime() > Date.now()) {
    throw new Error("NOTIFICATIONS_ACTIVATION_AT must be a past UTC instant");
  }

  const t = getTestDb();
  const flags = readNotificationRuntimeFlags({
    NOTIFICATIONS_ENABLED: "true",
    NOTIFICATIONS_DELIVERY_ENABLED: "true",
    NOTIFICATIONS_CATALOG_FANOUT_ENABLED: "true",
  });
  const runtime = createControlledNotificationRuntime({
    flags,
    loadDatabase: async () => t,
    // the disposable container's clock trails the host; the SAME documented
    // test-only allowance used by the qualification suites
    clock: () => new Date(Date.now() + 5_000),
  });

  /** ONE tick delivers at most DEFAULT_DELIVERY_LIMITS.maxEvents events -
   *  loop until the pending queue is fully drained. */
  async function deliverAllPending(): Promise<void> {
    for (let i = 0; i < 500; i++) {
      const tick = await runtime.tick();
      if (tick.status !== "completed") throw new Error("delivery tick did not run");
      if (tick.result.claimed === 0) return;
    }
    throw new Error("pending event queue did not drain");
  }

  const tag = Date.now().toString(36);
  async function seedUser(name: string): Promise<{ id: number; openId: string }> {
    const openId = `s6-accept-${tag}-${name}`;
    const result = await t.insert(users).values({
      openId,
      name: `Acceptance ${name}`,
      email: `${openId}@example.test`,
      loginMethod: "test",
      role: "user",
    });
    const id = Number((result as any)?.[0]?.insertId ?? (result as any)?.insertId);
    return { id, openId };
  }

  /** Real event + outbox rows through the real adapter, then one tick. */
  async function deliverFinance(userId: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const sourceId = String(900_000_000 + userId * 1000 + i);
      const transitionKey = `acc_${userId}_${i}`;
      await t.transaction(async (tx: any) => {
        const adapter = createTransactionalEventOutboxAdapter(tx, new Date(), activationAt);
        const outcome = await adapter.insertEventWithOutboxIfAbsent({
          kind: "wallet_topup_approved",
          key: `notification:v1:wallet_topup_approved:wallet_topups:${sourceId}:${transitionKey}`,
          sourceType: "wallet_topups",
          sourceId,
          transitionKey,
          targetUserId: userId,
          episodeIds: [],
        });
        if (outcome !== "created") throw new Error(`fixture event ${i}: ${outcome}`);
      });
    }
    await deliverAllPending();
  }

  async function markOneRead(userId: number): Promise<void> {
    const row = (
      await t
        .select({ id: notificationRecipients.id })
        .from(notificationRecipients)
        .where(and(eq(notificationRecipients.userId, userId), isNull(notificationRecipients.readAt)))
        .limit(1)
    )[0];
    if (row) await t.update(notificationRecipients).set({ readAt: new Date() }).where(eq(notificationRecipients.id, row.id));
  }

  /** One real wishlist fanout event per account that needs a novel item. */
  async function deliverNovelFanout(userId: number): Promise<void> {
    const novelResult = await t.insert(novels).values({
      title: `Acceptance novel ${tag} u${userId}`,
      slug: `s6-acc-${tag}-${userId}`,
      author: "Acceptance Author",
      description: "Local acceptance fixture",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
    const novelId = Number((novelResult as any)?.[0]?.insertId ?? (novelResult as any)?.insertId);
    const episodeNumber = `acc-${tag}-${userId}`;
    const episodeResult = await t.transaction(async (tx: any) => {
      const { episodes } = await import("../drizzle/schema");
      return tx.insert(episodes).values({
        novelId, episodeNumber, title: "Acceptance episode", price: "0.00",
        isFree: true, isPublished: true, saleMode: "chapter",
      });
    });
    const episodeId = Number((episodeResult as any)?.[0]?.insertId ?? (episodeResult as any)?.insertId);
    await t.insert(wishlists).values({ userId, novelId, createdAt: new Date(Date.now() - 120_000) });
    await t.transaction(async (tx: any) => {
      const { recordEpisodeFirstPublicationIfEnabled } = await import("../server/notifications/episodePublicationProducer");
      const outcome = await recordEpisodeFirstPublicationIfEnabled(tx, {
        episodeId, novelId, isPublished: true, flags, env: process.env,
      });
      if (outcome.status !== "created") throw new Error(`fanout producer: ${outcome.status}`);
    });
    // opt-in backdated before the event, then deliver
    await t.transaction(async (tx: any) => {
      const { notificationPreferences } = await import("../server/notifications/tables");
      await tx.insert(notificationPreferences).values({
        userId, kind: "wishlist_episodes_published", enabled: true,
        updatedAt: new Date(Date.now() - 300_000),
      }).onDuplicateKeyUpdate({ set: { enabled: true, updatedAt: new Date(Date.now() - 300_000) } });
    });
    await deliverAllPending();
  }

  async function mintToken(openId: string, displayName: string): Promise<string> {
    return new SignJWT({ openId, appId, name: displayName })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(Math.floor((Date.now() + 24 * 3600_000) / 1000))
      .setIssuer("ipenovel-session")
      .setAudience(appId)
      .sign(new TextEncoder().encode(jwtSecret));
  }

  // ---- seed ----
  const primary = await seedUser("primary");   // multi-page + filters + novel item
  const secondary = await seedUser("second");  // cross-account isolation
  const badge99 = await seedUser("badge99");   // unread 99+ badge
  const bulkflow = await seedUser("bulkflow"); // dedicated A11 destructive mark-all->delete-all flow
  const isoA = await seedUser("isoA");         // dedicated read-only C2 isolation account
  const isoB = await seedUser("isoB");         // dedicated read-only D3 locale account
  const empty = await seedUser("empty");       // empty state
  const emptyAdmin = await seedUser("emptyadmin"); // empty state (second view)

  await deliverFinance(primary.id, 25);
  await markOneRead(primary.id);
  await deliverFinance(secondary.id, 1);
  await deliverFinance(badge99.id, 101);
  await deliverFinance(bulkflow.id, 3);
  await deliverFinance(isoA.id, 2);
  await deliverFinance(isoB.id, 2);
  await deliverNovelFanout(primary.id);

  const cookiesFile = {
    cookieName: "app_session_id",
    userToken: await mintToken(primary.openId, "Acceptance primary"),
    secondToken: await mintToken(secondary.openId, "Acceptance second"),
    badge99Token: await mintToken(badge99.openId, "Acceptance badge99"),
    bulkflowToken: await mintToken(bulkflow.openId, "Acceptance bulkflow"),
    isoAToken: await mintToken(isoA.openId, "Acceptance isoA"),
    isoBToken: await mintToken(isoB.openId, "Acceptance isoB"),
    emptyToken: await mintToken(empty.openId, "Acceptance empty"),
    emptyAdminToken: await mintToken(emptyAdmin.openId, "Acceptance empty admin"),
    openIds: {
      primary: primary.openId,
      second: secondary.openId,
      badge99: badge99.openId,
      bulkflow: bulkflow.openId,
      isoA: isoA.openId,
      isoB: isoB.openId,
      empty: empty.openId,
      emptyAdmin: emptyAdmin.openId,
    },
    seededAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(fixturesPath), { recursive: true });
  fs.writeFileSync(fixturesPath, JSON.stringify(cookiesFile, null, 2), { mode: 0o600 });

  console.log(
    `[acceptance-harness] seeded users=${5} finance(primary=25,second=1,badge99=101) novel(primary=1) ` +
      `-> fixtures written (secrets not printed)`
  );
  await closePool();
}

async function closePool(): Promise<void> {
  const { closeTestDb } = await import("../server/test-helpers/testDb");
  await closeTestDb().catch(() => {});
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("[acceptance-harness] FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
