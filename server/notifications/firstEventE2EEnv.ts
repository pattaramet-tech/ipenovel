/**
 * R40R85 FIRST-EVENT E2E - process environment setup.
 *
 * MUST be the FIRST import in firstEventE2E.integration.test.ts (before any
 * server module): db.ts and routers.ts capture the notification runtime
 * flags ONCE at module load (readNotificationRuntimeFlags(process.env)),
 * so the catalog-fanout producer gate for this test process can only be
 * armed here. The values are self-contained for this test process and are
 * deliberately decoupled from any shared/production configuration file.
 *
 * Everything below is TEST-ONLY: the delivery itself runs in a spawned
 * one-shot CLI process with its own explicit environment.
 */
process.env.NODE_ENV = "test";
process.env.NOTIFICATIONS_ENABLED = "true";
process.env.NOTIFICATIONS_DELIVERY_ENABLED = "true";
process.env.NOTIFICATIONS_CATALOG_FANOUT_ENABLED = "true";
process.env.NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED = "false";
// Inbox endpoints resolve the cursor signing key from the environment on
// first gated use; the notifications router mount fails closed without it.
process.env.NOTIFICATIONS_CURSOR_SIGNING_KEY = "6f5a2b9c1d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a";
// The application-level lazy store (used by inbox endpoints) reads DATABASE_URL;
// point it at the SAME verified disposable database the tests use. The
// delivery channel itself never falls back to DATABASE_URL (proven by
// tickCliSpawn.integration.test.ts).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

export {};
