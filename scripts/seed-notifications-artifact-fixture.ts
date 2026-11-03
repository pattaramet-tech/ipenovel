/**
 * R40R66R1 fixture seeder for the production-artifact CLI run: inserts a
 * synthetic user + one eligible wallet-topup event/outbox row through the
 * REAL transactional adapter, prints the seeded ids as JSON.
 * Disposable ipenovel_test only (guard-enforced).
 */
import { eq } from "drizzle-orm";
import { ensureVerifiedTestDb } from "../server/test-helpers/testDb";
import { safeErrorSummary } from "../scripts/lib/safeErrorSummary.mjs";
import { createTransactionalEventOutboxAdapter } from "../server/notifications/eventOutboxStore";
import { users } from "../drizzle/schema";

async function main(): Promise<void> {
  const label = process.argv[2] ?? "artifact";
  // Live-verified disposable channel: DATABASE() must be ipenovel_test
  // before any fixture write. Never falls back to DATABASE_URL - the test
  // channel reads TEST_DATABASE_URL only (guard-enforced).
  const t = await ensureVerifiedTestDb();
  const openId = `r66-${label}-${Date.now().toString(36)}`;
  await t.insert(users).values({
    openId,
    name: `Artifact ${label}`,
    email: `${openId}@example.test`,
    loginMethod: "test",
  });
  const [userRow] = await t.select({ id: users.id }).from(users).where(eq(users.openId, openId)).limit(1);
  const userId = Number(userRow.id);

  const sourceId = String(700_000_000 + userId);
  const transitionKey = `r66_${sourceId}`;
  await t.transaction(async (tx: any) => {
    const adapter = createTransactionalEventOutboxAdapter(
      tx,
      new Date(Date.now() - 60_000),
      new Date("2026-10-01T00:00:00.000Z")
    );
    const outcome = await adapter.insertEventWithOutboxIfAbsent({
      kind: "wallet_topup_approved",
      key: `notification:v1:wallet_topup_approved:wallet_topups:${sourceId}:${transitionKey}`,
      sourceType: "wallet_topups",
      sourceId,
      transitionKey,
      targetUserId: userId,
      episodeIds: [],
    });
    if (outcome !== "created") throw new Error(`seed: ${outcome}`);
  });

  console.log(
    JSON.stringify({
      userId,
      eventKey: `notification:v1:wallet_topup_approved:wallet_topups:${sourceId}:${transitionKey}`,
    })
  );
  process.exit(0);
}

main().catch(error => {
  console.error("seed failed:", safeErrorSummary(error));
  process.exit(1);
});
