import { describe, expect, it } from "vitest";
import {
  EDITORIAL_IDENTITY_CONTRACT_VERSION,
  classifyEditorialChapterNumber,
  editorialCheckerRunIdentity,
  editorialSourceTabSnapshotFingerprint,
  editorialStableSourceTabIdentity,
  editorialStagedEpisodeItemKey,
  isRangeShapedChapterNumber,
  parseEditorialStagedEpisodeItemKey,
} from "./editorialIdentityContract.domain";

describe("Editorial identity contract", () => {
  it("classifies single integer chapter numbers as canonical staging identity", () => {
    expect(classifyEditorialChapterNumber("12")).toEqual({
      kind: "single",
      raw: "12",
      singleNumber: "12",
      range: null,
      rangeShaped: false,
    });
    expect(classifyEditorialChapterNumber("012")?.kind).toBe("single");
    expect(classifyEditorialChapterNumber("012")?.rangeShaped).toBe(false);
  });

  it("classifies the hyphen form as the canonical pack range", () => {
    const classified = classifyEditorialChapterNumber("001-030");
    expect(classified.kind).toBe("range");
    expect(classified.rangeShaped).toBe(true);
    expect(classified.singleNumber).toBeNull();
    expect(classified.range).toEqual({ start: 1, end: 30 });
    expect(isRangeShapedChapterNumber("001-030")).toBe(true);
  });

  it("marks dot/dash range forms as range-shaped but NON-canonical draft metadata", () => {
    for (const nonCanonical of ["1..30", "1...30", "001—030", "001 – 030"]) {
      const classified = classifyEditorialChapterNumber(nonCanonical);
      // Range-shaped: never mistaken for a canonical single chapter.
      expect(classified.rangeShaped).toBe(true);
      expect(classified.singleNumber).toBeNull();
      expect(classified.kind).toBe("unparseable");
      // Non-canonical: no bounds parsed, staging keeps refusing it.
      expect(classified.range).toBeNull();
      expect(classified.kind).not.toBe("range");
    }
  });

  it("classifies unreadable or empty metadata as fail-closed unparseable (not range-shaped)", () => {
    expect(classifyEditorialChapterNumber(null)).toMatchObject({
      kind: "unparseable",
      rangeShaped: false,
    });
    expect(classifyEditorialChapterNumber("")).toMatchObject({
      kind: "unparseable",
      rangeShaped: false,
    });
    expect(classifyEditorialChapterNumber("ชื่อตอนเฉย ๆ")).toMatchObject({
      kind: "unparseable",
      rangeShaped: false,
    });
    expect(classifyEditorialChapterNumber("Chapter 20")).toMatchObject({
      kind: "unparseable",
      rangeShaped: false,
    });
  });

  it("keeps the staged episode item key bound to stageId+episodeId, never a display title", () => {
    const key = editorialStagedEpisodeItemKey(93, 4021);
    expect(key).toBe("editorial-stage:93:episode:4021");
    expect(parseEditorialStagedEpisodeItemKey(key)).toEqual({
      editorial: true,
      stageId: 93,
      episodeId: 4021,
    });
    expect(
      parseEditorialStagedEpisodeItemKey("editorial-stage:abc:episode:1")
    ).toBeNull();
    expect(parseEditorialStagedEpisodeItemKey("episode:93:4021")).toBeNull();
    // Row identities must be positive integers (legacy parser semantics).
    expect(
      parseEditorialStagedEpisodeItemKey("editorial-stage:0:episode:5")
    ).toBeNull();
    expect(
      parseEditorialStagedEpisodeItemKey("editorial-stage:93:episode:0")
    ).toBeNull();
  });

  it("binds the checker-run identity component to run identity so stale open=0 can never look current", () => {
    const base = {
      runId: 7,
      draftId: 42,
      engineVersion: "workspace-editorial-foreign-checker-v9",
      allowListSha256: "a".repeat(64),
    };
    const current = editorialCheckerRunIdentity(base);
    const staleDraft = editorialCheckerRunIdentity({
      ...base,
      draftId: 43,
    });
    const staleEngine = editorialCheckerRunIdentity({
      ...base,
      engineVersion: "next",
    });
    const staleAllowList = editorialCheckerRunIdentity({
      ...base,
      allowListSha256: "b".repeat(64),
    });
    expect(current.identitySha256).not.toBe(staleDraft.identitySha256);
    expect(current.identitySha256).not.toBe(staleEngine.identitySha256);
    expect(current.identitySha256).not.toBe(staleAllowList.identitySha256);
    expect(current.layer).toBe("qc_evidence");
  });

  it("keeps stable source-tab identity immune to reorder and metadata changes, while the snapshot fingerprint tracks them", () => {
    const base = {
      sourceTabId: "tab-1",
      tabOrder: 0,
      chapterNumber: "12",
      chapterTitle: "ชื่อบท",
    };
    // Stable identity: sourceTabId only.
    const identity = editorialStableSourceTabIdentity({
      sourceTabId: base.sourceTabId,
    });
    expect(
      editorialStableSourceTabIdentity({ sourceTabId: "tab-1" })
    ).toBe(identity);
    expect(
      editorialStableSourceTabIdentity({ sourceTabId: "tab-2" })
    ).not.toBe(identity);

    // Snapshot fingerprint: expected to change on reorder / retitle /
    // renumber — change detection, not identity.
    const snapshot = editorialSourceTabSnapshotFingerprint(base);
    expect(
      editorialSourceTabSnapshotFingerprint({ ...base, tabOrder: 3 })
    ).not.toBe(snapshot);
    expect(
      editorialSourceTabSnapshotFingerprint({ ...base, chapterNumber: "13" })
    ).not.toBe(snapshot);
    expect(
      editorialSourceTabSnapshotFingerprint({ ...base, chapterTitle: "ชื่อใหม่" })
    ).not.toBe(snapshot);
    expect(
      editorialSourceTabSnapshotFingerprint(base)
    ).toBe(snapshot);
    expect(EDITORIAL_IDENTITY_CONTRACT_VERSION).toBe(
      "workspace-editorial-identity-contract-v1"
    );
  });
});
