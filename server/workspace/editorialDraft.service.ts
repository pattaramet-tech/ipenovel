import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDraftTransforms,
  workspaceEditorialDrafts,
  workspaceEditorialSourceSnapshots,
  workspaceEditorialSources,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  EditorialAccessError,
  resolveEditorialPluginAccess,
  type EditorialAccessPolicy,
} from "./editorialAccess.service";
import { canonicalizeActiveSourceKeys } from "./masterIntake.domain";
import {
  EDITORIAL_DRAFT_PRESENTATION,
  normalizeEditorialText,
  runEditorialPreparationPipeline,
  sourcePayloadSha256,
  type EditorialSourcePayload,
} from "./editorialDraft.domain";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";

export class WorkspaceEditorialDraftError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORK_ITEM_NOT_FOUND"
      | "SOURCE_CONFLICT"
      | "SOURCE_REVISION_CONFLICT"
      | "REFRESH_REQUIRES_REVIEW"
      | "SNAPSHOT_NOT_FOUND"
      | "SOURCE_INVALID"
      /**
       * The active-source state observed at preview time no longer matches
       * the state inside the mutation transaction. Thrown BEFORE any source
       * mutation so a concurrent change is never silently overwritten.
       */
      | "STALE_PREVIEW",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialDraftError";
  }
}

function insertId(result: any) {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new WorkspaceEditorialDraftError(
      "DATABASE_UNAVAILABLE",
      "Editorial source record was not persisted."
    );
  }
  return id;
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialDraftError(
      "DATABASE_UNAVAILABLE",
      "Workspace editorial draft database is unavailable."
    );
  }
  return db;
}

async function requireWorkItem(
  db: any,
  actorUserId: number,
  workspaceId: number,
  workItemId: number,
  accessPolicy: EditorialAccessPolicy = "workspace_route"
) {
  // IPE-PLUGIN-001D-R2: the workspace_route policy preserves the historical
  // platform-admin gate bit-for-bit; plugin policies resolve the caller's
  // EFFECTIVE role from the database (owner via ownerUserId, else ACTIVE
  // workspaceMembers row) and enforce the policy grade. Fail-closed:
  // no workspace / no effective membership -> WORK_ITEM_NOT_FOUND (no
  // existence oracle); member below grade -> EDIT_FORBIDDEN (denied).
  if (accessPolicy !== "workspace_route") {
    const decision = await resolveEditorialPluginAccess(db, {
      actorUserId,
      workspaceId,
      policy: accessPolicy,
    });
    if (!decision.allowed) {
      if (decision.reason === "FORBIDDEN") throw new EditorialAccessError();
      throw new WorkspaceEditorialDraftError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was not found in this Workspace."
      );
    }
  } else {
    await requireWorkspacePlatformAdmin(db, actorUserId);
  }
  const [row] = await db
    .select({
      workItem: workspaceEditorialWorkItems,
      card: workspaceKanbanCards,
      board: workspaceKanbanBoards,
    })
    .from(workspaceEditorialWorkItems)
    .innerJoin(
      workspaceKanbanCards,
      eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
    )
    .innerJoin(
      workspaceKanbanBoards,
      eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id)
    )
    .where(
      and(
        eq(workspaceEditorialWorkItems.id, workItemId),
        eq(workspaceKanbanBoards.workspaceId, workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
        eq(workspaceKanbanBoards.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialDraftError(
      "WORK_ITEM_NOT_FOUND",
      "Editorial work item was not found in this Workspace."
    );
  }
  return row;
}

function normalizeSourcePayload(payload: EditorialSourcePayload) {
  const sourceKey = payload.sourceKey.trim();
  const mimeType = payload.mimeType.trim();
  const title = payload.title.trim();
  if (!sourceKey || !mimeType || !title || !payload.tabs.length) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source identity, MIME type, title, and at least one tab are required."
    );
  }
  if (sourceKey.length > 255 || mimeType.length > 160 || title.length > 500) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source metadata exceeds the allowed size."
    );
  }
  if (payload.tabs.length > 500) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source contains too many tabs."
    );
  }
  const tabIds = new Set<string>();
  const tabOrders = new Set<number>();
  let hasReadableParagraph = false;
  for (const tab of payload.tabs) {
    const tabId = tab.sourceTabId.trim();
    if (
      !tabId ||
      tabId.length > 255 ||
      tabIds.has(tabId) ||
      !Number.isInteger(tab.tabOrder) ||
      tab.tabOrder < 0 ||
      tabOrders.has(tab.tabOrder) ||
      tab.title.length > 500 ||
      tab.paragraphs.length > 10_000 ||
      tab.paragraphs.some(paragraph => String(paragraph ?? "").length > 200_000)
    ) {
      throw new WorkspaceEditorialDraftError(
        "SOURCE_INVALID",
        "Source tab identity/order or size is invalid."
      );
    }
    if (
      tab.paragraphs.some(paragraph =>
        Boolean(normalizeEditorialText(String(paragraph ?? "")))
      )
    ) {
      hasReadableParagraph = true;
    }
    tabIds.add(tabId);
    tabOrders.add(tab.tabOrder);
  }
  if (!hasReadableParagraph) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source contained no readable paragraphs."
    );
  }
  return {
    ...payload,
    sourceKey,
    mimeType,
    title,
    providerDocumentId: payload.providerDocumentId?.trim() || null,
  };
}

async function loadLatestDraft(db: any, workItemId: number) {
  const [draft] = await db
    .select()
    .from(workspaceEditorialDrafts)
    .where(eq(workspaceEditorialDrafts.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialDrafts.version),
      desc(workspaceEditorialDrafts.id)
    )
    .limit(1);
  return draft ?? null;
}

async function loadLatestSourceSnapshot(db: any, sourceId: number) {
  const [snapshot] = await db
    .select()
    .from(workspaceEditorialSourceSnapshots)
    .where(eq(workspaceEditorialSourceSnapshots.sourceId, sourceId))
    .orderBy(
      desc(workspaceEditorialSourceSnapshots.createdAt),
      desc(workspaceEditorialSourceSnapshots.id)
    )
    .limit(1);
  return snapshot ?? null;
}

async function persistDraftDocument(
  tx: any,
  input: {
    workItemId: number;
    sourceSnapshotId: number;
    parentDraftId: number | null;
    version: number;
    origin: "source_import" | "source_refresh";
    actorUserId: number;
    pipelineVersion: ReturnType<typeof runEditorialPreparationPipeline>[number];
  }
) {
  const draftId = insertId(
    await tx.insert(workspaceEditorialDrafts).values({
      workItemId: input.workItemId,
      sourceSnapshotId: input.sourceSnapshotId,
      parentDraftId: input.parentDraftId,
      version: input.version,
      origin: input.origin,
      transformCode: input.pipelineVersion.transformCode,
      draftSha256: input.pipelineVersion.afterSha256,
      presentationJson: JSON.stringify(EDITORIAL_DRAFT_PRESENTATION),
      warningsJson: JSON.stringify(input.pipelineVersion.document.warnings),
      createdByUserId: input.actorUserId,
    })
  );

  for (const tab of input.pipelineVersion.document.tabs) {
    const draftTabId = insertId(
      await tx.insert(workspaceEditorialDraftTabs).values({
        draftId,
        sourceTabId: tab.sourceTabId,
        tabOrder: tab.tabOrder,
        title: tab.title,
        fingerprintSequenceJson: JSON.stringify(tab.fingerprintSequence),
        structuralSha256: tab.structuralSha256,
        chapterNumber: tab.chapterNumber,
        chapterTitle: tab.chapterTitle,
        warningsJson: JSON.stringify(tab.warnings),
      })
    );
    if (tab.paragraphs.length) {
      await tx.insert(workspaceEditorialDraftParagraphs).values(
        tab.paragraphs.map(paragraph => ({
          draftTabId,
          paragraphKey: paragraph.paragraphKey,
          sourceParagraphIndex: paragraph.sourceParagraphIndex,
          paragraphOrder: paragraph.paragraphOrder,
          text: paragraph.text,
          sourceParagraphFingerprint: paragraph.sourceParagraphFingerprint,
          sourceOccurrenceCount: paragraph.sourceOccurrenceCount,
          sourceOccurrenceOrdinal: paragraph.sourceOccurrenceOrdinal,
          paragraphFingerprint: paragraph.paragraphFingerprint,
          occurrenceCount: paragraph.occurrenceCount,
          occurrenceOrdinal: paragraph.occurrenceOrdinal,
        }))
      );
    }
  }

  await tx.insert(workspaceEditorialDraftTransforms).values({
    draftId,
    parentDraftId: input.parentDraftId,
    transformCode: input.pipelineVersion.transformCode,
    beforeSha256: input.pipelineVersion.beforeSha256,
    afterSha256: input.pipelineVersion.afterSha256,
    detailsJson: JSON.stringify(input.pipelineVersion.details),
    actorUserId: input.actorUserId,
  });
  return draftId;
}

export async function importEditorialSource(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  payload: EditorialSourcePayload;
  googleConnectionId?: number | null;
  /**
   * Explicit source replacement for callers that have already proven the
   * target work item is the same canonical business identity (e.g. Master
   * Intake sync of a re-issued translation document). The conflicting
   * active source row is transitioned to status "removed" — never deleted —
   * so provenance/snapshots stay auditable, and exactly one active source
   * (the incoming one) remains afterwards.
   */
  replaceActiveSource?: boolean;
  /**
   * Preview-observed active source identities (`<sourceKind>:<sourceKey>`,
   * canonicalized) that authorize an explicit replacement. When provided,
   * the mutation transaction re-reads the current active sources (the work
   * item row is already locked FOR UPDATE at this point) and refuses with
   * STALE_PREVIEW — zero mutation — if the state drifted. Mandatory
   * whenever replaceActiveSource is requested: the boolean alone never
   * authorizes replacing a source the operator did not review.
   */
  expectedActiveSourceKeys?: string[];
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const payload = normalizeSourcePayload(input.payload);
  if (payload.sourceKind === "google_doc" && !input.googleConnectionId) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Google Docs imports require a durable Google connection identity."
    );
  }
  const sourceSha256 = sourcePayloadSha256(payload);
  const rawContentJson = JSON.stringify(payload);
  if (Buffer.byteLength(rawContentJson, "utf8") > 20_000_000) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source payload exceeded the 20 MB import limit."
    );
  }
  const revisionKey = payload.revisionKey?.trim() || sourceSha256;
  if (revisionKey.length > 255) {
    throw new WorkspaceEditorialDraftError(
      "SOURCE_INVALID",
      "Source revision identity exceeds the allowed size."
    );
  }

  const result = await db.transaction(async (tx: any) => {
    const [lockedWorkItem] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!lockedWorkItem) {
      throw new WorkspaceEditorialDraftError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was removed before source import could start."
      );
    }

    const activeSources = await tx
      .select()
      .from(workspaceEditorialSources)
      .where(
        and(
          eq(workspaceEditorialSources.workItemId, input.workItemId),
          eq(workspaceEditorialSources.status, "active")
        )
      );

    // R2 TOCTOU guard: compare the preview-observed active source state
    // against the state re-read INSIDE this mutation transaction (the work
    // item row is locked FOR UPDATE above, so this read + the mutations
    // below are atomic against concurrent source changes). Runs before ANY
    // source mutation: drift => STALE_PREVIEW => zero mutation.
    const expectedKeys =
      input.expectedActiveSourceKeys === undefined
        ? null
        : canonicalizeActiveSourceKeys(input.expectedActiveSourceKeys);
    if (expectedKeys !== null) {
      const currentKeys = canonicalizeActiveSourceKeys(
        activeSources.map(
          (source: any) => `${String(source.sourceKind)}:${String(source.sourceKey)}`
        )
      );
      if (currentKeys.join("|") !== expectedKeys.join("|")) {
        throw new WorkspaceEditorialDraftError(
          "STALE_PREVIEW",
          "Observed active source state changed after preview. Preview again before syncing."
        );
      }
    }

    const conflictingActiveSources = activeSources.filter(
      (source: any) =>
        source.sourceKind !== payload.sourceKind ||
        source.sourceKey !== payload.sourceKey
    );
    if (conflictingActiveSources.length > 0) {
      if (!input.replaceActiveSource) {
        throw new WorkspaceEditorialDraftError(
          "SOURCE_CONFLICT",
          "This work item already has another active source. Remove or explicitly replace it before changing source identity."
        );
      }
      if (expectedKeys === null) {
        // A boolean alone never authorizes replacing a source the operator
        // did not review.
        throw new WorkspaceEditorialDraftError(
          "STALE_PREVIEW",
          "Source replacement requires the preview-observed active source state."
        );
      }
      if (expectedKeys.length > 1) {
        // Legacy multiple-active state is never silently normalized — the
        // ambiguity must be resolved manually before a bulk replacement.
        throw new WorkspaceEditorialDraftError(
          "SOURCE_CONFLICT",
          "Work item has multiple active sources; resolve the ambiguity manually before replacing."
        );
      }
      // Explicit replacement: transition the old active source(s) to
      // "removed" (row + snapshots stay for audit), then re-resolve the
      // candidate row for the incoming source identity in ANY status — a
      // previously removed row for the same document may exist and must be
      // reactivated instead of violating the unique index.
      await tx
        .update(workspaceEditorialSources)
        .set({ status: "removed", updatedAt: new Date() })
        .where(
          inArray(
            workspaceEditorialSources.id,
            conflictingActiveSources.map((source: any) => source.id)
          )
        );
      const [replacementCandidate] = await tx
        .select()
        .from(workspaceEditorialSources)
        .where(
          and(
            eq(workspaceEditorialSources.workItemId, input.workItemId),
            eq(workspaceEditorialSources.sourceKind, payload.sourceKind),
            eq(workspaceEditorialSources.sourceKey, payload.sourceKey)
          )
        )
        .limit(1);
      activeSources.length = 0;
      if (replacementCandidate) activeSources.push(replacementCandidate);
    }

    let source = activeSources[0] ?? null;
    if (!source) {
      const sourceId = insertId(
        await tx.insert(workspaceEditorialSources).values({
          workItemId: input.workItemId,
          sourceKind: payload.sourceKind,
          sourceKey: payload.sourceKey,
          providerDocumentId: payload.providerDocumentId,
          googleConnectionId: payload.sourceKind === "google_doc" ? (input.googleConnectionId ?? null) : null,
          mimeType: payload.mimeType,
          title: payload.title,
          status: "active",
          createdByUserId: input.actorUserId,
        })
      );
      [source] = await tx
        .select()
        .from(workspaceEditorialSources)
        .where(eq(workspaceEditorialSources.id, sourceId))
        .limit(1);
    } else {
      if (
        payload.sourceKind === "google_doc" &&
        source.googleConnectionId &&
        input.googleConnectionId &&
        source.googleConnectionId !== input.googleConnectionId
      ) {
        throw new WorkspaceEditorialDraftError(
          "SOURCE_CONFLICT",
          "This Google Docs source is already bound to a different durable connection identity."
        );
      }
      await tx
        .update(workspaceEditorialSources)
        .set({
          providerDocumentId: payload.providerDocumentId,
          googleConnectionId: payload.sourceKind === "google_doc"
            ? (input.googleConnectionId ?? source.googleConnectionId ?? null)
            : null,
          mimeType: payload.mimeType,
          title: payload.title,
          // Reactivates a previously removed row re-resolved during explicit
          // replacement; a no-op for rows that were already active.
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(workspaceEditorialSources.id, source.id));
    }
    if (!source) {
      throw new WorkspaceEditorialDraftError(
        "DATABASE_UNAVAILABLE",
        "Editorial source could not be resolved."
      );
    }

    const previousLatestSnapshot = await loadLatestSourceSnapshot(
      tx,
      source.id
    );
    const [sameRevision] = await tx
      .select()
      .from(workspaceEditorialSourceSnapshots)
      .where(
        and(
          eq(workspaceEditorialSourceSnapshots.sourceId, source.id),
          eq(workspaceEditorialSourceSnapshots.revisionKey, revisionKey)
        )
      )
      .limit(1);
    if (sameRevision && sameRevision.sourceSha256 !== sourceSha256) {
      throw new WorkspaceEditorialDraftError(
        "SOURCE_REVISION_CONFLICT",
        "The same source revision identity returned different content."
      );
    }

    let sourceSnapshot = sameRevision ?? null;
    let snapshotCreated = false;
    if (!sourceSnapshot) {
      const snapshotId = insertId(
        await tx.insert(workspaceEditorialSourceSnapshots).values({
          sourceId: source.id,
          revisionKey,
          sourceSha256,
          rawContentJson,
          byteLength: Buffer.byteLength(rawContentJson, "utf8"),
          createdByUserId: input.actorUserId,
        })
      );
      [sourceSnapshot] = await tx
        .select()
        .from(workspaceEditorialSourceSnapshots)
        .where(eq(workspaceEditorialSourceSnapshots.id, snapshotId))
        .limit(1);
      snapshotCreated = true;
    }
    if (!sourceSnapshot) {
      throw new WorkspaceEditorialDraftError(
        "DATABASE_UNAVAILABLE",
        "Editorial source snapshot could not be resolved."
      );
    }

    const latestDraft = await loadLatestDraft(tx, input.workItemId);
    if (
      latestDraft &&
      latestDraft.sourceSnapshotId === sourceSnapshot.id &&
      !snapshotCreated
    ) {
      return {
        sourceId: source.id,
        sourceSnapshotId: sourceSnapshot.id,
        snapshotCreated: false,
        draftCreated: false,
        refreshBlocked: false,
        latestDraftId: latestDraft.id,
        latestDraftVersion: latestDraft.version,
        reason: "SOURCE_UNCHANGED" as const,
      };
    }
    if (
      latestDraft &&
      previousLatestSnapshot &&
      snapshotCreated &&
      previousLatestSnapshot.sourceSha256 === sourceSnapshot.sourceSha256 &&
      latestDraft.sourceSnapshotId === previousLatestSnapshot.id
    ) {
      return {
        sourceId: source.id,
        sourceSnapshotId: sourceSnapshot.id,
        snapshotCreated: true,
        draftCreated: false,
        refreshBlocked: false,
        latestDraftId: latestDraft.id,
        latestDraftVersion: latestDraft.version,
        reason: "SOURCE_CONTENT_UNCHANGED" as const,
      };
    }

    const isNewSnapshot =
      !previousLatestSnapshot ||
      previousLatestSnapshot.id !== sourceSnapshot.id;
    let latestDraftSourceSnapshot: any = null;
    if (latestDraft) {
      [latestDraftSourceSnapshot] = await tx
        .select()
        .from(workspaceEditorialSourceSnapshots)
        .where(
          eq(workspaceEditorialSourceSnapshots.id, latestDraft.sourceSnapshotId)
        )
        .limit(1);
    }
    const draftAlreadyBehindSource =
      Boolean(latestDraft) &&
      Boolean(previousLatestSnapshot) &&
      (!latestDraftSourceSnapshot ||
        latestDraftSourceSnapshot.sourceSha256 !==
          previousLatestSnapshot.sourceSha256);
    const hasManualDraft = latestDraft?.origin === "manual";
    if (
      latestDraft &&
      isNewSnapshot &&
      (hasManualDraft || draftAlreadyBehindSource)
    ) {
      return {
        sourceId: source.id,
        sourceSnapshotId: sourceSnapshot.id,
        snapshotCreated,
        draftCreated: false,
        refreshBlocked: true,
        latestDraftId: latestDraft.id,
        latestDraftVersion: latestDraft.version,
        reason: hasManualDraft
          ? ("MANUAL_DRAFT_PRESENT" as const)
          : ("SOURCE_REFRESH_PENDING" as const),
      };
    }

    const pipeline = runEditorialPreparationPipeline(payload);
    let parentDraftId = latestDraft?.id ?? null;
    let version = Number(latestDraft?.version ?? 0);
    const origin = latestDraft
      ? ("source_refresh" as const)
      : ("source_import" as const);
    const createdDraftIds: number[] = [];

    for (const pipelineVersion of pipeline) {
      version += 1;
      const draftId = await persistDraftDocument(tx, {
        workItemId: input.workItemId,
        sourceSnapshotId: sourceSnapshot.id,
        parentDraftId,
        version,
        origin,
        actorUserId: input.actorUserId,
        pipelineVersion,
      });
      createdDraftIds.push(draftId);
      parentDraftId = draftId;
    }

    return {
      sourceId: source.id,
      sourceSnapshotId: sourceSnapshot.id,
      snapshotCreated,
      draftCreated: createdDraftIds.length > 0,
      refreshBlocked: false,
      createdDraftIds,
      latestDraftId: parentDraftId,
      latestDraftVersion: version,
      reason: latestDraft
        ? ("SOURCE_REFRESH_APPLIED" as const)
        : ("SOURCE_IMPORTED" as const),
    };
  });

  return result;
}

export async function getEditorialDraftReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  /** IPE-PLUGIN-001D-R2: set by server/plugin wiring only - never client input. */
  accessPolicy?: EditorialAccessPolicy;
}) {
  const db = await database();
  const work = await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId,
    input.accessPolicy ?? "workspace_route"
  );
  const sources = await db
    .select()
    .from(workspaceEditorialSources)
    .where(
      and(
        eq(workspaceEditorialSources.workItemId, input.workItemId),
        eq(workspaceEditorialSources.status, "active")
      )
    )
    .orderBy(asc(workspaceEditorialSources.id));

  const latestDraft = await loadLatestDraft(db, input.workItemId);
  const snapshotRows = sources.length
    ? await db
        .select()
        .from(workspaceEditorialSourceSnapshots)
        .where(eq(workspaceEditorialSourceSnapshots.sourceId, sources[0].id))
        .orderBy(
          desc(workspaceEditorialSourceSnapshots.createdAt),
          desc(workspaceEditorialSourceSnapshots.id)
        )
    : [];
  let tabs: any[] = [];
  let paragraphsByTab = new Map<number, any[]>();
  let transforms: any[] = [];
  if (latestDraft) {
    tabs = await db
      .select()
      .from(workspaceEditorialDraftTabs)
      .where(eq(workspaceEditorialDraftTabs.draftId, latestDraft.id))
      .orderBy(asc(workspaceEditorialDraftTabs.tabOrder));
    for (const tab of tabs) {
      const paragraphs = await db
        .select()
        .from(workspaceEditorialDraftParagraphs)
        .where(eq(workspaceEditorialDraftParagraphs.draftTabId, tab.id))
        .orderBy(asc(workspaceEditorialDraftParagraphs.paragraphOrder));
      paragraphsByTab.set(tab.id, paragraphs);
    }
    transforms = await db
      .select()
      .from(workspaceEditorialDraftTransforms)
      .innerJoin(
        workspaceEditorialDrafts,
        eq(
          workspaceEditorialDraftTransforms.draftId,
          workspaceEditorialDrafts.id
        )
      )
      .where(eq(workspaceEditorialDrafts.workItemId, input.workItemId))
      .orderBy(
        desc(workspaceEditorialDrafts.version),
        desc(workspaceEditorialDraftTransforms.id)
      );
  }

  const newestSnapshot = snapshotRows[0] ?? null;
  const draftSourceSnapshot = latestDraft
    ? (snapshotRows.find(
        (snapshot: any) => snapshot.id === latestDraft.sourceSnapshotId
      ) ?? null)
    : null;
  return {
    workItem: work.workItem,
    source: sources[0] ?? null,
    snapshots: snapshotRows.map((snapshot: any) => ({
      id: snapshot.id,
      revisionKey: snapshot.revisionKey,
      sourceSha256: snapshot.sourceSha256,
      byteLength: snapshot.byteLength,
      createdAt: snapshot.createdAt,
    })),
    latestDraft,
    refreshPending: Boolean(
      newestSnapshot &&
      latestDraft &&
      draftSourceSnapshot &&
      newestSnapshot.sourceSha256 !== draftSourceSnapshot.sourceSha256
    ),
    presentation: latestDraft
      ? JSON.parse(latestDraft.presentationJson)
      : EDITORIAL_DRAFT_PRESENTATION,
    tabs: tabs.map(tab => ({
      ...tab,
      fingerprintSequence: JSON.parse(tab.fingerprintSequenceJson),
      warnings: JSON.parse(tab.warningsJson),
      paragraphs: paragraphsByTab.get(tab.id) ?? [],
    })),
    transforms: transforms.map((row: any) => ({
      ...row.workspaceEditorialDraftTransforms,
      draftVersion: row.workspaceEditorialDrafts.version,
    })),
  };
}

export async function getEditorialSourceSnapshot(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  snapshotId: number;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const [snapshot] = await db
    .select({
      snapshot: workspaceEditorialSourceSnapshots,
      source: workspaceEditorialSources,
    })
    .from(workspaceEditorialSourceSnapshots)
    .innerJoin(
      workspaceEditorialSources,
      eq(
        workspaceEditorialSourceSnapshots.sourceId,
        workspaceEditorialSources.id
      )
    )
    .where(
      and(
        eq(workspaceEditorialSourceSnapshots.id, input.snapshotId),
        eq(workspaceEditorialSources.workItemId, input.workItemId)
      )
    )
    .limit(1);
  if (!snapshot) {
    throw new WorkspaceEditorialDraftError(
      "SNAPSHOT_NOT_FOUND",
      "Editorial source snapshot was not found."
    );
  }
  return {
    source: snapshot.source,
    snapshot: {
      id: snapshot.snapshot.id,
      revisionKey: snapshot.snapshot.revisionKey,
      sourceSha256: snapshot.snapshot.sourceSha256,
      byteLength: snapshot.snapshot.byteLength,
      createdAt: snapshot.snapshot.createdAt,
    },
    payload: JSON.parse(
      snapshot.snapshot.rawContentJson
    ) as EditorialSourcePayload,
  };
}
