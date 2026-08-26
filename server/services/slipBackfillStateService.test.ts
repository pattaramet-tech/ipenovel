import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as db from "../db";
import {
  SLIP_BACKFILL_STATE_KEY,
  getSlipBackfillState,
  isLegacyScanRequired,
  markSlipBackfillComplete,
} from "./slipBackfillStateService";

/**
 * The durable backfill-complete switch.
 *
 * Completion disables the legacy historical scan, so every ambiguity must
 * resolve to NOT complete. The state must also survive a restart, which is
 * why it is read from the database rather than memory, env, a file, or a
 * constant.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function stubSetting(value: string | null | undefined) {
  vi.spyOn(db, "getSetting").mockResolvedValue(
    value === undefined ? undefined : ({ key: SLIP_BACKFILL_STATE_KEY, value } as any)
  );
}

describe("getSlipBackfillState fails safe", () => {
  it("no row -> not complete", async () => {
    stubSetting(undefined);
    expect((await getSlipBackfillState()).complete).toBe(false);
  });

  it("empty value -> not complete", async () => {
    stubSetting("");
    expect((await getSlipBackfillState()).complete).toBe(false);
  });

  it("malformed JSON -> not complete (never throws)", async () => {
    stubSetting("{not json");
    await expect(getSlipBackfillState()).resolves.toEqual({ complete: false });
  });

  it("a database read failure -> not complete", async () => {
    vi.spyOn(db, "getSetting").mockRejectedValue(new Error("db down"));
    expect((await getSlipBackfillState()).complete).toBe(false);
  });

  it("complete must be the BOOLEAN true - a truthy string does not count", async () => {
    stubSetting(JSON.stringify({ complete: "true" }));
    expect((await getSlipBackfillState()).complete).toBe(false);

    stubSetting(JSON.stringify({ complete: 1 }));
    expect((await getSlipBackfillState()).complete).toBe(false);
  });

  it("explicit complete:false -> not complete", async () => {
    stubSetting(JSON.stringify({ complete: false }));
    expect((await getSlipBackfillState()).complete).toBe(false);
  });

  it("a well-formed completion record is honoured", async () => {
    stubSetting(
      JSON.stringify({
        complete: true,
        completedAt: "2026-08-22T00:00:00.000Z",
        toolVersion: "backfill-slip-claims@2",
        paymentMaxId: 120,
        walletTopupMaxId: 30,
        claimsInserted: 150,
      })
    );
    const state = await getSlipBackfillState();
    expect(state).toMatchObject({
      complete: true,
      toolVersion: "backfill-slip-claims@2",
      paymentMaxId: 120,
      walletTopupMaxId: 30,
      claimsInserted: 150,
    });
  });

  it("ignores non-integer provenance fields rather than trusting them", async () => {
    stubSetting(JSON.stringify({ complete: true, paymentMaxId: "lots" }));
    expect((await getSlipBackfillState()).paymentMaxId).toBeUndefined();
  });
});

describe("isLegacyScanRequired", () => {
  it("required while incomplete", async () => {
    stubSetting(undefined);
    expect(await isLegacyScanRequired()).toBe(true);
  });

  it("NOT required once complete", async () => {
    stubSetting(JSON.stringify({ complete: true }));
    expect(await isLegacyScanRequired()).toBe(false);
  });

  it("required when the read fails - the safe direction", async () => {
    vi.spyOn(db, "getSetting").mockRejectedValue(new Error("db down"));
    expect(await isLegacyScanRequired()).toBe(true);
  });
});

describe("markSlipBackfillComplete", () => {
  it("writes a durable DB record, not memory", async () => {
    const setSetting = vi.spyOn(db, "setSetting").mockResolvedValue(undefined as any);

    await markSlipBackfillComplete({
      toolVersion: "backfill-slip-claims@2",
      paymentMaxId: 10,
      walletTopupMaxId: 5,
      claimsInserted: 15,
    });

    expect(setSetting).toHaveBeenCalledTimes(1);
    const [key, value] = setSetting.mock.calls[0];
    expect(key).toBe(SLIP_BACKFILL_STATE_KEY);
    const parsed = JSON.parse(value as string);
    expect(parsed.complete).toBe(true);
    expect(parsed.completedAt).toBeTruthy();
    expect(parsed.toolVersion).toBe("backfill-slip-claims@2");
  });

  it("records provenance so an operator can audit what was covered", async () => {
    const setSetting = vi.spyOn(db, "setSetting").mockResolvedValue(undefined as any);
    await markSlipBackfillComplete({ toolVersion: "t", paymentMaxId: 99, walletTopupMaxId: 42 });
    const parsed = JSON.parse(setSetting.mock.calls[0][1] as string);
    expect(parsed.paymentMaxId).toBe(99);
    expect(parsed.walletTopupMaxId).toBe(42);
  });
});

// ─── Storage medium + completion guards ──────────────────────────────────

describe("the switch is durable and operator-gated", () => {
  const serviceCode = fs
    .readFileSync(path.resolve(process.cwd(), "server/services/slipBackfillStateService.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("reads from the database, not memory/env/file/constant", () => {
    expect(serviceCode).toMatch(/getSetting\(/);
    expect(serviceCode).not.toMatch(/process\.env/);
    expect(serviceCode).not.toMatch(/readFileSync|writeFileSync/);
    // No module-level cache that would survive as stale process state.
    expect(serviceCode).not.toMatch(/let\s+cached/);
  });

  const scriptCode = fs
    .readFileSync(path.resolve(process.cwd(), "scripts/backfill-slip-claims.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("completion requires a fully clean run", () => {
    expect(scriptCode).toMatch(/const cleanRun =/);
    expect(scriptCode).toMatch(/stats\.failures\.length === 0/);
    expect(scriptCode).toMatch(/tracker\.collisions\.length === 0/);
    expect(scriptCode).toMatch(/reachedEof\.payments/);
    expect(scriptCode).toMatch(/reachedEof\.walletTopups/);
  });

  it("refuses to mark complete when the run was not clean", () => {
    expect(scriptCode).toMatch(/if \(!cleanRun\)/);
    expect(scriptCode).toMatch(/REFUSING to mark complete/);
  });

  it("only calls markSlipBackfillComplete inside the clean branch", () => {
    const idx = scriptCode.indexOf("markSlipBackfillComplete");
    const cleanIdx = scriptCode.indexOf("if (!cleanRun)");
    expect(idx).toBeGreaterThan(cleanIdx);
  });

  it("a dry run cannot reach the completion call at all", () => {
    // markComplete is gated by parseBackfillOptions, which rejects it without
    // --live; the script only branches on markComplete.
    expect(scriptCode).toMatch(/if \(markComplete\)/);
  });

  it("does not hold one transaction across the whole backfill", () => {
    expect(scriptCode).not.toMatch(/db\.transaction\(/);
  });
});
