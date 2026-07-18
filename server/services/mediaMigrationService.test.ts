import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import sharp from "sharp";
import {
  isAlreadyMigratedUrl,
  buildMigrationKey,
  downloadImage,
  formatRowLabel,
  runMediaMigrationBatch,
  MediaMigrationLockError,
} from "./mediaMigrationService";

/**
 * Safety-net for the shared media migration service (used by both
 * scripts/migrate-media-to-r2.ts and the admin.mediaMigration tRPC
 * procedures). Covers:
 * - already-migrated URL detection (R2_PUBLIC_BASE_URL / media.ipenovel.com)
 * - the exact novel-covers/migrated/{id}/... and banners/migrated/{id}/...
 *   key format
 * - downloadImage's status/content-type/size validation
 * - the in-memory lock rejecting a concurrent call with
 *   MediaMigrationLockError, and releasing itself afterward
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isAlreadyMigratedUrl", () => {
  it("flags a URL under R2_PUBLIC_BASE_URL as already migrated", () => {
    process.env.R2_PUBLIC_BASE_URL = "https://media.ipenovel.com";
    expect(isAlreadyMigratedUrl("https://media.ipenovel.com/banners/123.webp")).toBe(true);
  });

  it("flags the known production CDN domain even if R2_PUBLIC_BASE_URL differs", () => {
    process.env.R2_PUBLIC_BASE_URL = "https://some-other-r2-domain.example.com";
    expect(isAlreadyMigratedUrl("https://media.ipenovel.com/banners/123.webp")).toBe(true);
  });

  it("does not flag an old-storage URL", () => {
    process.env.R2_PUBLIC_BASE_URL = "https://media.ipenovel.com";
    expect(isAlreadyMigratedUrl("https://old-storage.example.com/banners/123.jpg")).toBe(false);
  });
});

describe("buildMigrationKey", () => {
  it("builds a novel-covers/migrated/{id}/{ts}-{rand}.webp key", () => {
    const key = buildMigrationKey({ type: "novel", id: 57 });
    expect(key).toMatch(/^novel-covers\/migrated\/57\/\d+-[a-z0-9]+\.webp$/);
  });

  it("builds a banners/migrated/{id}/{ts}-{rand}.webp key", () => {
    const key = buildMigrationKey({ type: "banner", id: 9 });
    expect(key).toMatch(/^banners\/migrated\/9\/\d+-[a-z0-9]+\.webp$/);
  });
});

describe("formatRowLabel", () => {
  it("labels novels and banners distinctly", () => {
    expect(formatRowLabel({ type: "novel", id: 1 })).toBe("novel #1");
    expect(formatRowLabel({ type: "banner", id: 2 })).toBe("banner #2");
  });
});

describe("downloadImage - status/content-type/size validation", () => {
  let server: http.Server;
  let base: string;
  let pngBuffer: Buffer;

  async function withServer(fn: () => Promise<void>) {
    pngBuffer = await sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .png()
      .toBuffer();

    server = http.createServer((req, res) => {
      if (req.url === "/good.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": pngBuffer.length });
        res.end(pngBuffer);
      } else if (req.url === "/not-found.png") {
        res.writeHead(404);
        res.end("nope");
      } else if (req.url === "/wrong-type.png") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not an image</html>");
      } else if (req.url === "/too-big.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) });
        res.end(pngBuffer);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address && typeof address === "object") {
      base = `http://127.0.0.1:${address.port}`;
    }
    try {
      await fn();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("downloads a valid image", async () => {
    await withServer(async () => {
      const result = await downloadImage(`${base}/good.png`);
      expect(result.contentType).toBe("image/png");
      expect(result.buffer.length).toBe(pngBuffer.length);
    });
  });

  it("rejects a non-200 status", async () => {
    await withServer(async () => {
      await expect(downloadImage(`${base}/not-found.png`)).rejects.toThrow(/HTTP status 404/);
    });
  });

  it("rejects a non-image content-type", async () => {
    await withServer(async () => {
      await expect(downloadImage(`${base}/wrong-type.png`)).rejects.toThrow(/text\/html/);
    });
  });

  it("rejects an oversized file (via content-length header)", async () => {
    await withServer(async () => {
      await expect(downloadImage(`${base}/too-big.png`)).rejects.toThrow(/ใหญ่เกินไป/);
    });
  });
});

describe("runMediaMigrationBatch - in-memory lock", () => {
  it("rejects a concurrent call with MediaMigrationLockError while one is already running", async () => {
    // No DATABASE_URL in this test env, so fetchCandidateRows will reject -
    // but that happens only AFTER the lock is acquired synchronously, so the
    // second (overlapping) call still sees the lock held and rejects with
    // MediaMigrationLockError specifically, not the DB error.
    const first = runMediaMigrationBatch({ dryRun: true, type: "banners", limit: 5 });
    const second = runMediaMigrationBatch({ dryRun: true, type: "banners", limit: 5 });

    await expect(second).rejects.toBeInstanceOf(MediaMigrationLockError);
    await expect(second).rejects.toThrow("Migration is already running. Please wait.");

    // The first call still runs to completion (and fails on its own terms -
    // no DB in this test env) - either way the lock must be released after.
    await expect(first).rejects.toThrow();
  });

  it("releases the lock after a run finishes, so a subsequent call is not blocked", async () => {
    await expect(runMediaMigrationBatch({ dryRun: true, type: "banners", limit: 5 })).rejects.toThrow();
    // If the lock were not released, this would reject with
    // MediaMigrationLockError instead of the (expected, in this DB-less test
    // env) "Database not available" error.
    await expect(runMediaMigrationBatch({ dryRun: true, type: "banners", limit: 5 })).rejects.not.toBeInstanceOf(
      MediaMigrationLockError
    );
  });
});
