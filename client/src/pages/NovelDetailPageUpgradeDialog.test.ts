// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * R7-01 component-level suite for the P3 chapter-to-package upgrade dialog
 * (NovelDetailPage). Pins down the quote-state contract the pay buttons
 * depend on:
 *
 *  1. A quote response is bound to the coupon/points input it was ISSUED
 *     with (not to whatever is typed when it resolves).
 *  2. A slow/stale quote response that resolves AFTER a newer request can
 *     never overwrite the latest quote (numbers, price rows or button
 *     enablement).
 *  3. Changing OR clearing the coupon/points input while a quote is active
 *     makes the dialog DIRTY: pay buttons disabled, re-price hint shown,
 *     execute never sent - until a fresh quote covers the new input.
 *  4. When the latest quote matches the current input, the pay buttons
 *     enable and show the exact final total that execute binds to
 *     (expectedFinalTotal).
 *  5. A stale quote ERROR (superseded request resolving late) must not
 *     close the dialog or clobber the live quote.
 */

interface MutationFlight {
  input: Record<string, unknown>;
  handlers: { onSuccess(data?: unknown): void; onError(error?: unknown): void; onSettled(): void };
}

const state = vi.hoisted(() => {
  const quoteFlights: MutationFlight[] = [];
  const executeFlights: MutationFlight[] = [];
  // tRPC mutations carry their callbacks in the useMutation CONFIG, not in
  // mutate() - capture the config per hook instance and expose settle
  // handlers per flight.
  const makeFlightRecorder = (flights: MutationFlight[]) =>
    vi.fn((config?: { onSuccess?: (data?: unknown) => void; onError?: (error?: unknown) => void }) => ({
      mutate: (
        input: Record<string, unknown>,
        opts?: { onSuccess?: (data?: unknown) => void; onError?: (error?: unknown) => void }
      ) => {
        flights.push({
          input,
          handlers: {
            // Per-call options win (that is where the R7-01 guards live);
            // config-level callbacks stay as the generic fallback.
            onSuccess: (data?: unknown) => (opts?.onSuccess ?? config?.onSuccess)?.(data),
            onError: (error?: unknown) => (opts?.onError ?? config?.onError)?.(error),
            onSettled: () => {},
          },
        });
      },
      isPending: false,
      mutateAsync: async () => undefined,
    }));
  const quoteUseMutation = makeFlightRecorder(quoteFlights);
  const executeUseMutation = makeFlightRecorder(executeFlights);
  const novelPayload = {
    novel: {
      id: 11,
      title: "นิยายทดสอบ",
      author: "ผู้เขียนทดสอบ",
      description: "เรื่องราวยาวตอนทดสอบ",
      slug: "test-novel",
      coverImageUrl: null,
      publicationStatus: "published",
      storyStatus: "ongoing",
    },
    // R8-3: server-provided readiness - the CTA renders only when true.
    packageUpgradeEnabled: true,
  };
  const episodesPayload = [
    {
      id: 501,
      novelId: 11,
      episodeNumber: "1",
      title: "บทที่ 1",
      saleMode: "chapter",
      price: "5.00",
      isFree: false,
      isPublished: true,
      isPurchased: true,
      hasPurchased: true,
      // Server listing flag (package split R5): a real wallet/order purchase -
      // the P3 upgrade entry point only appears for PAID chapters.
      hasPaidPurchase: true,
      hasContent: true,
      hasLegacyFile: false,
      fileUrl: null,
      progressPercent: 0,
    },
    {
      id: 900,
      novelId: 11,
      episodeNumber: "1 - 10",
      title: "แพ็ก บทที่ 1-10",
      saleMode: "package",
      price: "30.00",
      isFree: false,
      isPublished: true,
      isPurchased: false,
      hasPurchased: false,
      hasContent: true,
      hasLegacyFile: false,
      fileUrl: null,
      progressPercent: 0,
    },
  ];
  const resetFlights = () => {
    quoteFlights.length = 0;
    executeFlights.length = 0;
    quoteUseMutation.mockClear();
    executeUseMutation.mockClear();
  };
  return {
    quoteFlights,
    executeFlights,
    quoteUseMutation,
    executeUseMutation,
    novelPayload,
    episodesPayload,
    resetFlights,
  };
});

const QUOTE_BASE = {
  packagePrice: "30.00",
  creditAmount: "5.00",
  payableAmount: "25.00",
  items: [{ chapterEpisodeId: 501, source: "wallet", pricePaidSnapshot: "5.00", creditAppliedSnapshot: "5.00" }],
};
const QUOTE_PLAIN = { ...QUOTE_BASE, upgradeId: 901 };
const QUOTE_WITH_COUPON = { ...QUOTE_BASE, upgradeId: 901, couponDiscount: "10.00", pointsDiscount: "0.00", finalTotal: "15.00" };

vi.mock("@/lib/trpc", () => {
  const noop = () => {};
  return {
    trpc: {
      useUtils: () => ({
        novels: { episodes: { invalidate: noop } },
        cart: { get: { invalidate: noop } },
      }),
      novels: {
        detail: { useQuery: () => ({ data: state.novelPayload, isLoading: false, error: null }) },
        episodes: { useQuery: () => ({ data: state.episodesPayload, isLoading: false, error: null }) },
      },
      cart: {
        get: { useQuery: () => ({ data: { items: [] } }) },
        add: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
        remove: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
      },
      reader: {
        packageUpgradeQuote: { useMutation: state.quoteUseMutation },
        packageUpgradeExecute: { useMutation: state.executeUseMutation },
        purchaseEpisode: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
      },
    },
  };
});

vi.mock("wouter", () => ({
  useParams: () => ({ identifier: "11" }),
  useLocation: () => ["/novel/11", vi.fn()],
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 9, email: "u9@ipe.local", role: "user" } }),
}));

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "th" }),
}));

vi.mock("@/contexts/PublicThemeContext", () => ({
  usePublicStorefrontPageThemeProps: () => ({}),
}));

vi.mock("@/hooks/useDocumentHead", () => ({ useDocumentHead: () => {} }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import NovelDetailPage from "./NovelDetailPage";

// NovelDetailPage.tsx uses the classic JSX runtime (React.createElement)
// without importing React - the Vite build supplies it via plugin-react,
// but vitest's plain esbuild transform does not. Expose it globally so the
// page's compiled JSX resolves at render time.
(globalThis as unknown as { React: unknown }).React = React;

async function openUpgradeDialog() {
  const trigger = await screen.findByRole("button", { name: "อัปเกรดจากบทที่ซื้อแล้ว" });
  fireEvent.click(trigger);
  await screen.findByText("อัปเกรดเป็นแพ็ก");
}

const couponInput = () => screen.getByPlaceholderText("คูปอง (ถ้ามี)") as HTMLInputElement;
const repriceButton = () => screen.getByRole("button", { name: "ตรวจราคา" });
const walletButton = () => screen.getByRole("button", { name: /ยืนยันชำระผ่าน Wallet/ });
const dirtyHint = () => screen.queryByText(/คูปอง\/แต้มมีการเปลี่ยนแปลง/);
const couponRow = () => screen.queryByText("ยอดจ่ายหลังคูปอง/แต้ม");

async function settleQuote(flightIndex: number, data?: unknown, error?: unknown) {
  await act(async () => {
    const flight = state.quoteFlights[flightIndex];
    if (error != null) flight.handlers.onError(error);
    else flight.handlers.onSuccess(data);
    flight.handlers.onSettled();
  });
}

beforeEach(() => {
  state.resetFlights();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("P3-R7 upgrade dialog quote-state contract", () => {
  it("binds the quote to its REQUESTED input; change OR clear forces re-quote before pay enables; pay binds the shown final total", async () => {
    render(React.createElement(NovelDetailPage));
    await openUpgradeDialog();

    // Quote #1 issued with EMPTY inputs.
    expect(state.quoteFlights).toHaveLength(1);
    expect(state.quoteFlights[0].input).toEqual({ packageEpisodeId: 900 });
    await settleQuote(0, QUOTE_PLAIN);

    // Matching input: pay enabled, wallet button shows the exact charge.
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);
    expect(walletButton().textContent).toContain("฿25.00");
    expect(dirtyHint()).toBeNull();

    // CHANGED input -> dirty: pay disabled, hint shown, execute NEVER sent.
    fireEvent.change(couponInput(), { target: { value: "SAVE10" } });
    expect((walletButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "ชำระผ่าน QR / สลิป" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dirtyHint()).not.toBeNull();
    fireEvent.click(walletButton());
    expect(state.executeFlights).toHaveLength(0);

    // Re-quote is issued WITH the changed input and re-enables pay.
    fireEvent.click(repriceButton());
    expect(state.quoteFlights).toHaveLength(2);
    expect(state.quoteFlights[1].input).toEqual({ packageEpisodeId: 900, couponCode: "SAVE10" });
    await settleQuote(1, QUOTE_WITH_COUPON);

    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);
    expect(walletButton().textContent).toContain("฿15.00");
    expect(couponRow()).not.toBeNull();
    expect(dirtyHint()).toBeNull();

    // Pay sends the dialog's shown total as the mandatory confirmation.
    fireEvent.click(walletButton());
    expect(state.executeFlights).toHaveLength(1);
    expect(state.executeFlights[0].input).toMatchObject({
      upgradeId: 901,
      method: "wallet",
      expectedFinalTotal: "15.00",
      couponCode: "SAVE10",
    });
    expect(String(state.executeFlights[0].input.idempotencyKey)).toMatch(/^upgrade-9-900-/);

    // CLEARED input -> dirty again: re-quote required before pay.
    fireEvent.change(couponInput(), { target: { value: "" } });
    expect((walletButton() as HTMLButtonElement).disabled).toBe(true);
    expect(dirtyHint()).not.toBeNull();
    fireEvent.click(repriceButton());
    expect(state.quoteFlights).toHaveLength(3);
    expect(state.quoteFlights[2].input).toEqual({ packageEpisodeId: 900 }); // coupon dropped
    await settleQuote(2, QUOTE_PLAIN);
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);
    expect(walletButton().textContent).toContain("฿25.00");
    expect(couponRow()).toBeNull();
  });

  it("a STALE quote response (resolved after a newer request) never overwrites the latest quote", async () => {
    render(React.createElement(NovelDetailPage));
    await openUpgradeDialog();

    // Request #1 (no coupon), then the input changes and request #2 issues.
    await settleQuote(0, QUOTE_PLAIN);
    fireEvent.change(couponInput(), { target: { value: "LATE" } });
    fireEvent.click(repriceButton());
    expect(state.quoteFlights).toHaveLength(2);
    expect(state.quoteFlights[1].input.couponCode).toBe("LATE");

    // The NEWER response settles first: latest quote = coupon price.
    await settleQuote(1, QUOTE_WITH_COUPON);
    expect(couponRow()).not.toBeNull();
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);

    // The OLDER response resolves LAST - it must be dropped entirely:
    // the coupon-price quote (and the enabled pay state bound to it) stays.
    await settleQuote(0, QUOTE_PLAIN);
    expect(couponRow()).not.toBeNull(); // final-total row from quote #2 still shown
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);
    expect(walletButton().textContent).toContain("฿15.00");

    // Executing still binds to the LATEST quote, not the stale one.
    fireEvent.click(walletButton());
    expect(state.executeFlights).toHaveLength(1);
    expect(state.executeFlights[0].input).toMatchObject({
      upgradeId: 901,
      expectedFinalTotal: "15.00",
      couponCode: "LATE",
    });
  });

  it("a STALE quote ERROR (superseded request resolving late) does not close the dialog or clobber the live quote", async () => {
    const { toast } = await import("sonner");
    render(React.createElement(NovelDetailPage));
    await openUpgradeDialog();

    // Request #1 issues, the input changes, request #2 issues and settles.
    fireEvent.change(couponInput(), { target: { value: "LATE" } });
    fireEvent.click(repriceButton());
    await settleQuote(1, QUOTE_WITH_COUPON);
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);

    // Request #1 now resolves with an error - a superseded flight. The
    // dialog must stay open on the live quote with NO error surfaced.
    await settleQuote(0, undefined, { message: "STALE_QUOTE" });
    expect(screen.getByText("อัปเกรดเป็นแพ็ก")).toBeTruthy();
    expect(couponRow()).not.toBeNull();
    expect((walletButton() as HTMLButtonElement).disabled).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("R8-3: the upgrade CTA is NOT rendered when the server reports the feature as disabled", async () => {
    (state.novelPayload as { packageUpgradeEnabled: boolean }).packageUpgradeEnabled = false;
    try {
      render(React.createElement(NovelDetailPage));
      // The page still renders normally...
      expect((await screen.findAllByText("นิยายทดสอบ")).length).toBeGreaterThan(0);
      // ...but the upgrade entry point must NOT exist at all.
      expect(screen.queryByRole("button", { name: "อัปเกรดจากบทที่ซื้อแล้ว" })).toBeNull();
      expect(state.quoteFlights).toHaveLength(0); // no quote was ever issued
    } finally {
      (state.novelPayload as { packageUpgradeEnabled: boolean }).packageUpgradeEnabled = true;
    }
  });
});
