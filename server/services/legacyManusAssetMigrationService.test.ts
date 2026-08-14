import { describe, expect, it, vi } from "vitest";
import {
  isMigratableManusCloudfrontUrl,
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
    r2PutFn: vi.fn(async (key: string) => ({ key, url: `https://media.ipenovel.com/${key}` })),
    optimizeImageFn: vi.fn(async () => ({
      buffer: Buffer.from("webp-bytes"),
      contentType: "image/webp" as const,
      width: 100,
      height: 100,
    })),
    updatePaymentFn: vi.fn(async () => {}),
    updateWalletTopupSlipFn: vi.fn(async () => ({})),
    updateSportsMatchFn: vi.fn(async () => ({})),
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
    expect(deps.updatePaymentFn).not.toHaveBeenCalled();
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
    expect(deps.updateSportsMatchFn).not.toHaveBeenCalled();
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
    expect(deps.updatePaymentFn).not.toHaveBeenCalled();
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
    expect(deps.updatePaymentFn).not.toHaveBeenCalled();
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
    expect(deps.updatePaymentFn).not.toHaveBeenCalled();
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
    expect(deps.updatePaymentFn).toHaveBeenCalledTimes(1);
    const [paymentId, data] = (deps.updatePaymentFn as any).mock.calls[0];
    expect(paymentId).toBe(5);
    expect(data.slipImageUrl).toMatch(/^r2p:payment-slips\/legacy\/payments\/5\//);
  });

  it("10. successful private upload updates wallet top-up to an r2p: ref", async () => {
    const rows: CandidateRow[] = [{ source: "walletTopups", id: 6, value: MANUS_URL }];
    const deps = makeFullDeps();
    const result = await runLegacyManusAssetMigrationBatch(
      { dryRun: false, type: "wallet", limit: 10 },
      { ...deps, fetchCandidateRowsFn: vi.fn(async () => rows) }
    );
    expect(result.migratedCount).toBe(1);
    expect(deps.updateWalletTopupSlipFn).toHaveBeenCalledTimes(1);
    const [topupId, ref] = (deps.updateWalletTopupSlipFn as any).mock.calls[0];
    expect(topupId).toBe(6);
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
    expect(deps.updateSportsMatchFn).toHaveBeenCalledTimes(1);
    const [matchId, data] = (deps.updateSportsMatchFn as any).mock.calls[0];
    expect(matchId).toBe(8);
    expect(Object.keys(data)).toEqual(["homeTeamImageUrl"]);
    expect(data.homeTeamImageUrl).toMatch(/^https:\/\/media\.ipenovel\.com\/sports-matches\/legacy\/8\/home\//);
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
    expect(deps.updatePaymentFn).not.toHaveBeenCalled();
    expect(deps.updateSportsMatchFn).not.toHaveBeenCalled();
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
    expect(deps.updatePaymentFn).toHaveBeenCalledTimes(2);
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
    const newRef: string = (deps.updatePaymentFn as any).mock.calls[0][1].slipImageUrl;

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
