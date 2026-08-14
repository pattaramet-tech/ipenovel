import { describe, expect, it, vi } from "vitest";
import {
  isMigratableManusCloudfrontUrl,
  isAlreadyMigratedSportsValue,
  downloadLegacyManusAsset,
  runLegacyManusAssetMigrationBatch,
  formatRowLabel,
  MANUS_CLOUDFRONT_HOSTNAME,
  LegacyAssetDownloadError,
  LegacyManusAssetMigrationConfigError,
  LegacyManusAssetMigrationLockError,
  type CandidateRow,
  type LegacyManusAssetMigrationDeps,
} from "./legacyManusAssetMigrationService";

const MANUS_URL = `https://${MANUS_CLOUDFRONT_HOSTNAME}/some/opaque/object-id`;

function bufferedResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": contentType } });
}

const REAL_JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const REAL_PDF_MAGIC = Buffer.from("%PDF-1.4\n%fake-pdf-body", "ascii");

function makeFullDeps(overrides: Partial<LegacyManusAssetMigrationDeps> = {}) {
  return {
    downloadFn: vi.fn(async () => ({ buffer: REAL_JPEG_MAGIC, contentType: "image/jpeg" })),
    putPrivateObjectFn: vi.fn(async (_context: any, key: string) => ({ key })),
    deletePrivateObjectFn: vi.fn(async () => {}),
    r2PutFn: vi.fn(async (key: string) => ({ key, url: `https://media.ipenovel.com/${key}` })),
    optimizeImageFn: vi.fn(async () => ({
      buffer: Buffer.from("webp-bytes"),
      contentType: "image/webp" as const,
      width: 100,
      height: 100,
    })),
    // Default: this CAS write always "wins" (source unchanged) - tests that
    // specifically exercise a lost CAS race override these to resolve false.
    updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => true),
    updateWalletTopupSlipUrlIfUnchangedFn: vi.fn(async () => true),
    updateSportsMatchImageUrlIfUnchangedFn: vi.fn(async () => true),
    isR2PrivateConfiguredFn: vi.fn(() => true),
    isR2ConfiguredFn: vi.fn(() => true),
    ...overrides,
  };
}

describe("isMigratableManusCloudfrontUrl - hostname validation", () => {
  it("1. accepts an exact Manus CloudFront https URL", () => {
    expect(isMigratableManusCloudfrontUrl(`https://${MANUS_CLOUDFRONT_HOSTNAME}/x`)).toBe(true);
  });

  it("2. rejects an arbitrary hostname", () => {
    expect(isMigratableManusCloudfrontUrl("https://example.com/x")).toBe(false);
    expect(isMigratableManusCloudfrontUrl("https://media.ipenovel.com/x")).toBe(false);
  });

  it("3. rejects a lookalike hostname (suffix attack)", () => {
    expect(isMigratableManusCloudfrontUrl(`https://${MANUS_CLOUDFRONT_HOSTNAME}.attacker.example/x`)).toBe(false);
  });

  it("3b. rejects a lookalike hostname (prefix/substring attack)", () => {
    expect(isMigratableManusCloudfrontUrl(`https://evil-${MANUS_CLOUDFRONT_HOSTNAME}/x`)).toBe(false);
    expect(isMigratableManusCloudfrontUrl(`https://notthe${MANUS_CLOUDFRONT_HOSTNAME}/x`)).toBe(false);
  });

  it("4. rejects http:// (https-only policy)", () => {
    expect(isMigratableManusCloudfrontUrl(`http://${MANUS_CLOUDFRONT_HOSTNAME}/x`)).toBe(false);
  });

  it("rejects r2p: references", () => {
    expect(isMigratableManusCloudfrontUrl("r2p:payment-slips/legacy/payments/1/x.jpg")).toBe(false);
  });

  it("15. fails safe on malformed/relative/empty values", () => {
    expect(isMigratableManusCloudfrontUrl("not a url")).toBe(false);
    expect(isMigratableManusCloudfrontUrl("/relative/path.png")).toBe(false);
    expect(isMigratableManusCloudfrontUrl("")).toBe(false);
    expect(isMigratableManusCloudfrontUrl(null)).toBe(false);
    expect(isMigratableManusCloudfrontUrl(undefined)).toBe(false);
  });
});

describe("downloadLegacyManusAsset - bounded hardened download", () => {
  it("rejects a non-Manus hostname before ever fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      downloadLegacyManusAsset("https://example.com/x.png", {
        allowedMimeTypes: new Set(["image/png"]),
        maxBytes: 1024,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: "HOSTNAME_MISMATCH" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("16. rejects an oversize payload declared via Content-Length", async () => {
    // A declared Content-Length over the ceiling is rejected before the
    // body is ever read - the actual body here is tiny, proving the header
    // check (not the streamed-byte check) is what caught it.
    const bigHeaderResponse = new Response(new Uint8Array(10), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) },
    });
    const fetchImpl = vi.fn(async () => bigHeaderResponse);
    await expect(
      downloadLegacyManusAsset(MANUS_URL, {
        allowedMimeTypes: new Set(["image/png"]),
        maxBytes: 1024,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: "TOO_LARGE" });
  });

  it("16b. rejects a payload that exceeds maxBytes while streaming (no Content-Length)", async () => {
    const bigBody = new Uint8Array(2048).fill(1);
    const response = new Response(bigBody, { status: 200, headers: { "content-type": "image/png" } });
    const fetchImpl = vi.fn(async () => response);
    await expect(
      downloadLegacyManusAsset(MANUS_URL, {
        allowedMimeTypes: new Set(["image/png"]),
        maxBytes: 1024,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: "TOO_LARGE" });
  });

  it("17. rejects an unsupported/invalid MIME type", async () => {
    const response = bufferedResponse(new Uint8Array(10), "text/html", 200);
    const fetchImpl = vi.fn(async () => response);
    await expect(
      downloadLegacyManusAsset(MANUS_URL, {
        allowedMimeTypes: new Set(["image/png", "image/jpeg"]),
        maxBytes: 1024,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: "UNSUPPORTED_TYPE" });
  });

  it("rejects a payload whose bytes don't match the declared Content-Type (magic-byte mismatch)", async () => {
    const fakeJpegBytes = Buffer.from("this is not actually a jpeg");
    const response = bufferedResponse(fakeJpegBytes, "image/jpeg", 200);
    const fetchImpl = vi.fn(async () => response);
    await expect(
      downloadLegacyManusAsset(MANUS_URL, {
        allowedMimeTypes: new Set(["image/jpeg"]),
        maxBytes: 1024,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: "UNSUPPORTED_TYPE" });
  });

  it("rejects a non-2xx response", async () => {
    const response = bufferedResponse(new Uint8Array(0), "image/png", 404);
    const fetchImpl = vi.fn(async () => response);
    await expect(
      downloadLegacyManusAsset(MANUS_URL, { allowedMimeTypes: new Set(["image/png"]), maxBytes: 1024, fetchImpl })
    ).rejects.toMatchObject({ reason: "NON_2XX_RESPONSE" });
  });

  it("accepts a real, correctly-typed JPEG payload", async () => {
    const response = bufferedResponse(REAL_JPEG_MAGIC, "image/jpeg", 200);
    const fetchImpl = vi.fn(async () => response);
    const result = await downloadLegacyManusAsset(MANUS_URL, {
      allowedMimeTypes: new Set(["image/jpeg"]),
      maxBytes: 1024,
      fetchImpl,
    });
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.equals(REAL_JPEG_MAGIC)).toBe(true);
  });

  it("accepts a real, correctly-typed PDF payload", async () => {
    const response = bufferedResponse(REAL_PDF_MAGIC, "application/pdf", 200);
    const fetchImpl = vi.fn(async () => response);
    const result = await downloadLegacyManusAsset(MANUS_URL, {
      allowedMimeTypes: new Set(["application/pdf"]),
      maxBytes: 1024,
      fetchImpl,
    });
    expect(result.contentType).toBe("application/pdf");
  });
});

describe("runLegacyManusAssetMigrationBatch", () => {
  it("5. already-private (r2p:) payment slip is skipped, never touched", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 1, value: "r2p:payment-slips/1/existing.jpg" }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.alreadyMigratedCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(deps.downloadFn).not.toHaveBeenCalled();
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).not.toHaveBeenCalled();
  });

  it("6. already-public (R2) sports image is skipped, never touched", async () => {
    const rows: CandidateRow[] = [
      { source: "sportsMatches", id: 7, column: "cover", value: "https://media.ipenovel.com/sports-matches/7/cover/x.webp" },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "sports", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.alreadyMigratedCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
    expect(deps.updateSportsMatchImageUrlIfUnchangedFn).not.toHaveBeenCalled();
  });

  it("an out-of-scope value (arbitrary external URL) is skipped, never touched", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 2, value: "https://docs.google.com/some/file" }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.outOfScopeCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).not.toHaveBeenCalled();
  });

  it("7. download failure leaves the DB row unchanged", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 3, value: MANUS_URL }];
    const deps = makeFullDeps({
      downloadFn: vi.fn(async () => {
        throw new LegacyAssetDownloadError("FETCH_FAILED");
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "failed", reason: "FETCH_FAILED" });
    expect(deps.putPrivateObjectFn).not.toHaveBeenCalled();
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).not.toHaveBeenCalled();
  });

  it("8. upload failure leaves the DB row unchanged", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 4, value: MANUS_URL }];
    const deps = makeFullDeps({
      putPrivateObjectFn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.failedCount).toBe(1);
    expect(result.results[0].outcome).toBe("failed");
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).not.toHaveBeenCalled();
  });

  it("9. successful private upload updates payment to an r2p: ref", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 5, value: MANUS_URL }];
    const deps = makeFullDeps({
      putPrivateObjectFn: vi.fn(async (_ctx: any, key: string) => ({ key })),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).toHaveBeenCalledTimes(1);
    const [paymentId, expectedCurrent, newRef] = (deps.updatePaymentSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(paymentId).toBe(5);
    expect(expectedCurrent).toBe(MANUS_URL);
    expect(newRef).toMatch(/^r2p:payment-slips\/legacy\/payments\/5\//);
  });

  it("10. successful private upload updates wallet top-up to an r2p: ref", async () => {
    const rows: CandidateRow[] = [{ source: "walletTopups", id: 6, value: MANUS_URL }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "wallet", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    expect(deps.updateWalletTopupSlipUrlIfUnchangedFn).toHaveBeenCalledTimes(1);
    const [topupId, expectedCurrent, ref] = (deps.updateWalletTopupSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(topupId).toBe(6);
    expect(expectedCurrent).toBe(MANUS_URL);
    expect(ref).toMatch(/^r2p:payment-slips\/legacy\/wallet-topups\/6\//);
  });

  it("11. successful sports upload updates ONLY the requested column", async () => {
    const rows: CandidateRow[] = [{ source: "sportsMatches", id: 8, column: "home", value: MANUS_URL }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "sports", limit: 10, column: "home" },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    expect(deps.updateSportsMatchImageUrlIfUnchangedFn).toHaveBeenCalledTimes(1);
    const [matchId, column, expectedCurrent, newUrl] = (deps.updateSportsMatchImageUrlIfUnchangedFn as any).mock.calls[0];
    expect(matchId).toBe(8);
    expect(column).toBe("homeTeamImageUrl");
    expect(expectedCurrent).toBe(MANUS_URL);
    expect(newUrl).toMatch(/^https:\/\/media\.ipenovel\.com\/sports-matches\/legacy\/8\/home\//);
  });

  it("12. dry-run performs zero DB writes and zero uploads", async () => {
    const rows: CandidateRow[] = [
      { source: "payments", id: 9, value: MANUS_URL },
      { source: "sportsMatches", id: 10, column: "cover", value: MANUS_URL },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "all", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.wouldMigrateCount).toBe(2);
    expect(deps.putPrivateObjectFn).not.toHaveBeenCalled();
    expect(deps.r2PutFn).not.toHaveBeenCalled();
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).not.toHaveBeenCalled();
    expect(deps.updateSportsMatchImageUrlIfUnchangedFn).not.toHaveBeenCalled();
    // dry-run still exercises download+decode to give an accurate preview.
    expect(deps.downloadFn).toHaveBeenCalledTimes(2);
  });

  it("12b. dry-run never requires R2 to be configured", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 11, value: MANUS_URL }];
    const deps = makeFullDeps({ isR2PrivateConfiguredFn: vi.fn(() => false), isR2ConfiguredFn: vi.fn(() => false) });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "all", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.wouldMigrateCount).toBe(1);
  });

  it("13. --limit is respected", async () => {
    const rows: CandidateRow[] = [
      { source: "payments", id: 1, value: MANUS_URL },
      { source: "payments", id: 2, value: MANUS_URL },
      { source: "payments", id: 3, value: MANUS_URL },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 2 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.eligibleCount).toBe(3);
    expect(result.processedCount).toBe(2);
    expect(result.remainingEligible).toBe(1);
    expect(deps.updatePaymentSlipUrlIfUnchangedFn).toHaveBeenCalledTimes(2);
  });

  it("14. --start-id is passed through to candidate discovery", async () => {
    const deps = makeFullDeps();
    const fetchCandidateRowsFn = vi.fn(async () => [] as CandidateRow[]);
    await runLegacyManusAssetMigrationBatch({ dryRun: true, type: "all", limit: 10, startId: 500 }, { ...deps, fetchCandidateRowsFn });
    expect(fetchCandidateRowsFn).toHaveBeenCalledWith("all", 500, undefined);
  });

  it("20. rerunning after a successful migration skips the now-already-migrated row safely", async () => {
    const deps = makeFullDeps();
    // First run: row is eligible (Manus hostname) and gets migrated.
    const firstRunRows: CandidateRow[] = [{ source: "payments", id: 12, value: MANUS_URL }];
    const firstResult = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => firstRunRows) }
    );
    expect(firstResult.migratedCount).toBe(1);
    const newRef: string = (deps.updatePaymentSlipUrlIfUnchangedFn as any).mock.calls[0][2];

    // Second run: the row now holds the r2p: ref the first run wrote -
    // simulates what a real rerun would see from the DB. It must be
    // classified already_migrated and never re-processed.
    const secondRunRows: CandidateRow[] = [{ source: "payments", id: 12, value: newRef }];
    const secondResult = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => secondRunRows) }
    );
    expect(secondResult.alreadyMigratedCount).toBe(1);
    expect(secondResult.eligibleCount).toBe(0);
    expect(secondResult.migratedCount).toBe(0);
  });

  it("throws LegacyManusAssetMigrationConfigError for a live run when R2 isn't configured", async () => {
    const deps = makeFullDeps({ isR2PrivateConfiguredFn: vi.fn(() => false) });
    await expect(
      runLegacyManusAssetMigrationBatch(
        { dryRun: false, type: "payments", limit: 10 },
        { ...deps, fetchCandidateRowsFn: vi.fn(async () => []) }
      )
    ).rejects.toBeInstanceOf(LegacyManusAssetMigrationConfigError);
  });

  it("throws LegacyManusAssetMigrationLockError when a run is already in progress", async () => {
    const deps = makeFullDeps();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowFetch = vi.fn(async () => {
      await gate;
      return [] as CandidateRow[];
    });
    const firstRun = runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "all", limit: 10 },
      { ...deps, fetchCandidateRowsFn: slowFetch }
    );
    await expect(
      runLegacyManusAssetMigrationBatch(
        { dryRun: true, type: "all", limit: 10 },
        { ...deps, fetchCandidateRowsFn: vi.fn(async () => []) }
      )
    ).rejects.toBeInstanceOf(LegacyManusAssetMigrationLockError);
    releaseFirst();
    await firstRun;
  });
});

describe("compare-and-swap protection against a stale source value (P1)", () => {
  it("payment source changes before final write -> CAS false -> not migrated, DB never overwritten", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 20, value: MANUS_URL }];
    const deps = makeFullDeps({
      // Simulates: between candidate discovery (row.value = MANUS_URL) and
      // this write, someone else changed payments.slipImageUrl - the CAS
      // WHERE clause no longer matches, so the real db.ts helper would
      // return false. The row must be reported failed, not migrated.
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => false),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "failed", reason: "SOURCE_CHANGED_OR_ROW_MISSING" });
    // The CAS call itself was still made with the ORIGINAL value read at
    // discovery time - it must never be called with anything else, and
    // never asked to overwrite unconditionally.
    const [, expectedCurrent] = (deps.updatePaymentSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(expectedCurrent).toBe(MANUS_URL);
  });

  it("wallet source changes before final write -> CAS false -> not migrated", async () => {
    const rows: CandidateRow[] = [{ source: "walletTopups", id: 21, value: MANUS_URL }];
    const deps = makeFullDeps({
      updateWalletTopupSlipUrlIfUnchangedFn: vi.fn(async () => false),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "wallet", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "failed", reason: "SOURCE_CHANGED_OR_ROW_MISSING" });
  });

  it("sports selected column changes before final write -> CAS false -> not migrated", async () => {
    const rows: CandidateRow[] = [{ source: "sportsMatches", id: 22, column: "cover", value: MANUS_URL }];
    const deps = makeFullDeps({
      updateSportsMatchImageUrlIfUnchangedFn: vi.fn(async () => false),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "sports", limit: 10, column: "cover" },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "failed", reason: "SOURCE_CHANGED_OR_ROW_MISSING" });
    // Sports has no delete primitive for Public R2 - the uploaded object is
    // an accepted, documented orphan, never a reason to change the outcome.
    const [matchId, column] = (deps.updateSportsMatchImageUrlIfUnchangedFn as any).mock.calls[0];
    expect(matchId).toBe(22);
    expect(column).toBe("coverImageUrl");
  });

  it("affectedRows=0 (CAS false) never produces migratedCount, across a mixed batch", async () => {
    const rows: CandidateRow[] = [
      { source: "payments", id: 30, value: MANUS_URL },
      { source: "payments", id: 31, value: MANUS_URL },
    ];
    let call = 0;
    const deps = makeFullDeps({
      // First row wins the CAS race, second loses it.
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => {
        call += 1;
        return call === 1;
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.results.find((r) => r.id === 30)?.outcome).toBe("migrated");
    expect(result.results.find((r) => r.id === 31)).toMatchObject({
      outcome: "failed",
      reason: "SOURCE_CHANGED_OR_ROW_MISSING",
    });
  });

  it("a lost CAS race best-effort deletes the just-uploaded PRIVATE R2 object (slips only)", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 32, value: MANUS_URL }];
    const deps = makeFullDeps({
      putPrivateObjectFn: vi.fn(async (_ctx: any, key: string) => ({ key })),
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => false),
    });
    await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(deps.deletePrivateObjectFn).toHaveBeenCalledTimes(1);
    const [context, deletedKey] = (deps.deletePrivateObjectFn as any).mock.calls[0];
    expect(context).toBe("paymentSlip");
    // The exact key just uploaded, nothing derived from the DB.
    const [, uploadedKey] = (deps.putPrivateObjectFn as any).mock.calls[0];
    expect(deletedKey).toBe(uploadedKey);
  });

  it("a failed best-effort cleanup delete never changes the reported outcome", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 33, value: MANUS_URL }];
    const deps = makeFullDeps({
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => false),
      deletePrivateObjectFn: vi.fn(async () => {
        throw new Error("cleanup boom");
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.results[0]).toMatchObject({ outcome: "failed", reason: "SOURCE_CHANGED_OR_ROW_MISSING" });
  });

  it("DB unavailable/write failure (CAS fn throws) never produces a migrated success", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 34, value: MANUS_URL }];
    const deps = makeFullDeps({
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async () => {
        throw new Error("Database not available");
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(0);
    expect(result.results[0].outcome).toBe("failed");
    // A thrown (not returned-false) DB failure gets the generic safe code,
    // never SOURCE_CHANGED_OR_ROW_MISSING (that's reserved for a genuine
    // lost CAS race) and never the raw "Database not available" text.
    expect(result.results[0].reason).toBe("UNKNOWN_ERROR");
  });
});

describe("raw vs normalized candidate values - CAS must use the exact raw DB value (P2-1)", () => {
  const WHITESPACE_RAW = `  ${MANUS_URL}  `;

  it("payment with leading/trailing whitespace: download uses the normalized URL, CAS receives the exact raw DB value, migration succeeds", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 40, value: MANUS_URL, rawValue: WHITESPACE_RAW }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );

    expect(result.migratedCount).toBe(1);
    // download() must be called with the NORMALIZED (trimmed) URL - the raw
    // value has leading/trailing spaces that would fail URL parsing/the
    // exact-hostname check.
    expect((deps.downloadFn as any).mock.calls[0][0]).toBe(MANUS_URL);
    // The CAS write must receive the EXACT raw DB value (untrimmed), never
    // the normalized one - a real `WHERE slipImageUrl = ?` only matches the
    // literal stored bytes.
    const [, expectedCurrent] = (deps.updatePaymentSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(expectedCurrent).toBe(WHITESPACE_RAW);
  });

  it("wallet with leading/trailing whitespace: same raw-value CAS behavior", async () => {
    const rows: CandidateRow[] = [{ source: "walletTopups", id: 41, value: MANUS_URL, rawValue: WHITESPACE_RAW }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "wallet", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );

    expect(result.migratedCount).toBe(1);
    expect((deps.downloadFn as any).mock.calls[0][0]).toBe(MANUS_URL);
    const [, expectedCurrent] = (deps.updateWalletTopupSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(expectedCurrent).toBe(WHITESPACE_RAW);
  });

  it("sports with leading/trailing whitespace: same raw-value CAS behavior", async () => {
    const rows: CandidateRow[] = [
      { source: "sportsMatches", id: 42, column: "cover", value: MANUS_URL, rawValue: WHITESPACE_RAW },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "sports", limit: 10, column: "cover" },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );

    expect(result.migratedCount).toBe(1);
    expect((deps.downloadFn as any).mock.calls[0][0]).toBe(MANUS_URL);
    const [, , expectedCurrent] = (deps.updateSportsMatchImageUrlIfUnchangedFn as any).mock.calls[0];
    expect(expectedCurrent).toBe(WHITESPACE_RAW);
  });

  it("a CAS write against the trimmed value (not the real raw DB value) would have lost the race - proving the fix matters", async () => {
    // Simulates the pre-fix bug directly: a CAS helper that only ever
    // succeeds when given the exact raw (untrimmed) value.
    const rows: CandidateRow[] = [{ source: "payments", id: 43, value: MANUS_URL, rawValue: WHITESPACE_RAW }];
    const deps = makeFullDeps({
      updatePaymentSlipUrlIfUnchangedFn: vi.fn(async (_id: number, expectedCurrent: string) => expectedCurrent === WHITESPACE_RAW),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    // Migrates successfully BECAUSE the CAS call now uses the raw value -
    // if it used the normalized value instead, this mock would return
    // false and the row would be reported failed.
    expect(result.migratedCount).toBe(1);
  });

  it("already-migrated/out-of-scope classification still uses the NORMALIZED value", async () => {
    const rows: CandidateRow[] = [
      // Whitespace around an already-migrated r2p: ref - classification
      // must still recognize it via the normalized value.
      { source: "payments", id: 44, value: "r2p:payment-slips/1/x.jpg", rawValue: "  r2p:payment-slips/1/x.jpg  " },
      // Whitespace around an out-of-scope external URL.
      {
        source: "payments",
        id: 45,
        value: "https://docs.google.com/some/file",
        rawValue: "  https://docs.google.com/some/file  ",
      },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.alreadyMigratedCount).toBe(1);
    expect(result.outOfScopeCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
  });

  it("no regression for normal values without whitespace (rawValue omitted falls back to value)", async () => {
    const rows: CandidateRow[] = [{ source: "payments", id: 46, value: MANUS_URL }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    const [, expectedCurrent] = (deps.updatePaymentSlipUrlIfUnchangedFn as any).mock.calls[0];
    expect(expectedCurrent).toBe(MANUS_URL);
  });
});

describe("isAlreadyMigratedSportsValue - exact origin/hostname matching (P2)", () => {
  it("accepts an exact match against the known media.ipenovel.com domain", () => {
    expect(isAlreadyMigratedSportsValue("https://media.ipenovel.com/sports-matches/1/cover/x.webp")).toBe(true);
  });

  it("rejects a lookalike hostname suffix (e.g. media.ipenovel.com.attacker.example)", () => {
    expect(isAlreadyMigratedSportsValue("https://media.ipenovel.com.attacker.example/x.webp")).toBe(false);
  });

  it("rejects a lookalike hostname prefix/substring (e.g. evil-media.ipenovel.com)", () => {
    expect(isAlreadyMigratedSportsValue("https://evil-media.ipenovel.com/x.webp")).toBe(false);
    expect(isAlreadyMigratedSportsValue("https://notmedia.ipenovel.com/x.webp")).toBe(false);
  });

  it("rejects a different protocol (http instead of https)", () => {
    expect(isAlreadyMigratedSportsValue("http://media.ipenovel.com/x.webp")).toBe(false);
  });

  it("rejects a different port", () => {
    expect(isAlreadyMigratedSportsValue("https://media.ipenovel.com:8443/x.webp")).toBe(false);
  });

  it("rejects an unrelated hostname entirely", () => {
    expect(isAlreadyMigratedSportsValue("https://example.com/x.webp")).toBe(false);
  });

  it("fails safe on a malformed value", () => {
    expect(isAlreadyMigratedSportsValue("not a url")).toBe(false);
  });
});

/**
 * A fetchCandidateRowsFn stand-in that filters an in-memory fixture the
 * same way the real (DB-backed) fetchCandidateRows() filters SQL rows -
 * id >= startId, matching type, matching sports column - so these tests
 * genuinely exercise the --start-id/--type/--column filtering semantics
 * end-to-end through runLegacyManusAssetMigrationBatch(), without a real
 * DB.
 */
function makeRealisticFetchCandidateRowsFn(allRows: CandidateRow[]) {
  return vi.fn(async (type: string, startId: number, column?: SportsColumnForTest) => {
    return allRows.filter((row) => {
      if (row.id < startId) return false;
      if (type !== "all") {
        const wantedSource = type === "payments" ? "payments" : type === "wallet" ? "walletTopups" : "sportsMatches";
        if (row.source !== wantedSource) return false;
      }
      if (row.source === "sportsMatches" && column && row.column !== column) return false;
      return true;
    });
  });
}
type SportsColumnForTest = "home" | "away" | "cover";

describe("--start-id resume-pitfall regressions (P1) - it is a lower-bound filter, NOT a resume cursor", () => {
  it("sports home/away/cover share one match id - a --limit cutoff leaves sibling columns pending at the SAME id", async () => {
    const allRows: CandidateRow[] = [
      { source: "sportsMatches", id: 28, column: "home", value: MANUS_URL },
      { source: "sportsMatches", id: 28, column: "away", value: MANUS_URL },
      { source: "sportsMatches", id: 28, column: "cover", value: MANUS_URL },
    ];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "sports", limit: 1, startId: 0 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(result.processedCount).toBe(1);
    // away + cover, same id 28, still pending after this run.
    expect(result.remainingEligible).toBe(2);
  });

  it("advancing --start-id past a partially-migrated match id permanently excludes its remaining columns from candidate discovery", async () => {
    // "home" already migrated (no longer the Manus hostname); "away"/
    // "cover" are still pending, same id 28.
    const allRows: CandidateRow[] = [
      {
        source: "sportsMatches",
        id: 28,
        column: "home",
        value: "https://media.ipenovel.com/sports-matches/legacy/28/home/x.webp",
      },
      { source: "sportsMatches", id: 28, column: "away", value: MANUS_URL },
      { source: "sportsMatches", id: 28, column: "cover", value: MANUS_URL },
    ];
    const deps = makeFullDeps();

    // Rerunning the SAME command (start-id=0) finds away/cover normally -
    // this is the correct, documented resume procedure.
    const sameCommand = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "sports", limit: 10, startId: 0 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(sameCommand.eligibleCount).toBe(2);

    // But an operator who advanced --start-id to 29 (believing "id 28 is
    // done" because its FIRST column happened to migrate) never even sees
    // away/cover - they're excluded from candidate discovery entirely.
    const advancedStartId = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "sports", limit: 10, startId: 29 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(advancedStartId.totalChecked).toBe(0);
    expect(advancedStartId.eligibleCount).toBe(0);
  });

  it("--type=all: rows from different tables share the same numeric id space - advancing --start-id can skip a lower-id row in a DIFFERENT table", async () => {
    const allRows: CandidateRow[] = [
      { source: "payments", id: 50, value: "r2p:payment-slips/legacy/payments/50/x.jpg" }, // already migrated
      { source: "walletTopups", id: 12, value: MANUS_URL }, // still eligible, LOWER id than payments #50
    ];
    const deps = makeFullDeps();

    const sameCommand = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "all", limit: 10, startId: 0 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(sameCommand.eligibleCount).toBe(1);

    // An operator who saw "payments #50 migrated" and set --start-id=51 for
    // the next --type=all run never sees walletTopups #12 at all - its id
    // has nothing to do with payments #50's id.
    const advancedStartId = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "all", limit: 10, startId: 51 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(advancedStartId.totalChecked).toBe(0);
  });

  it("a failed low-id row keeps its original id forever - advancing --start-id past it permanently excludes it from retry", async () => {
    const allRows: CandidateRow[] = [{ source: "payments", id: 3, value: MANUS_URL }];
    const deps = makeFullDeps({
      downloadFn: vi.fn(async () => {
        throw new LegacyAssetDownloadError("FETCH_FAILED");
      }),
    });
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "payments", limit: 10, startId: 0 },
      { ...deps, fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(result.failedCount).toBe(1);

    // The failure never touched the fixture's value, so a same-command
    // rerun still finds it - this is the correct, documented resume path.
    const rerunSame = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "payments", limit: 10, startId: 0 },
      { ...makeFullDeps(), fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(rerunSame.eligibleCount).toBe(1);

    // But an operator who advances --start-id to 4+ (e.g. because a later,
    // higher-id row succeeded and "looked done") permanently excludes the
    // still-failed, still-eligible payments #3 from every future run.
    const advancedStartId = await runLegacyManusAssetMigrationBatch(
      { dryRun: true, type: "payments", limit: 10, startId: 4 },
      { ...makeFullDeps(), fetchCandidateRowsFn: makeRealisticFetchCandidateRowsFn(allRows) as any }
    );
    expect(advancedStartId.totalChecked).toBe(0);
  });
});

describe("formatRowLabel - safe identifiers only", () => {
  it("never includes the row's URL/value", () => {
    const paymentLabel = formatRowLabel({ source: "payments", id: 123, value: MANUS_URL });
    const walletLabel = formatRowLabel({ source: "walletTopups", id: 456, value: MANUS_URL });
    const sportsLabel = formatRowLabel({ source: "sportsMatches", id: 789, column: "home", value: MANUS_URL });
    expect(paymentLabel).toBe("payment #123");
    expect(walletLabel).toBe("walletTopup #456");
    expect(sportsLabel).toBe("sportsMatch #789 home");
    for (const label of [paymentLabel, walletLabel, sportsLabel]) {
      expect(label).not.toContain("http");
      expect(label).not.toContain(MANUS_CLOUDFRONT_HOSTNAME);
    }
  });
});
