import { createHash } from "node:crypto";

/**
 * Canonical Editorial Identity Contract (IPE-058-A).
 *
 * This module documents and classifies the identity layers that flow through
 * the Workspace editorial pipeline. It is pure: no DB, no service imports.
 * It does NOT replace the parsers in editorialDraft/approval domains — it
 * classifies their outputs so layers cannot silently substitute one identity
 * for another (e.g. a range-shaped display string for a canonical chapter
 * number, or a mutable display title for a staged episode key).
 *
 * Pipeline: work item → source tab → draft → paragraph identity → checker run
 * → checker currentness → QC evidence → approval → stage plan → staged episode.
 *
 * Layer-by-layer identity semantics:
 *
 * 1. Work item identity
 *    - `workItemId` (DB row) owns one draft and one latest approval.
 *    - `episodeNumber` on the work item is the COMMERCE range string, e.g.
 *      "001-030". It describes which episodes the pack sells — it is NEVER a
 *      chapter number of any tab.
 *
 * 2. Source tab identity
 *    - `sourceTabId` is the stable provider/source identity assigned at
 *      intake. It MUST NOT be derived from the tab title or any display text.
 *    - `tabOrder` is presentation/source ordering only. Batch→stage mapping
 *      is by detected episode number, never by tabOrder.
 *
 * 3. Paragraph identity
 *    - Intake key: sha256 over ("workspace-editorial-paragraph-key-v1",
 *      sourceTabId, 1-based source position, sourceParagraphFingerprint,
 *      occurrence ordinal). Position-anchored at intake; the stored key is
 *      then carried through and preserved by reindex.
 *    - In-place text edit: paragraphKey preserved, paragraphFingerprint
 *      recomputed (findings are guarded by expected fingerprint).
 *    - Split: pieces get new keys derived from the original key
 *      ("workspace-editorial-paragraph-split-v1" + pieceIndex + text).
 *    - Whole-tab rewrite (KNOWN IDENTITY DEFECT, to reconcile in IPE-058-B):
 *      applyEditorialTabEdit pairs replacement paragraphs to previous
 *      paragraphs PURELY BY POSITION and carries `previous?.paragraphKey`
 *      forward WITHOUT checking text equality. When a paragraph is inserted
 *      mid-tab, the NEW text at that position INHERITS the key of the old
 *      paragraph, and the old (shifted) paragraph is re-keyed. paragraphKey
 *      is therefore position-stable but NOT text-stable under a whole-tab
 *      rewrite: finding states and anomaly confirmations keyed by
 *      paragraphKey can attach to the wrong paragraph. This is locked by a
 *      regression test in editorialEditor.domain.test.ts and must be
 *      reconciled before any consumer relies on paragraphKey across a tab
 *      rewrite.
 *
 * 4. Chapter identity
 *    - `chapterNumber`/`chapterTitle` stored on the draft TAB are parsed from
 *      the first heading-like PARAGRAPH (not the tab title) by
 *      reindexEditorialDraftDocument. They are parsed-heading metadata, not
 *      canonical identity by themselves.
 *    - The draft parser ACCEPTS range-shaped headings ("บทที่ 001-030",
 *      "1..30") and stores the raw string. Range semantics are split (see
 *      classifyEditorialChapterNumber): the canonical pack range is the
 *      hyphen form ("001-030"); dot/em-dash forms ("1..30") are
 *      range-shaped but non-canonical draft metadata; NEITHER ever acts as a
 *      canonical single chapter number. Downstream staging layers refuse
 *      every range-shaped form and fail closed instead.
 *
 * 5. Checker run / QC evidence / approval
 *    - A checker run is current only when run.draftId === current draftId,
 *      run.engineVersion === current engine version, and
 *      run.allowListSha256 === recomputed allow-list hash. An empty finding
 *      set (open=0) does NOT make a stale run current.
 *    - The production QC evidence hash
 *      (editorialQcEvidenceSha256 in editorialApproval.domain) binds the run
 *      identity PLUS the per-finding/anomaly disposition set. The helper
 *      below, editorialCheckerRunIdentity, captures ONLY the run/currentness
 *      identity component (runId + draftId + engineVersion + allowListSha256)
 *      and deliberately does NOT reproduce the full evidence hash.
 *    - Approval is hash-chained: draftSha256 → qcEvidenceSha256 →
 *      approvalPayloadSha256 → stage payload hashes → stageSetSha256.
 *
 * 6. Staged episode identity
 *    - The stage row is keyed by (approvalId, episodeNumber-canonical) in the
 *      DB and by the publish item key below in publish execution. The key is
 *      stageId+episodeId (immutable row identities) — NEVER the mutable
 *      display title.
 *    - Ownership/drift/idempotency protections are unchanged by this contract
 *      and remain fail-closed (see editorialApproval.service / publish service).
 */

export const EDITORIAL_IDENTITY_CONTRACT_VERSION =
  "workspace-editorial-identity-contract-v1" as const;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Which layer an identity claim belongs to. */
export type EditorialIdentityLayer =
  | "work_item"
  | "source_tab"
  | "draft"
  | "paragraph"
  | "checker_run"
  | "qc_evidence"
  | "approval"
  | "stage_plan"
  | "staged_episode";

/** Classification of a chapter-number-shaped string found on any layer. */
export type EditorialChapterNumberKind =
  | "single"
  | "range"
  | "unparseable";

export type EditorialChapterNumberClassification = {
  kind: EditorialChapterNumberKind;
  /** Raw string as stored/observed on the layer. */
  raw: string | null;
  /** Canonical single-episode number, only when kind === "single". */
  singleNumber: string | null;
  /** Range bounds, only when kind === "range" (canonical hyphen form). */
  range: { start: number; end: number } | null;
  /**
   * True when the string is RANGE-SHAPED draft metadata in ANY tolerated
   * form (hyphen "001-030", dots "1..30", em-dash "001—030"). Range-shaped
   * values are pack/commerce or display scope and must NEVER act as a
   * canonical single chapter number. Only kind === "range" is canonical.
   */
  rangeShaped: boolean;
};

/**
 * Classify a chapterNumber-ish string.
 *
 * - kind "single": pure integer — the ONLY canonical chapter/staging identity.
 * - kind "range": canonical pack range in hyphen form ("001-030") —
 *   work-item/commerce scope, never a tab's chapter number.
 * - kind "unparseable" with rangeShaped=true: range-shaped but non-canonical
 *   draft metadata ("1..30", "001—030") — the draft parser may store it, but
 *   staging must keep refusing it (fail closed), never parse it loosely.
 * - kind "unparseable" with rangeShaped=false: truly unreadable — fail
 *   closed, never guess.
 */
export function classifyEditorialChapterNumber(
  value: string | null | undefined
): EditorialChapterNumberClassification {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return {
      kind: "unparseable",
      raw: null,
      singleNumber: null,
      range: null,
      rangeShaped: false,
    };
  }
  const rangeMatch = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
      return {
        kind: "range",
        raw,
        singleNumber: null,
        range: { start, end },
        rangeShaped: true,
      };
    }
    return {
      kind: "unparseable",
      raw,
      singleNumber: null,
      range: null,
      rangeShaped: true,
    };
  }
  // Non-canonical range-shaped draft metadata: dot ranges and em/en-dash
  // forms the draft chapterInfo parser tolerates. Deliberately NOT parsed
  // into bounds here — they are metadata-only and must not look canonical.
  // The draft layer normalizes these to hyphen form before storing
  // chapterNumber, but raw heading text may still carry them.
  const dashNormalized = raw.replace(/[–—]/g, "-");
  const dotNormalized = dashNormalized.replace(/\.{2,}/g, "-").replace(/\s+/g, "");
  if (
    dotNormalized !== raw &&
    /^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/.test(dotNormalized)
  ) {
    return {
      kind: "unparseable",
      raw,
      singleNumber: null,
      range: null,
      rangeShaped: true,
    };
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return {
      kind: "single",
      raw,
      singleNumber: raw,
      range: null,
      rangeShaped: false,
    };
  }
  return {
    kind: "unparseable",
    raw,
    singleNumber: null,
    range: null,
    rangeShaped: false,
  };
}

/** True when the string is range-shaped in ANY form (canonical or not). */
export function isRangeShapedChapterNumber(value: string | null | undefined) {
  return classifyEditorialChapterNumber(value).rangeShaped;
}

/** Canonical publish/stage item key format (mirrors editorialPublish.service). */
export const EDITORIAL_STAGE_ITEM_KEY_PREFIX = "editorial-stage" as const;

export function editorialStagedEpisodeItemKey(stageId: number, episodeId: number) {
  return `${EDITORIAL_STAGE_ITEM_KEY_PREFIX}:${stageId}:episode:${episodeId}`;
}

export type ParsedEditorialStagedEpisodeItemKey = {
  editorial: true;
  stageId: number;
  episodeId: number;
};

export function parseEditorialStagedEpisodeItemKey(
  value: string
): ParsedEditorialStagedEpisodeItemKey | null {
  const match = String(value || "").match(
    /^editorial-stage:(\d+):episode:(\d+)$/
  );
  if (!match) return null;
  const stageId = Number(match[1]);
  const episodeId = Number(match[2]);
  if (!Number.isSafeInteger(stageId) || !Number.isSafeInteger(episodeId)) {
    return null;
  }
  return { editorial: true, stageId, episodeId };
}

/**
 * STABLE source-tab identity. Hashes ONLY the provider/source identity
 * (`sourceTabId`) — the field the contract designates as the tab's stable
 * identity. Reordering tabs, retitling them, or changing parsed chapter
 * metadata must NEVER change this value.
 */
export function editorialStableSourceTabIdentity(input: {
  sourceTabId: string;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_IDENTITY_CONTRACT_VERSION,
      kind: "stable_source_tab_identity",
      layer: "source_tab" satisfies EditorialIdentityLayer,
      sourceTabId: input.sourceTabId,
    })
  );
}

/**
 * Source-tab SNAPSHOT fingerprint: a metadata projection hash covering the
 * mutable presentation/chapter fields (tabOrder, chapterNumber,
 * chapterTitle) scoped by sourceTabId. Unlike the stable identity above,
 * this fingerprint is EXPECTED to change when presentation order or chapter
 * metadata changes — that is its purpose (change detection), not identity.
 */
export function editorialSourceTabSnapshotFingerprint(input: {
  sourceTabId: string;
  tabOrder: number;
  chapterNumber: string | null;
  chapterTitle: string | null;
}) {
  return sha256(
    JSON.stringify({
      contract: EDITORIAL_IDENTITY_CONTRACT_VERSION,
      kind: "source_tab_snapshot_fingerprint",
      layer: "source_tab" satisfies EditorialIdentityLayer,
      sourceTabId: input.sourceTabId,
      tabOrder: input.tabOrder,
      chapterNumberKind: classifyEditorialChapterNumber(input.chapterNumber).kind,
      chapterNumber: input.chapterNumber,
      chapterTitle: input.chapterTitle,
    })
  );
}

/**
 * Checker-run / currentness identity component: binds the run identity
 * (runId + draftId + engineVersion + allowListSha256). This is NOT the
 * production QC evidence hash — the production
 * editorialQcEvidenceSha256 additionally binds the per-finding/anomaly
 * disposition set. This component exists to state the currentness
 * invariant: when the draft, engine, or allow-list identity drifts, the run
 * identity changes even for a run with zero findings, so open=0 can never
 * imply current.
 */
export function editorialCheckerRunIdentity(input: {
  runId: number;
  draftId: number;
  engineVersion: string;
  allowListSha256: string;
}) {
  return {
    layer: "qc_evidence" satisfies EditorialIdentityLayer,
    isCurrent: null as boolean | null,
    identitySha256: sha256(
      JSON.stringify({
        contract: EDITORIAL_IDENTITY_CONTRACT_VERSION,
        kind: "checker_run_identity",
        layer: "qc_evidence" satisfies EditorialIdentityLayer,
        runId: input.runId,
        draftId: input.draftId,
        engineVersion: input.engineVersion,
        allowListSha256: input.allowListSha256.toLowerCase(),
      })
    ),
  };
}
