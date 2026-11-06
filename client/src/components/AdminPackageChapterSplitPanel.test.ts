// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Admin package-split panel: apply is only possible for an applicable
 * preview whose inputs are unchanged since that preview, and it sends the
 * previewed planHash + inputs (the server binds them; STALE_PLAN otherwise).
 */

const state = vi.hoisted(() => {
  const previewFetch = vi.fn();
  const applyCalls: any[] = [];
  const applyMutateAsync = vi.fn(async (input: any) => {
    applyCalls.push(input);
    return { createdEpisodeIds: [1, 2], keptEpisodeIds: [], mappingsInserted: 2, planHash: input.planHash };
  });
  return { previewFetch, applyCalls, applyMutateAsync };
});

const SCAN = [{ packageEpisodeId: 77, novelId: 5, episodeNumber: "1 - 2", title: "แพ็ก", status: "splittable", chapterCount: 2, createCount: 2, keepCount: 0, conflictCount: 0, issueCodes: [] }];
const CLEAN_PREVIEW = {
  episodeNumber: "1 - 2",
  split: { chapterCount: 2 },
  counts: { create: 2, keep: 0, conflict: 0 },
  issues: [],
  warnings: [],
  rows: [
    { chapterNumber: 1, title: "บทที่ 1", partCount: 1, bodyCharCount: 10, isFree: false, price: "5.00", action: "create" },
    { chapterNumber: 2, title: "บทที่ 2", partCount: 1, bodyCharCount: 12, isFree: false, price: "5.00", action: "create" },
  ],
  applicable: true,
  planHash: "a".repeat(64),
};
const BLOCKED_PREVIEW = {
  ...CLEAN_PREVIEW,
  issues: [{ code: "MISSING_CHAPTER", message: "ไม่พบบทที่ 2" }],
  applicable: false,
  planHash: null,
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { episodes: { packageSplitPreview: { fetch: state.previewFetch } } } }),
    admin: {
      episodes: {
        packageSplitScan: { useQuery: () => ({ data: SCAN, isLoading: false, refetch: async () => undefined }) },
        packageSplitApply: { useMutation: () => ({ mutateAsync: state.applyMutateAsync, isPending: false }) },
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AdminPackageChapterSplitPanel, parseChapterPriceOverrides } from "./AdminPackageChapterSplitPanel";

// Classic JSX runtime without the Vite React plugin under vitest.
(globalThis as unknown as { React: unknown }).React = React;

afterEach(() => {
  cleanup();
  state.previewFetch.mockReset();
  state.applyCalls.length = 0;
});

const applyButton = () => screen.getByRole("button", { name: /ยืนยันแบ่งบท/ }) as HTMLButtonElement;

async function selectAndPreview(price: string) {
  fireEvent.click(screen.getByLabelText("เลือกแพ็ก 1 - 2"));
  fireEvent.change(screen.getByLabelText(/ราคาต่อบท/), { target: { value: price } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ตรวจผลการแบ่งบท/ }));
  });
}

describe("AdminPackageChapterSplitPanel", () => {
  it("blocks apply when the preview has issues", async () => {
    state.previewFetch.mockResolvedValue(BLOCKED_PREVIEW);
    render(React.createElement(AdminPackageChapterSplitPanel, { novelId: 5 }));
    await selectAndPreview("5");
    expect(screen.getByText("ไม่พบบทที่ 2")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
  });

  it("enables apply for a clean preview, re-gates on input change, and sends the previewed planHash + inputs", async () => {
    state.previewFetch.mockResolvedValue(CLEAN_PREVIEW);
    render(React.createElement(AdminPackageChapterSplitPanel, { novelId: 5 }));
    await selectAndPreview("5");
    expect(state.previewFetch).toHaveBeenCalledWith({ packageEpisodeId: 77, pricing: { chapterPrice: "5" }, publish: false });
    expect(applyButton().disabled).toBe(false);

    // Changing the price after the preview makes it dirty: apply disabled.
    fireEvent.change(screen.getByLabelText(/ราคาต่อบท/), { target: { value: "6" } });
    expect(applyButton().disabled).toBe(true);
    expect(screen.getByText(/กรุณากดตรวจผลการแบ่งบทใหม่/)).toBeTruthy();

    // Restore the previewed value -> enabled again, apply sends exactly the previewed inputs.
    fireEvent.change(screen.getByLabelText(/ราคาต่อบท/), { target: { value: "5" } });
    expect(applyButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(applyButton());
    });
    expect(state.applyCalls).toEqual([
      { packageEpisodeId: 77, pricing: { chapterPrice: "5" }, publish: false, planHash: "a".repeat(64) },
    ]);
  });
});

describe("AdminPackageChapterSplitPanel - R4 per-chapter price overrides", () => {
  it("parses 'chapter: price' entries and rejects malformed / duplicate ones", () => {
    expect(parseChapterPriceOverrides("1: 0\n10=9.50, 3 : 2")).toEqual({ overrides: { "1": "0", "10": "9.50", "3": "2" } });
    expect(parseChapterPriceOverrides("")).toEqual({ overrides: {} });
    expect("error" in parseChapterPriceOverrides("abc")).toBe(true);
    expect("error" in parseChapterPriceOverrides("1: -5")).toBe(true);
    expect("error" in parseChapterPriceOverrides("1: 2.345")).toBe(true);
    expect("error" in parseChapterPriceOverrides("1: 2\n01: 3")).toBe(true);
  });

  it("a malformed override blocks preview (no request sent) and shows the error", async () => {
    state.previewFetch.mockResolvedValue(CLEAN_PREVIEW);
    render(React.createElement(AdminPackageChapterSplitPanel, { novelId: 5 }));
    fireEvent.click(screen.getByLabelText("เลือกแพ็ก 1 - 2"));
    fireEvent.change(screen.getByLabelText(/ราคาต่อบท/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/ราคาเฉพาะบท/), { target: { value: "1 = ฟรี" } });
    expect(screen.getByText(/รูปแบบราคาเฉพาะบทไม่ถูกต้อง/)).toBeTruthy();
    const previewButton = screen.getByRole("button", { name: /ตรวจผลการแบ่งบท/ }) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    fireEvent.click(previewButton);
    expect(state.previewFetch).not.toHaveBeenCalled();
  });

  it("sends overrides with preview AND apply; changing an override after preview forces a new preview", async () => {
    state.previewFetch.mockResolvedValue(CLEAN_PREVIEW);
    render(React.createElement(AdminPackageChapterSplitPanel, { novelId: 5 }));
    fireEvent.click(screen.getByLabelText("เลือกแพ็ก 1 - 2"));
    fireEvent.change(screen.getByLabelText(/ราคาต่อบท/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/ราคาเฉพาะบท/), { target: { value: "1: 0" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ตรวจผลการแบ่งบท/ }));
    });
    expect(state.previewFetch).toHaveBeenCalledWith({
      packageEpisodeId: 77,
      pricing: { chapterPrice: "5", overrides: { "1": "0" } },
      publish: false,
    });
    expect(applyButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/ราคาเฉพาะบท/), { target: { value: "1: 1" } });
    expect(applyButton().disabled).toBe(true);
    expect(screen.getByText(/กรุณากดตรวจผลการแบ่งบทใหม่/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/ราคาเฉพาะบท/), { target: { value: "1: 0" } });
    await act(async () => {
      fireEvent.click(applyButton());
    });
    expect(state.applyCalls).toEqual([
      { packageEpisodeId: 77, pricing: { chapterPrice: "5", overrides: { "1": "0" } }, publish: false, planHash: "a".repeat(64) },
    ]);
  });
});
