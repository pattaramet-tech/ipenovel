// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Novel Detail chapter selling after a package split:
 *  - every published chapter row is listed;
 *  - a chapter unlocked through an owned package shows "ปลดล็อกผ่านแพ็ก"
 *    and a read button, and NEVER a buy button;
 *  - an unpurchased paid chapter shows its price and a buy button that
 *    calls reader.purchaseEpisode with that chapter;
 *  - the P3 upgrade entry point is still driven by owned chapters only.
 */

const state = vi.hoisted(() => {
  const purchaseCalls: Array<{ episodeId: number }> = [];
  const purchaseUseMutation = vi.fn(() => ({
    mutate: (input: { episodeId: number }) => {
      purchaseCalls.push(input);
    },
    isPending: false,
    mutateAsync: async () => undefined,
  }));
  const chapter = (id: number, n: number, extra: Record<string, unknown>) => ({
    id,
    novelId: 11,
    episodeNumber: String(n),
    title: `บทที่ ${n}`,
    saleMode: "chapter",
    price: "5.00",
    isFree: false,
    isPublished: true,
    isPurchased: false,
    hasPurchased: false,
    coveredByOwnedPackage: false,
    hasContent: true,
    hasLegacyFile: false,
    fileUrl: null,
    progressPercent: 0,
    ...extra,
  });
  return {
    purchaseCalls,
    purchaseUseMutation,
    novelPayload: {
      novel: { id: 11, title: "นิยายแบ่งบท", author: "ผู้เขียน", description: "x", slug: "s", coverImageUrl: null, publicationStatus: "published", storyStatus: "ongoing" },
      packageUpgradeEnabled: true,
    },
    chapter,
    episodesPayload: [
      chapter(601, 1, { coveredByOwnedPackage: true }),
      chapter(602, 2, {}),
    ] as Array<Record<string, unknown>>,
  };
});

const DEFAULT_EPISODES = [...state.episodesPayload];
const PACKAGE_ROW = {
  id: 900,
  novelId: 11,
  episodeNumber: "1 - 10",
  title: "แพ็ก 1-10",
  saleMode: "package",
  price: "30.00",
  isFree: false,
  isPublished: true,
  isPurchased: false,
  hasPurchased: false,
  hasPaidPurchase: false,
  hasContent: true,
  hasLegacyFile: false,
  fileUrl: null,
  progressPercent: 0,
};

vi.mock("@/lib/trpc", () => {
  const noop = () => {};
  return {
    trpc: {
      useUtils: () => ({
        novels: { episodes: { invalidate: noop } },
        cart: { get: { invalidate: noop } },
        wallet: { getSummary: { invalidate: noop } },
        myNovels: { list: { invalidate: noop } },
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
        packageUpgradeQuote: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
        packageUpgradeExecute: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
        purchaseEpisode: { useMutation: state.purchaseUseMutation },
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
vi.mock("@/contexts/LanguageContext", () => ({ useLanguage: () => ({ t: (k: string) => k, language: "th" }) }));
vi.mock("@/contexts/PublicThemeContext", () => ({ usePublicStorefrontPageThemeProps: () => ({}) }));
vi.mock("@/hooks/useDocumentHead", () => ({ useDocumentHead: () => {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import NovelDetailPage from "./NovelDetailPage";

(globalThis as unknown as { React: unknown }).React = React;

afterEach(() => {
  cleanup();
  state.purchaseCalls.length = 0;
  state.episodesPayload = [...DEFAULT_EPISODES];
});

const upgradeButton = () => screen.queryByRole("button", { name: "อัปเกรดจากบทที่ซื้อแล้ว" });

function chapterCard(label: string): HTMLElement {
  const title = screen.getByText(label, { selector: "p" });
  return title.closest("[data-slot='card']") as HTMLElement ?? (title.parentElement!.parentElement!.parentElement as HTMLElement);
}

describe("NovelDetail chapter selling after a package split", () => {
  it("lists every published chapter; covered chapters are readable and never offered for sale", async () => {
    render(React.createElement(NovelDetailPage));
    expect(await screen.findByText(/รายบท \(2\)/)).toBeTruthy();

    const covered = chapterCard("#1 บทที่ 1");
    expect(covered.textContent).toContain("ปลดล็อกผ่านแพ็ก");
    expect(covered.textContent).not.toContain("ซื้อบทนี้");
    expect(covered.querySelector("button")?.textContent).toContain("อ่าน");
  });

  it("an unpurchased paid chapter shows its price and the buy button purchases exactly that chapter", async () => {
    render(React.createElement(NovelDetailPage));
    await screen.findByText(/รายบท \(2\)/);
    const forSale = chapterCard("#2 บทที่ 2");
    expect(forSale.textContent).toContain("฿5.00");
    const buy = Array.from(forSale.querySelectorAll("button")).find((b) => b.textContent?.includes("ซื้อบทนี้"))!;
    fireEvent.click(buy);
    expect(state.purchaseCalls).toEqual([{ episodeId: 602 }]);
  });

  it("the P3 upgrade entry point stays driven by owned chapters only (a covered chapter is not a purchase)", async () => {
    render(React.createElement(NovelDetailPage));
    await screen.findByText(/รายบท \(2\)/);
    // No package row in this payload, and no chapter was actually purchased:
    // the upgrade CTA must not appear.
    expect(screen.queryByRole("button", { name: "อัปเกรดจากบทที่ซื้อแล้ว" })).toBeNull();
  });
});

describe("R5: the P3 upgrade entry point needs a PAID chapter purchase", () => {
  it("shows the upgrade button when the user paid for a chapter of the package", async () => {
    state.episodesPayload = [
      PACKAGE_ROW,
      state.chapter(602, 2, { isPurchased: true, hasPurchased: true, hasPaidPurchase: true }),
    ];
    render(React.createElement(NovelDetailPage));
    await screen.findByText(/รายบท \(1\)/);
    expect(upgradeButton()).not.toBeNull();
  });

  it("hides it when the only 'owned' chapters are free, gifted or package-covered", async () => {
    state.episodesPayload = [
      PACKAGE_ROW,
      state.chapter(601, 1, { isFree: true, price: "0.00" }),
      state.chapter(602, 2, { isPurchased: true, hasPurchased: true, hasPaidPurchase: false }), // admin gift
      state.chapter(603, 3, { coveredByOwnedPackage: true }),
    ];
    render(React.createElement(NovelDetailPage));
    await screen.findByText(/รายบท \(3\)/);
    expect(upgradeButton()).toBeNull();
  });
});
