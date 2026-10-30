import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R40R47 P2-B1 BULK_DESIGN_HOLD tripwire.
 *
 * The package ZIP importer commits PER ROW (each create_new row is its own
 * transaction; a failed row never aborts the rest) and carries no durable
 * import batch identity. Wiring the wishlist episode producer per row would
 * therefore emit one notification PER EPISODE on bulk imports (hundreds of
 * events for a single ZIP), which the wishlist digest contract exists to
 * prevent (<=50 episodes per partition, per-novel batch identity).
 *
 * Until the bulk-digest redesign lands (import-wide transaction or per-row
 * SAVEPOINTs + a durable import batch key + per-novel <=50-episode
 * partitions - see the R40R47 report), this module must not reference the
 * notification producer stack at all. Notifications for ZIP-created episodes
 * stay disabled BY CONSTRUCTION, not by configuration.
 */
const zipImportSource = readFileSync(
  fileURLToPath(new URL("./packageZipImportService.ts", import.meta.url)),
  "utf8",
);

const FORBIDDEN_NOTIFICATION_REFERENCES = [
  "episodePublicationProducer",
  "novelPublicationProducer",
  "recordEpisodeFirstPublicationIfEnabled",
  "recordEpisodeCreationNotificationIfEnabled",
  "insertQualifiedNotification",
  "createTransactionalEventOutboxAdapter",
  "notificationPublicationMarkers",
  "notificationEvents",
  "notificationOutbox",
  "notificationDigestEpisodes",
  "wishlist_episodes_published",
];

describe("ZIP import notification HOLD (R40R47 bulk digest design)", () => {
  it("does not import or invoke the notification producer stack while bulk digest batching is undesigned", () => {
    for (const banned of FORBIDDEN_NOTIFICATION_REFERENCES) {
      expect(zipImportSource, `forbidden notification reference: ${banned}`).not.toContain(banned);
    }
  });

  it("keeps creating episodes per row without any notification side effect", () => {
    // The only episode write remains db.createEpisode/createEpisode payload
    // construction - no notification write may appear next to it.
    expect(zipImportSource).toContain("createEpisode");
    expect(zipImportSource.match(/createEpisode/g)?.length ?? 0).toBe(
      zipImportSource.match(/db\.createEpisode/g)?.length ?? 0,
    );
  });
});
