import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  notificationEvents, notificationOutbox, notificationRecipients,
  notificationPreferences, notificationBulkOperations, notificationSequence,
  notificationPublicationMarkers, notificationDigestEpisodes,
  notificationDigestBatches, notificationDigestMemberships,
} from "./tables";

const indexes = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).indexes.map(index => index.config.name);

describe("isolated Notification schema declaration (not migrated)", () => {
  it("has a unique immutable source event and one queued delivery per event", () => {
    expect(indexes(notificationEvents)).toContain("notificationEvents_eventKey_uq");
    expect(indexes(notificationOutbox)).toContain("notificationOutbox_eventId_uq");
    expect(indexes(notificationOutbox)).toContain("notificationOutbox_state_nextAttemptAt_idx");
  });
  it("dedupes recipient delivery, preserves tombstone and has a sequence cursor", () => {
    const r = getTableConfig(notificationRecipients);
    expect(r.columns.map(column => column.name)).toEqual(expect.arrayContaining([
      "eventId", "userId", "receivedSequence", "readAt", "dismissedAt",
    ]));
    expect(indexes(notificationRecipients)).toEqual(expect.arrayContaining([
      "notificationRecipients_event_user_uq", "notificationRecipients_receivedSequence_uq",
      "notificationRecipients_user_sequence_idx", "notificationRecipients_user_dismissed_read_idx",
    ]));
    expect(getTableConfig(notificationSequence).name).toBe("notificationSequence");
  });
  it("scopes preferences and bulk idempotence to authenticated actor, not mutable kind", () => {
    const expected = indexes(notificationBulkOperations);
    expect(expected).toContain("notificationBulkOperations_actor_key_uq");
    expect(getTableConfig(notificationBulkOperations).columns.map(c => c.name)).toContain("cutoffSequence");
    expect(indexes(notificationPreferences)).toContain("notificationPreferences_user_kind_uq");
  });
  it("stores durable first-publication and digest-episode identities", () => {
    expect(indexes(notificationPublicationMarkers)).toContain("notificationPublicationMarkers_type_entity_uq");
    expect(indexes(notificationDigestEpisodes)).toContain("notificationDigestEpisodes_event_episode_uq");
  });

  it("evolves the publication marker with provenance state and a nullable first-public timestamp", () => {
    const marker = getTableConfig(notificationPublicationMarkers);
    const state = marker.columns.find((column) => column.name === "state");
    const firstPublishedAt = marker.columns.find((column) => column.name === "firstPublishedAt");
    expect(state).toBeDefined();
    expect((state as unknown as { notNull: boolean }).notNull).toBe(true);
    expect((state as unknown as { default: unknown }).default).toBe("published");
    expect(firstPublishedAt).toBeDefined();
    expect((firstPublishedAt as unknown as { notNull: boolean }).notNull).toBe(false);
    expect(marker.foreignKeys ?? []).toHaveLength(0);
  });

  it("represents an empty digest batch and forbids cross-batch episode membership", () => {
    const batches = getTableConfig(notificationDigestBatches);
    const memberships = getTableConfig(notificationDigestMemberships);
    expect(batches.name).toBe("notificationDigestBatches");
    expect(batches.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "batchKey", "novelId", "sourceIdentity", "state", "watermarkAt",
      "createdAt", "updatedAt", "finalizedAt",
    ]));
    // No foreign key is required for an EMPTY batch to exist on its own.
    expect(batches.foreignKeys ?? []).toHaveLength(0);
    const membershipColumns = memberships.columns.map((column) => column.name);
    expect(membershipColumns).toEqual(expect.arrayContaining([
      "batchId", "episodeId", "state", "claimedAt", "firstEventKey", "emittedAt",
    ]));
    expect(indexes(notificationDigestMemberships)).toEqual(expect.arrayContaining([
      "notificationDigestMemberships_episode_uq",
      "notificationDigestMemberships_batch_state_idx",
    ]));
  });
});
