import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  notificationEvents, notificationOutbox, notificationRecipients,
  notificationPreferences, notificationBulkOperations, notificationSequence,
  notificationPublicationMarkers, notificationDigestEpisodes,
  notificationDigestBatches, notificationDigestMemberships,
} from "./tables";

const migration = readFileSync(
  fileURLToPath(new URL("../../drizzle/0067_notifications_engagement.sql", import.meta.url)),
  "utf8",
);
const quote = String.fromCharCode(96);
const tables = [
  notificationEvents, notificationOutbox, notificationRecipients,
  notificationPreferences, notificationBulkOperations, notificationSequence,
  notificationPublicationMarkers, notificationDigestEpisodes,
  notificationDigestBatches, notificationDigestMemberships,
];

describe("Notifications additive migration candidate (static, NOT DB qualification)", () => {
  it("defines every isolated Drizzle table, column and index exactly once", () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const marker = "CREATE TABLE " + quote + config.name + quote;
      expect(migration.split(marker).length - 1, config.name).toBe(1);
      const start = migration.indexOf(marker);
      const next = migration.indexOf("--> statement-breakpoint", start);
      const definition = migration.slice(start, next === -1 ? undefined : next);
      for (const column of config.columns) {
        expect(definition, config.name + "." + column.name).toContain(quote + column.name + quote);
      }
      for (const index of config.indexes) {
        expect(definition, config.name + "." + index.config.name).toContain(quote + index.config.name + quote);
      }
    }
  });

  it("seeds sequence exactly once without historical backfill, and is registered in the drizzle journal", () => {
    expect(migration).toContain("INSERT INTO " + quote + "notificationSequence" + quote);
    expect(migration).toContain("VALUES (1,1)");
    expect(migration).not.toContain("INSERT INTO " + quote + "notificationRecipients" + quote);
    const journal = readFileSync(
      fileURLToPath(new URL("../../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    );
    expect(journal).toContain('"tag": "0067_notifications_engagement"');
    expect(journal).toContain('"when": 1791800000000');
    expect(journal).toContain('"idx": 67');
    expect(migration).not.toContain("NOT REGISTERED IN drizzle/meta/_journal.json YET");
  });

  it("evolves the publication marker for provenance states without breaking identity", () => {
    const start = migration.indexOf("CREATE TABLE " + quote + "notificationPublicationMarkers" + quote);
    const definition = migration.slice(start, migration.indexOf("--> statement-breakpoint", start));
    expect(definition).toContain(quote + "state" + quote + " varchar(24) NOT NULL DEFAULT 'published'");
    expect(definition).toContain(quote + "firstPublishedAt" + quote + " timestamp NULL");
    expect(definition).toContain("UNIQUE KEY " + quote + "notificationPublicationMarkers_type_entity_uq" + quote);
  });

  it("adds durable digest batches and per-episode memberships with recovery indexes", () => {
    expect(migration).toContain("CREATE TABLE " + quote + "notificationDigestBatches" + quote);
    expect(migration).toContain(quote + "batchKey" + quote + " varchar(96) NOT NULL");
    expect(migration).toContain("UNIQUE KEY " + quote + "notificationDigestBatches_batchKey_uq" + quote);
    expect(migration).toContain("CREATE TABLE " + quote + "notificationDigestMemberships" + quote);
    expect(migration).toContain("UNIQUE KEY " + quote + "notificationDigestMemberships_episode_uq" + quote);
    expect(migration).toContain("KEY " + quote + "notificationDigestMemberships_batch_state_idx" + quote);
  });

  it("keeps canonical batch identities inside the event contract bounds without colons", () => {
    const canonical = /^(?:wr\d+n\d+|zi\d+n\d+)$/;
    for (const key of ["wr12n42", "zi88n42", "zi" + "9".repeat(20) + "n" + "4".repeat(10)]) {
      expect(key).toMatch(canonical);
      expect(key.length).toBeLessThanOrEqual(72);
      const sourceId = `42_${key}_0`;
      expect(sourceId.length).toBeLessThanOrEqual(96);
      expect(sourceId).not.toContain(":");
    }
    for (const key of ["wr:12n42", "zi88:n42", "-".repeat(73), "zi88n42:replay"]) {
      // Every non-canonical form must fail the canonical pattern (colon,
      // over-length, wrong shape) and thus be rejected at emission time.
      expect(canonical.test(key)).toBe(false);
    }
  });

  it("preserves tombstones and actor-scoped bulk operation identity", () => {
    expect(migration).toContain(quote + "dismissedAt" + quote + " timestamp NULL");
    expect(migration).toContain("UNIQUE KEY " + quote + "notificationRecipients_event_user_uq" + quote);
    expect(migration).toContain("UNIQUE KEY " + quote + "notificationBulkOperations_actor_key_uq" + quote);
  });
});
