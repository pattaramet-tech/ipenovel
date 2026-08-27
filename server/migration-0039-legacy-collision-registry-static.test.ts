import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  paymentSlipLegacyCollisions,
  paymentSlipLegacyUnknown,
} from "../drizzle/schema";

/**
 * IPE-004 hotfix: migration 0039 adds the two durable tables the new
 * evidence model relies on - paymentSlipLegacyCollisions (known historical
 * collisions, no winner picked) and paymentSlipLegacyUnknown (permanently
 * unresolvable rows, e.g. no_slip_image_url). These are DB-independent
 * shape/reflection checks; no database is contacted.
 */

const repoRoot = path.resolve(__dirname, "..");
const MIGRATION_TAG = "0039_add_legacy_collision_and_unknown_registry";

describe("migration 0039 - journal + file", () => {
  it("the journal has an entry for 0039, placed after 0038", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8")
    );
    const entry = journal.entries.find((e: any) => e.tag === MIGRATION_TAG);
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(39);
    const previous = journal.entries.find(
      (e: any) => e.tag === "0038_add_legacy_alias_and_review_resolutions"
    );
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("the migration SQL file exists and creates both tables", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle", `${MIGRATION_TAG}.sql`), "utf8");
    expect(sql).toMatch(/CREATE TABLE `paymentSlipLegacyCollisions`/);
    expect(sql).toMatch(/CREATE TABLE `paymentSlipLegacyUnknown`/);
    // Existing migrations 0037/0038 are untouched, not rewritten or reordered.
    expect(fs.existsSync(path.join(repoRoot, "drizzle/0037_add_slip_claims_and_ocr_attempts.sql"))).toBe(
      true
    );
    expect(
      fs.existsSync(path.join(repoRoot, "drizzle/0038_add_legacy_alias_and_review_resolutions.sql"))
    ).toBe(true);
  });

  it("the collision table's unique constraint covers the full (kind, identifierHash, source) tuple - no accidental cross-source or cross-kind collapse", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle", `${MIGRATION_TAG}.sql`), "utf8");
    expect(sql).toMatch(
      /CONSTRAINT `paymentSlipLegacyCollisions_member_unique` UNIQUE\(`kind`,`identifierHash`,`sourceType`,`sourceId`\)/
    );
  });

  it("the unknown table's unique constraint is per-source, so a row is never recorded twice", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle", `${MIGRATION_TAG}.sql`), "utf8");
    expect(sql).toMatch(
      /CONSTRAINT `paymentSlipLegacyUnknown_source_unique` UNIQUE\(`sourceType`,`sourceId`\)/
    );
  });

  it("the collision table is indexed for a fast lookup by (kind, identifierHash) - not a scan", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle", `${MIGRATION_TAG}.sql`), "utf8");
    expect(sql).toMatch(
      /CREATE INDEX `paymentSlipLegacyCollisions_identifierHash_idx` ON `paymentSlipLegacyCollisions` \(`kind`,`identifierHash`\)/
    );
  });
});

describe("drizzle/schema.ts - table reflection (no DB required)", () => {
  it("paymentSlipLegacyCollisions has the expected columns", () => {
    const columns = Object.keys(paymentSlipLegacyCollisions);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "kind", "identifierHash", "sourceType", "sourceId", "recordedAt"])
    );
  });

  it("paymentSlipLegacyUnknown has the expected columns", () => {
    const columns = Object.keys(paymentSlipLegacyUnknown);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "sourceType", "sourceId", "reason", "recordedAt"])
    );
  });

  it("both tables report their real MySQL table name via the drizzle name symbol", () => {
    expect(String(paymentSlipLegacyCollisions[Symbol.for("drizzle:Name")])).toBe(
      "paymentSlipLegacyCollisions"
    );
    expect(String(paymentSlipLegacyUnknown[Symbol.for("drizzle:Name")])).toBe(
      "paymentSlipLegacyUnknown"
    );
  });

  it("kind is constrained to exactly reference/file/qr", () => {
    expect((paymentSlipLegacyCollisions.kind as any).enumValues).toEqual(["reference", "file", "qr"]);
  });

  it("sourceType is constrained to exactly order_payment/wallet_topup on both tables", () => {
    expect((paymentSlipLegacyCollisions.sourceType as any).enumValues).toEqual([
      "order_payment",
      "wallet_topup",
    ]);
    expect((paymentSlipLegacyUnknown.sourceType as any).enumValues).toEqual([
      "order_payment",
      "wallet_topup",
    ]);
  });
});
