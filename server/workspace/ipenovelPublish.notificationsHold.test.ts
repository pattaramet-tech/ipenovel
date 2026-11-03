import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Workspace notifications are OUT OF SCOPE by owner decision (2026-10-28).
 * Preserve this tripwire to prevent accidental notification wiring into the
 * existing Workspace publication workflow.
 *
 * Workspace publishes carry durable evidence (committed receipts, immutable
 * stage state hashes, V3/V2 stage contracts, publish runs), but NONE of that
 * evidence alone proves FIRST-EVER publication: a V3 stage can be staged for
 * an episode whose publication history predates the notification feature
 * (admin catalog surfaces are not yet marker-claiming), receipts are also
 * produced by replacements, and a publish RUN contains multiple staged
 * episodes (per-episode events would fan out without a run-identity digest
 * partition design).
 *
 * This is no longer pending a design milestone: Workspace-origin
 * notifications have been explicitly removed from scope. The Workspace
 * publication boundary must not reference the notification producer stack;
 * any future change requires new, explicit owner authorization.
 */
const GUARDED_SOURCES = [
  "ipenovelPublish.provider.ts",
  "editorialPublish.service.ts",
  "editorialApproval.service.ts",
  "publishLockOrder.ts",
] as const;

const FORBIDDEN_NOTIFICATION_REFERENCES = [
  "episodePublicationProducer",
  "novelPublicationProducer",
  "recordEpisodeFirstPublicationIfEnabled",
  "recordEpisodeCreationNotificationIfEnabled",
  "recordNovelFirstPublicationIfEnabled",
  "insertQualifiedNotification",
  "createTransactionalEventOutboxAdapter",
  "notificationPublicationMarkers",
  "notificationEvents",
  "notificationOutbox",
  "notificationDigestEpisodes",
  "wishlist_episodes_published",
];

describe("Workspace notification exclusion (owner scope decision)", () => {
  for (const file of GUARDED_SOURCES) {
    it(`keeps ${file} free of out-of-scope notification producer wiring`, () => {
      const source = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      for (const banned of FORBIDDEN_NOTIFICATION_REFERENCES) {
        expect(source, `forbidden notification reference in ${file}: ${banned}`).not.toContain(banned);
      }
    });
  }
});
